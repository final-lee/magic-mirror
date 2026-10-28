#!/usr/bin/env bash
# PostgreSQL 14·16을 Docker로 띄우고 카탈로그 읽기를 진짜 서버에 시험한다(`pg::live_tests`, 모두 #[ignore]).
# 성공하든 실패하든(Ctrl-C 포함) 끝날 때 컨테이너와 그 익명 볼륨을 지운다.
#
# 필요한 것: 켜져 있는 Docker, 이미지 postgres:14·postgres:16(없으면 받는다).
# 쓰는 포트: 55414(14), 55416(16). 시험은 superuser(postgres)로 붙어 시험마다 새 데이터베이스를 만든다.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
containers=(magic-mirror-pg-live-14 magic-mirror-pg-live-16)

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker가 켜져 있어야 해요." >&2
  exit 1
fi

remove_containers() {
  # 없는 컨테이너를 지우려는 오류는 무시한다. -v는 이미지가 만든 익명 볼륨까지 지운다
  docker rm -fv "${containers[@]}" >/dev/null 2>&1 || true
}
trap remove_containers EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

wait_until_ready() {
  local name=$1 tries=0
  # 처음 띄울 때 이미지는 소켓으로만 듣는 임시 서버로 초기화한 뒤 다시 시작한다. TCP로 확인해야 진짜 서버를 기다린다
  until docker exec "$name" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -ge 60 ]; then
      echo "$name 이(가) 60초 안에 준비되지 않았어요:" >&2
      docker logs "$name" 2>&1 | tail -20 >&2
      return 1
    fi
    sleep 1
  done
}

# 컨테이너가 뜨기를 기다리는 동안 컴파일이 돌지 않도록 시험 파일을 먼저 만든다
(cd "$root/src-tauri" && cargo test pg::live_tests --no-run)

# 지난 실행이 남긴 컨테이너가 있으면 포트가 겹치니 먼저 지운다
remove_containers

for image in postgres:14 postgres:16; do
  docker image inspect "$image" >/dev/null 2>&1 || docker pull --quiet "$image" >/dev/null
done
docker run -d --name "${containers[0]}" -e POSTGRES_PASSWORD=live -p 55414:5432 postgres:14 >/dev/null
docker run -d --name "${containers[1]}" -e POSTGRES_PASSWORD=live -p 55416:5432 postgres:16 >/dev/null
wait_until_ready "${containers[0]}"
wait_until_ready "${containers[1]}"

cd "$root/src-tauri"
MM_PG_LIVE_14=postgres://postgres:live@127.0.0.1:55414/postgres \
MM_PG_LIVE_16=postgres://postgres:live@127.0.0.1:55416/postgres \
  cargo test pg::live_tests -- --ignored --test-threads=1
