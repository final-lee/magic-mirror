#!/usr/bin/env bash
# Helm 시험 픽스처(k8s-live-test.sh가 source한다). 작은 로컬 차트를 만들어 helm으로 릴리스를 설치하고,
# 로컬 차트 저장소(http)를 띄운다. 앱의 Helm 읽기·변경 시험(k8s::live_tests::helm)이 이 릴리스와 차트를 쓴다.
#   helm_fixture <kubeconfig> <작업 폴더>   → HELM_CHART_DIR, HELM_REPO_URL을 정한다
#   helm_fixture_stop                      → 저장소 서버를 끈다
# 릴리스: flow(리비전 둘: 설치 + 업그레이드), broken(서버가 거절해 failed), cmrel(ConfigMap 드라이버)

HELM_REPO_PID=""

helm_fixture() {
  local kc=$1 work=$2 ctx chart port
  ctx=$(kubectl --kubeconfig "$kc" config current-context)
  chart="$work/mmdemo"
  mkdir -p "$chart/templates"
  cat > "$chart/Chart.yaml" <<'YAML'
apiVersion: v2
name: mmdemo
description: Magic Mirror helm live test chart
type: application
version: 0.1.0
appVersion: "1.0"
YAML
  cat > "$chart/values.yaml" <<'YAML'
replicaCount: 1
message: hello
image: registry.k8s.io/pause:3.10
YAML
  cat > "$chart/templates/configmap.yaml" <<'YAML'
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ .Release.Name }}-config
data:
  message: {{ .Values.message | quote }}
YAML
  cat > "$chart/templates/deployment.yaml" <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}-web
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels: {app: {{ .Release.Name }}}
  template:
    metadata:
      labels: {app: {{ .Release.Name }}}
    spec:
      containers:
        - name: pause
          image: {{ .Values.image }}
YAML
  # broken=true면 문자열 칸에 숫자를 넣어 서버가 거절한다(helm이 failed 릴리스를 남긴다)
  cat > "$chart/templates/broken.yaml" <<'YAML'
{{- if .Values.broken }}
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ .Release.Name }}-broken
data:
  x: 1
{{- end }}
YAML
  printf 'Installed {{ .Release.Name }}\n' > "$chart/templates/NOTES.txt"

  local h=(helm --kubeconfig "$kc" --kube-context "$ctx")
  "${h[@]}" install flow "$chart" -n mm-helm --create-namespace --set message=hi
  "${h[@]}" upgrade flow "$chart" -n mm-helm --reset-values --set message=hello --set replicaCount=2
  "${h[@]}" install broken "$chart" -n mm-helm --set broken=true || true
  HELM_DRIVER=configmap "${h[@]}" install cmrel "$chart" -n mm-helm-cm --create-namespace

  # 로컬 차트 저장소: 패키지한 차트를 http로 낸다(차트 저장소 ref로 설치하는 시험용)
  mkdir -p "$work/repo"
  helm package "$chart" -d "$work/repo" >/dev/null
  port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
  HELM_REPO_URL="http://127.0.0.1:$port"
  helm repo index "$work/repo" --url "$HELM_REPO_URL"
  python3 -m http.server "$port" --bind 127.0.0.1 --directory "$work/repo" >/dev/null 2>&1 &
  HELM_REPO_PID=$!
  HELM_CHART_DIR="$chart"
  for _ in $(seq 1 20); do curl -fs "$HELM_REPO_URL/index.yaml" >/dev/null && break; sleep 0.25; done
}

helm_fixture_stop() {
  [ -n "$HELM_REPO_PID" ] && kill "$HELM_REPO_PID" 2>/dev/null || true
  HELM_REPO_PID=""
}
