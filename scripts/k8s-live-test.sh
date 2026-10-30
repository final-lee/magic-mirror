#!/usr/bin/env bash
# kind 클러스터 두 버전을 띄우고 EKS 탭의 #[ignore] 시험(k8s::live_tests)을 돌린다. 평소 cargo test에서는 건너뛴다.
#   scripts/k8s-live-test.sh            # 기본 이미지 둘
#   KIND_IMAGES="kindest/node:v1.33.1" scripts/k8s-live-test.sh
# 필요: docker, kind, kubectl, yq, jq (brew install kind kubernetes-cli yq jq)
set -euo pipefail
cd "$(dirname "$0")/.."
for tool in docker kind kubectl yq jq; do
  command -v "$tool" >/dev/null || { echo "$tool이 없어요: brew install $tool" >&2; exit 1; }
done
IMAGES=${KIND_IMAGES:-"kindest/node:v1.33.1 kindest/node:v1.35.0"}
WORK=$(mktemp -d)
cleanup() { for c in $(kind get clusters 2>/dev/null | grep '^mm-live-' || true); do kind delete cluster --name "$c" >/dev/null 2>&1 || true; done; rm -rf "$WORK"; }
trap cleanup EXIT
for image in $IMAGES; do
  name="mm-live-$(echo "${image##*:}" | tr '.' '-')"
  kc="$WORK/$name.yaml"
  kind create cluster --name "$name" --image "$image" --kubeconfig "$kc" --wait 120s

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

  K8S_LIVE_KUBECONFIG="$kc" K8S_LIVE_BIN="$WORK/bin" K8S_LIVE_SLOW_ARM="$WORK/slow.armed" K8S_LIVE_READER_TOKEN="$reader_token" \
    cargo test --manifest-path src-tauri/Cargo.toml --lib k8s::live_tests -- --ignored --test-threads=1
  kind delete cluster --name "$name" >/dev/null 2>&1 || true
done
