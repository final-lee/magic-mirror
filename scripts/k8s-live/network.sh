#!/usr/bin/env bash
# K6 네트워크 픽스처. scripts/k8s-live-test.sh가 source로 부른다: 첫 인자는 kubeconfig 경로(없으면 $kc).
#   mm-net       : web Deployment, LoadBalancer Service(클라우드 컨트롤러가 없어 주소가 영영 pending), ClusterIP Service,
#                  그룹 이름이 붙은 Ingress, NetworkPolicy 둘(default-deny, allow-web)
#   mm-net-open  : NetworkPolicy가 하나도 없는 네임스페이스
kc="${1:-${kc:?kubeconfig 경로가 필요해요}}"
kubectl --kubeconfig "$kc" apply -f - <<'YAML'
apiVersion: v1
kind: Namespace
metadata: { name: mm-net }
---
apiVersion: v1
kind: Namespace
metadata: { name: mm-net-open }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: web, namespace: mm-net }
spec:
  replicas: 1
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec: { containers: [{ name: app, image: "registry.k8s.io/pause:3.10" }] }
---
apiVersion: v1
kind: Service
metadata: { name: lb-web, namespace: mm-net }
spec:
  type: LoadBalancer
  selector: { app: web }
  ports: [{ port: 80, protocol: TCP, targetPort: 80, name: http }, { port: 443, protocol: TCP, targetPort: 443, name: https }]
---
apiVersion: v1
kind: Service
metadata: { name: internal, namespace: mm-net }
spec:
  selector: { app: web }
  ports: [{ port: 8080 }]
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: site
  namespace: mm-net
  annotations: { alb.ingress.kubernetes.io/group.name: mm-group }
spec:
  ingressClassName: alb
  rules:
    - host: app.example.com
      http:
        paths:
          - { path: /, pathType: Prefix, backend: { service: { name: lb-web, port: { number: 80 } } } }
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: default-deny, namespace: mm-net }
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: allow-web, namespace: mm-net }
spec:
  podSelector: { matchLabels: { app: web } }
  ingress:
    - from:
        - podSelector: { matchLabels: { app: client } }
        - ipBlock: { cidr: 10.0.0.0/8, except: [10.9.0.0/16] }
      ports: [{ protocol: TCP, port: 80 }]
YAML
kubectl --kubeconfig "$kc" -n mm-net rollout status deployment/web --timeout=120s
