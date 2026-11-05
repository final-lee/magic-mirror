#!/usr/bin/env bash
# Valkey 8을 Docker로 띄우고 KV 탭의 읽기를 진짜 서버에 시험한다(`kv::live_tests`, 모두 #[ignore]).
# 띄우는 것: (1) 인증 없는 서버 + 모든 값 종류와 BullMQ 모양의 자료, (2) requirepass + ACL 사용자(비밀번호·nopass·권한 제한),
# (3) TLS 서버(이 실행이 openssl로 만든 시험용 CA), (4) 3샤드 클러스터(컨테이너 하나에 서버 셋).
# 자료는 이 스크립트가 valkey-cli로 심는다(앱 코드는 아무것도 쓰지 않는다). 성공하든 실패하든(Ctrl-C 포함) 끝날 때 이 실행의 컨테이너와 임시 파일을 지운다.
#
# 필요한 것: 켜져 있는 Docker, 이미지 valkey/valkey:8(없으면 받는다), openssl.
# 쓰는 포트: 127.0.0.1의 56379(일반), 56380(인증), 56381(TLS), 57001-57003(클러스터, 버스 포트는 +1000).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tag="$$"
image="valkey/valkey:8"
names=("magic-mirror-kv-live-plain-$tag" "magic-mirror-kv-live-auth-$tag" "magic-mirror-kv-live-tls-$tag" "magic-mirror-kv-live-cluster-$tag")
certs="$(mktemp -d)"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker가 켜져 있어야 해요." >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl이 필요해요." >&2
  exit 1
fi

cleanup() {
  docker rm -fv "${names[@]}" >/dev/null 2>&1 || true
  rm -rf "$certs"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}
for port in 56379 56380 56381 57001 57002 57003 58001 58002 58003; do
  if port_in_use "$port"; then
    echo "포트 $port 를 이미 쓰고 있어요. 다른 live 시험이 돌고 있거나 이전 실행이 남긴 컨테이너일 수 있어요(docker ps --filter name=magic-mirror-kv-live)." >&2
    exit 1
  fi
done

