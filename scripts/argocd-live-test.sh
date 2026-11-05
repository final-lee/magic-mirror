#!/usr/bin/env bash
# 실제 ArgoCD 서버와 개인 테스트 클러스터에 붙는 시험. 토큰은 출력하지 않는다.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "사용법: scripts/argocd-live-test.sh <argocd-url>" >&2
  exit 1
fi
export ARGOCD_LIVE_URL="$1"
if [ -z "${ARGOCD_LIVE_TOKEN:-}" ]; then
  ARGOCD_LIVE_TOKEN=$(security find-generic-password -s magic-mirror.argocd -a "${ARGOCD_LIVE_URL%/}" -w)
fi
export ARGOCD_LIVE_TOKEN
printf '%s\n' '주의: default 프로젝트에 mm-live-<초> Application을 만들고 podinfo(kustomize)를 in-cluster의 mm-live-argocd 네임스페이스에 동기화합니다.' 'Deployment 재시작·패치 후 앱과 관리 리소스를 cascade 삭제합니다. CreateNamespace로 만든 네임스페이스는 남을 수 있습니다.' 'ARGOCD_LIVE_KUBE_CONTEXT를 주면 그 context로 ArgoCD 지표(service proxy)와 Pod 사용량(metrics-server)을 읽기만 합니다.'
cargo test --manifest-path src-tauri/Cargo.toml --lib argocd::live_tests -- --ignored --test-threads=1 --nocapture
