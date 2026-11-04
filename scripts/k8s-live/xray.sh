#!/usr/bin/env bash
# 관계 트리(xray) 픽스처. scripts/k8s-live-test.sh가 source로 부른다: 첫 인자는 kubeconfig 경로(없으면 $kc).
#   mm-xray : web Deployment(ServiceAccount web-sa, ConfigMap web-config를 볼륨으로, 없는 선택적 Secret absent-secret을 환경 변수로),
#             그 Pod를 고르는 Service web, Service를 대상으로 하는 Ingress web, Deployment를 대상으로 하는 HPA web
kc="${1:-${kc:?kubeconfig 경로가 필요해요}}"
kubectl --kubeconfig "$kc" apply -f - <<'YAML'
apiVersion: v1
kind: Namespace
metadata: { name: mm-xray }
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: web-sa, namespace: mm-xray }
---
apiVersion: v1
kind: ConfigMap
metadata: { name: web-config, namespace: mm-xray }
data: { mode: demo }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: web, namespace: mm-xray }
spec:
  replicas: 2
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      serviceAccountName: web-sa
      containers:
        - name: app
          image: "registry.k8s.io/pause:3.10"
          env:
            - name: OPTIONAL
              valueFrom: { secretKeyRef: { name: absent-secret, key: k, optional: true } }
          volumeMounts: [{ name: cfg, mountPath: /etc/web }]
      volumes: [{ name: cfg, configMap: { name: web-config } }]
---
apiVersion: v1
kind: Service
metadata: { name: web, namespace: mm-xray }
spec:
  selector: { app: web }
  ports: [{ port: 80, targetPort: 80 }]
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: web, namespace: mm-xray }
spec:
  rules:
    - host: web.example.com
      http: { paths: [{ path: /, pathType: Prefix, backend: { service: { name: web, port: { number: 80 } } } }] }
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: web, namespace: mm-xray }
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: web }
  minReplicas: 2
  maxReplicas: 3
  metrics: [{ type: Resource, resource: { name: cpu, target: { type: Utilization, averageUtilization: 80 } } }]
YAML
kubectl --kubeconfig "$kc" -n mm-xray rollout status deployment/web --timeout=120s
