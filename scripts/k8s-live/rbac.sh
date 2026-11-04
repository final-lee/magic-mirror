#!/usr/bin/env bash
# 권한 변경(K8 D) 시험 픽스처: 시험이 바인딩을 만들고 고치고 지우는 네임스페이스와 처음부터 있는 바인딩 하나. k8s-live-test.sh가 source한다.
#   rbac_fixture <kubeconfig>
rbac_fixture() {
  local kc="$1"
  kubectl --kubeconfig "$kc" apply -f - <<'YAML'
apiVersion: v1
kind: Namespace
metadata: { name: mm-rbac }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: base, namespace: mm-rbac, labels: { team: mm } }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: view }
subjects:
- { apiGroup: rbac.authorization.k8s.io, kind: User, name: mm-rbac-alice }
YAML
}
