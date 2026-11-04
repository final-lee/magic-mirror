#!/usr/bin/env bash
# kind 클러스터(컨트롤 플레인 + 워커) 두 버전을 띄우고 EKS 탭의 #[ignore] 시험(k8s::live_tests)을 돌린다. 평소 cargo test에서는 건너뛴다.
#   scripts/k8s-live-test.sh            # 기본 이미지 둘
#   KIND_IMAGES="kindest/node:v1.33.1" scripts/k8s-live-test.sh
# 필요: docker, kind, kubectl, yq, jq, helm (brew install kind kubernetes-cli yq jq helm)
set -euo pipefail
cd "$(dirname "$0")/.."
for tool in docker kind kubectl yq jq helm; do
  command -v "$tool" >/dev/null || { echo "$tool이 없어요: brew install $tool" >&2; exit 1; }
done
IMAGES=${KIND_IMAGES:-"kindest/node:v1.33.1 kindest/node:v1.35.0"}
WORK=$(mktemp -d)
source scripts/k8s-live/helm.sh
cleanup() { helm_fixture_stop; for c in $(kind get clusters 2>/dev/null | grep '^mm-live-' || true); do kind delete cluster --name "$c" >/dev/null 2>&1 || true; done; rm -rf "$WORK"; }
trap cleanup EXIT
for image in $IMAGES; do
  name="mm-live-$(echo "${image##*:}" | tr '.' '-')"
  kc="$WORK/$name.yaml"
  # 컨트롤 플레인 하나와 워커 하나: drain 시험이 워커를 비운다(컨트롤 플레인에는 taint가 남아 일반 Pod는 워커로 간다)
  printf 'kind: Cluster\napiVersion: kind.x-k8s.io/v1alpha4\nnodes:\n  - role: control-plane\n  - role: worker\n' > "$WORK/kind.yaml"
  kind create cluster --name "$name" --image "$image" --config "$WORK/kind.yaml" --kubeconfig "$kc" --wait 120s
  kubectl --kubeconfig "$kc" wait --for=condition=Ready node --all --timeout=120s

  # 권한이 제한된 ServiceAccount: mm-live 네임스페이스의 pods를 get/list/watch만 할 수 있다
  kubectl --kubeconfig "$kc" create namespace mm-live
  kubectl --kubeconfig "$kc" -n mm-live create serviceaccount reader
  kubectl --kubeconfig "$kc" -n mm-live create role pod-reader --verb=get,list,watch --resource=pods
  kubectl --kubeconfig "$kc" -n mm-live create rolebinding reader-pods --role=pod-reader --serviceaccount=mm-live:reader
  reader_token=$(kubectl --kubeconfig "$kc" -n mm-live create token reader --duration=1h)

  # K2 픽스처: 준비되는 Deployment, 이미지를 받지 못하는 Pod, kubectl apply로 만든 Secret(last-applied에 값이 남는다), CRD와 그 객체
  kubectl --kubeconfig "$kc" apply -f - <<'YAML'
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata: { name: widgets.mm.example.com }
spec:
  group: mm.example.com
  scope: Namespaced
  names: { plural: widgets, singular: widget, kind: Widget }
  versions:
    - name: v1
      served: true
      storage: true
      schema: { openAPIV3Schema: { type: object, x-kubernetes-preserve-unknown-fields: true } }
YAML
  kubectl --kubeconfig "$kc" wait --for condition=established --timeout=60s crd/widgets.mm.example.com
  kubectl --kubeconfig "$kc" apply -f - <<'YAML'
apiVersion: v1
kind: Namespace
metadata: { name: mm-k2 }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: web, namespace: mm-k2 }
spec:
  replicas: 1
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec: { containers: [{ name: app, image: "registry.k8s.io/pause:3.10" }] }
---
apiVersion: v1
kind: Pod
metadata: { name: broken, namespace: mm-k2 }
spec: { containers: [{ name: app, image: "registry.invalid/mm/nope:1" }] }
---
apiVersion: v1
kind: Secret
metadata: { name: db, namespace: mm-k2 }
stringData: { password: hunter2 }
---
apiVersion: mm.example.com/v1
kind: Widget
metadata: { name: w1, namespace: mm-k2 }
YAML
  kubectl --kubeconfig "$kc" -n mm-k2 rollout status deployment/web --timeout=120s

  # K4 접근 시험 픽스처(RBAC·aws-auth)
  source scripts/k8s-live/access.sh
  access_fixture "$kc"
  # K8 D 권한 변경 픽스처(바인딩 변경 시험용 네임스페이스)
  source scripts/k8s-live/rbac.sh
  rbac_fixture "$kc"
  # K6 네트워크 픽스처: LoadBalancer Service, 그룹 Ingress, NetworkPolicy, 정책 없는 네임스페이스
  source scripts/k8s-live/network.sh "$kc"
  # K5 보안 점검 픽스처: 점검마다 걸리는 워크로드와 RBAC
  source scripts/k8s-live/security.sh "$kc"

  # exec 플러그인 시험용: kind의 클라이언트 인증서를 ExecCredential로 내보내는 가짜 플러그인, SSO 만료를 흉내 내는 플러그인,
  # 평소엔 바로 답하다가 slow.armed 파일이 생기면 40초 멈추는 플러그인(watch가 멈춘 목록을 알리는지 보는 시험)
  cert=$(yq '.users[0].user.client-certificate-data' "$kc" | base64 -d)
  key=$(yq '.users[0].user.client-key-data' "$kc" | base64 -d)
  mkdir -p "$WORK/bin"
  jq -n --arg c "$cert" --arg k "$key" '{apiVersion:"client.authentication.k8s.io/v1beta1",kind:"ExecCredential",status:{clientCertificateData:$c,clientKeyData:$k}}' > "$WORK/cred.json"
  jq -n --arg t "$reader_token" '{apiVersion:"client.authentication.k8s.io/v1beta1",kind:"ExecCredential",status:{token:$t,expirationTimestamp:((now-3600)|todate)}}' > "$WORK/slow-cred.json"
  printf '#!/bin/sh\ncat %q\n' "$WORK/cred.json" > "$WORK/bin/fake-get-token"
  printf '#!/bin/sh\necho "Error when retrieving token from sso: Token has expired and refresh failed" >&2\nexit 255\n' > "$WORK/bin/expired-get-token"
  printf '#!/bin/sh\nif [ -f %q ]; then sleep 40; fi\ncat %q\n' "$WORK/slow.armed" "$WORK/slow-cred.json" > "$WORK/bin/slow-get-token"
  chmod +x "$WORK/bin/"*

  # Helm 픽스처: 로컬 차트로 helm이 설치한 릴리스와 로컬 차트 저장소(scripts/k8s-live/helm.sh)
  helm_fixture "$kc" "$WORK"

  K8S_LIVE_KUBECONFIG="$kc" K8S_LIVE_BIN="$WORK/bin" K8S_LIVE_SLOW_ARM="$WORK/slow.armed" K8S_LIVE_READER_TOKEN="$reader_token" \
    K8S_LIVE_HELM_CHART="$HELM_CHART_DIR" K8S_LIVE_HELM_REPO="$HELM_REPO_URL" \
    cargo test --manifest-path src-tauri/Cargo.toml --lib k8s::live_tests -- --ignored --test-threads=1
  helm_fixture_stop

  # 사용량 시험: metrics-server를 설치해(kind의 kubelet 인증서는 자체 서명이라 --kubelet-insecure-tls) 사용량을 읽는 시험만 다시 돌린다.
  # 설치하지 못하면(오프라인 등) 이 부분만 건너뛴다. 첫 판의 metrics_without_server 시험은 설치 전 클러스터에서 이미 돌았다.
  if kubectl --kubeconfig "$kc" apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml \
    && kubectl --kubeconfig "$kc" -n kube-system patch deployment metrics-server --type=json \
      -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]' \
    && kubectl --kubeconfig "$kc" wait --for=condition=Available apiservice/v1beta1.metrics.k8s.io --timeout=240s; then
    K8S_LIVE_METRICS=1 K8S_LIVE_KUBECONFIG="$kc" K8S_LIVE_BIN="$WORK/bin" K8S_LIVE_SLOW_ARM="$WORK/slow.armed" K8S_LIVE_READER_TOKEN="$reader_token" \
      cargo test --manifest-path src-tauri/Cargo.toml --lib k8s::live_tests::metrics_with_server -- --ignored --test-threads=1
  else
    echo "metrics-server를 설치하지 못해 사용량 시험(metrics_with_server)을 건너뛰어요" >&2
  fi
  kind delete cluster --name "$name" >/dev/null 2>&1 || true
done