# 시험용 CA와 서버 인증서(이름 localhost). 비밀 키는 임시 폴더에만 있고 끝나면 지운다
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=magic-mirror-kv-test-ca" -keyout "$certs/ca.key" -out "$certs/ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" -keyout "$certs/server.key" -out "$certs/server.csr" >/dev/null 2>&1
printf 'subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n' >"$certs/ext.cnf"
openssl x509 -req -in "$certs/server.csr" -CA "$certs/ca.crt" -CAkey "$certs/ca.key" -CAcreateserial -days 1 -extfile "$certs/ext.cnf" -out "$certs/server.crt" >/dev/null 2>&1
chmod 644 "$certs"/*

cli() { # cli <컨테이너> <valkey-cli 인자…>
  local name=$1; shift
  docker exec -i "$name" valkey-cli "$@"
}
wait_ready() { # wait_ready <컨테이너> <valkey-cli 인자…>
  local name=$1; shift
  for _ in $(seq 1 60); do
    if docker exec "$name" valkey-cli "$@" ping 2>/dev/null | grep -q PONG; then return 0; fi
    sleep 0.5
  done
  echo "$name 가 준비되지 않았어요." >&2
  docker logs "$name" >&2 || true
  exit 1
}

# 시험을 먼저 빌드한다: events 스트림은 지금 시각 기준으로 심으므로, 심은 뒤 빌드에 시간이 걸리면 1분 창 시험이 어긋난다
echo "시험을 빌드해요…"
(cd "$root/src-tauri" && cargo test --lib --no-run -q)

echo "서버를 띄워요…"
docker run -d --name "${names[0]}" -p 127.0.0.1:56379:6379 "$image" >/dev/null
docker run -d --name "${names[1]}" -p 127.0.0.1:56380:6379 "$image" valkey-server --requirepass rootpass >/dev/null
docker run -d --name "${names[2]}" -p 127.0.0.1:56381:6379 -v "$certs:/certs:ro" "$image" \
  valkey-server --port 0 --tls-port 6379 --tls-cert-file /certs/server.crt --tls-key-file /certs/server.key --tls-ca-cert-file /certs/ca.crt --tls-auth-clients no >/dev/null
docker run -d --name "${names[3]}" -p 127.0.0.1:57001:57001 -p 127.0.0.1:57002:57002 -p 127.0.0.1:57003:57003 \
  -p 127.0.0.1:58001:58001 -p 127.0.0.1:58002:58002 -p 127.0.0.1:58003:58003 "$image" sh -c '
    for p in 57001 57002 57003; do
      valkey-server --port $p --cluster-enabled yes --cluster-config-file /tmp/nodes-$p.conf --cluster-announce-ip 127.0.0.1 --cluster-announce-port $p --cluster-announce-bus-port $((p + 1000)) --cluster-port $((p + 1000)) &
    done
    wait' >/dev/null

wait_ready "${names[0]}"
wait_ready "${names[1]}" -a rootpass
wait_ready "${names[3]}" -p 57001
wait_ready "${names[3]}" -p 57002
wait_ready "${names[3]}" -p 57003

# TLS 서버는 평문 포트가 없어서 cli도 TLS로 붙는다
tls_cli() { docker exec -i "${names[2]}" valkey-cli --tls --cacert /certs/ca.crt "$@"; }
for _ in $(seq 1 60); do tls_cli -h localhost ping 2>/dev/null | grep -q PONG && break; sleep 0.5; done
tls_cli -h localhost ping | grep -q PONG || { echo "TLS 서버가 준비되지 않았어요(이 이미지가 TLS로 빌드됐는지 확인하세요)." >&2; docker logs "${names[2]}" >&2; exit 1; }

echo "자료를 심어요…"
now=$(( $(date +%s) * 1000 ))
{
  echo "SET str hello"
  for i in 1 2 3; do echo "HSET h:$i name user$i age $((20 + i))"; done
  echo "RPUSH lst a b c d"
  echo "SADD st x y z"
  echo "ZADD zs 1 one 2 two 3 three"
  echo "XADD strm 1700000000000-0 field value"
  echo "XADD strm 1700000000001-0 field value2"
  for i in $(seq 1 700); do echo "HSET bighash f$i v$i"; done
  # BullMQ 모양: 일시정지된 큐 emails(meta.version이 있다), 대기 2, 완료 3, 실패 1, 지연 1
  echo "HSET bull:emails:meta version bullmq:5.12.0 paused 1"
  echo "SET bull:emails:id 5"
  echo "LPUSH bull:emails:wait 1 2"
  echo "HSET bull:emails:1 name welcome data '{\"to\":\"a@x\"}' timestamp $((now - 5000)) atm 0"
  echo "HSET bull:emails:2 name welcome data '{\"to\":\"b@x\"}' timestamp $((now - 1000)) atm 0"
  for i in 11 12 13; do
    echo "HSET bull:emails:$i name receipt data '{\"to\":\"c@x\"}' timestamp $((now - 90000)) processedOn $((now - 89000)) finishedOn $((now - 88000 + i)) atm 1 returnvalue \"ok\""
    echo "ZADD bull:emails:completed $((now - 88000 + i)) $i"
  done
  echo "HSET bull:emails:21 name receipt data '{\"to\":\"d@x\"}' timestamp $((now - 60000)) processedOn $((now - 59000)) finishedOn $((now - 58000)) atm 3 failedReason \"SMTP timeout\" stacktrace '[\"Error: SMTP timeout\"]'"
  echo "ZADD bull:emails:failed $((now - 58000)) 21"
  echo "HSET bull:emails:31 name reminder data '{}' timestamp $now delay 3600000"
  echo "ZADD bull:emails:delayed $(( (now + 3600000) * 4096 + 1 )) 31"
  echo "RPUSH bull:emails:31:logs started"
  # 오래된 Bull 모양: meta가 없고 completed가 셋이다
  echo "SET bull:legacy:id 3"
  echo "LPUSH bull:legacy:wait 1"
  echo "HSET bull:legacy:1 name old timestamp $now"
  echo "SADD bull:legacy:completed 2"
  # Bull 3 모양(OptimalBits/bull의 moveToFinished): meta가 없고 completed·failed가 끝난 시각 점수의 정렬 셋이다
  echo "SET bull:bull3:id 3"
  echo "HSET bull:bull3:2 name done timestamp $((now - 9000)) processedOn $((now - 8000)) finishedOn $((now - 7000))"
  echo "ZADD bull:bull3:completed $((now - 7000)) 2"
  echo "HSET bull:bull3:3 name broken timestamp $((now - 6000)) processedOn $((now - 5000)) finishedOn $((now - 4000)) failedReason boom"
  echo "ZADD bull:bull3:failed $((now - 4000)) 3"
  # BullMQ 흐름: orders 큐의 부모 p1(자식 기다림)과 fulfil 큐의 자식 c1(대기)·c2(처리됨)·c3(실패)·c4(무시됨)
  echo "HSET bull:orders:meta version bullmq:5.12.0"
  echo "HSET bull:fulfil:meta version bullmq:5.12.0"
  echo "HSET bull:orders:p1 name order timestamp $((now - 400000))"
  echo "ZADD bull:orders:waiting-children $((now - 400000)) p1"
  echo "SADD bull:orders:p1:dependencies bull:fulfil:c1"
  echo "HSET bull:orders:p1:processed bull:fulfil:c2 '\"packed\"'"
  echo "HSET bull:orders:p1:failed bull:fulfil:c3 'no stock'"
  echo "ZADD bull:orders:p1:unsuccessful 1 bull:fulfil:c4"
  for c in c1 c2 c3 c4; do
    echo "HSET bull:fulfil:$c name pack timestamp $((now - 390000)) parentKey bull:orders:p1 parent '{\"id\":\"p1\",\"queueKey\":\"bull:orders\"}'"
  done
  echo "LPUSH bull:fulfil:wait c1"
  echo "ZADD bull:fulfil:completed $((now - 290000)) c2"
  echo "ZADD bull:fulfil:failed $((now - 280000)) c3"
  echo "HSET bull:fulfil:c3 failedReason 'no stock'"
  # fulfil 큐의 events 스트림: added, active(prev waiting) 2, completed·failed(prev active), stalled, retries-exhausted
  echo "XADD bull:fulfil:events $((now - 600000))-0 event added jobId c1 name pack"
  echo "XADD bull:fulfil:events $((now - 300000))-0 event active jobId c1 prev waiting"
  echo "XADD bull:fulfil:events $((now - 299000))-0 event active jobId c2 prev waiting"
  echo "XADD bull:fulfil:events $((now - 290000))-0 event completed jobId c2 prev active returnvalue packed"
  echo "XADD bull:fulfil:events $((now - 280000))-0 event failed jobId c3 prev active failedReason 'no stock'"
  echo "XADD bull:fulfil:events $((now - 5000))-0 event stalled jobId c1"
  echo "XADD bull:fulfil:events $((now - 3000))-0 event retries-exhausted jobId c3 attemptsMade 3"
  echo "SLOWLOG RESET"
} | cli "${names[0]}" >/dev/null
# 바이트 이름의 키(UTF-8이 아니다)
docker exec "${names[0]}" sh -c 'printf "SET bin\377key v\r\n" | valkey-cli' >/dev/null


# 워커 연결 하나(fulfil 큐의 packer): 이름만 붙이고 열어 둔다. 컨테이너가 지워지면 같이 끝난다
worker_name="bull:$(printf fulfil | base64):w:packer"
(docker exec -i "${names[0]}" sh -c "(printf 'CLIENT SETNAME $worker_name\\r\\n'; sleep 300) | valkey-cli >/dev/null" >/dev/null 2>&1 &)
sleep 1

# 인증 서버: 기본 사용자는 requirepass, ACL 사용자는 읽기 전용(+연결에 필요한 명령)
cli "${names[1]}" -a rootpass SET str hello >/dev/null 2>&1
cli "${names[1]}" -a rootpass ACL SETUSER reader on '>readpw' '~*' '+@read' +ping +info +select +client >/dev/null 2>&1
cli "${names[1]}" -a rootpass ACL SETUSER guest on nopass '~*' '+@read' +ping +info +select +client >/dev/null 2>&1
cli "${names[1]}" -a rootpass ACL SETUSER limited on '>limitedpw' '~*' +get +ping +info +select +client >/dev/null 2>&1

# 클러스터: 세 기본 노드, 키 300개
docker exec "${names[3]}" valkey-cli --cluster create 127.0.0.1:57001 127.0.0.1:57002 127.0.0.1:57003 --cluster-replicas 0 --cluster-yes >/dev/null
for _ in $(seq 1 60); do
  docker exec "${names[3]}" valkey-cli -p 57001 cluster info | grep -q 'cluster_state:ok' && break
  sleep 0.5
done
for i in $(seq 1 300); do echo "SET ck:$i v$i"; done | docker exec -i "${names[3]}" valkey-cli -c -p 57001 >/dev/null

echo "시험을 돌려요…"
cd "$root/src-tauri"
KV_LIVE_PLAIN=56379 KV_LIVE_AUTH=56380 KV_LIVE_TLS=56381 KV_LIVE_CA="$certs/ca.crt" KV_LIVE_CLUSTER=57001 \
  cargo test --lib kv::live_tests -- --ignored --test-threads=1 "$@"
