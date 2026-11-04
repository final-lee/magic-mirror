#!/usr/bin/env bash
# 접근 화면(K4) 시험 픽스처: Role·ClusterRole(aggregationRule 포함)·바인딩·aws-auth를 만든다. k8s-live-test.sh가 source한다.
#   access_fixture <kubeconfig>
access_fixture() {
  local kc="$1"
  kubectl --kubeconfig "$kc" apply -f - <<'YAML'
apiVersion: v1
kind: Namespace
metadata: { name: mm-acc-a }
---
apiVersion: v1
kind: Namespace
metadata: { name: mm-acc-b }
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: robot, namespace: mm-acc-a }
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: plain, namespace: mm-acc-a }
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: worker, namespace: mm-acc-b }
---
# view에 합쳐지는 ClusterRole: 위젯 읽기
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: mm-acc-widgets
  labels: { rbac.authorization.k8s.io/aggregate-to-view: "true" }
rules:
  - { apiGroups: [mm.example.com], resources: [widgets], verbs: [get, list, watch] }
---
# 직접 만든 aggregation: 라벨이 mm-acc/agg=true인 ClusterRole을 합친다
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: mm-acc-agg }
aggregationRule:
  clusterRoleSelectors:
    - matchLabels: { mm-acc/agg: "true" }
rules: []
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: mm-acc-part1, labels: { mm-acc/agg: "true" } }
rules:
  - { apiGroups: [""], resources: [pods], verbs: [get, list] }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: mm-acc-part2, labels: { mm-acc/agg: "true" } }
rules:
  - { apiGroups: [""], resources: [configmaps, pods/log], verbs: [list, get] }
---
# 권한 상승 경로와 비리소스 URL
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: mm-acc-esc }
rules:
  - { apiGroups: [rbac.authorization.k8s.io], resources: [clusterroles, roles], verbs: [bind, escalate] }
  - { apiGroups: [""], resources: [users, groups], verbs: [impersonate] }
  - { apiGroups: [""], resources: [serviceaccounts/token], verbs: [create] }
  - { apiGroups: [""], resources: [nodes/proxy], verbs: [get] }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: mm-acc-nonres }
rules:
  - { nonResourceURLs: ["/healthz*", "/version"], verbs: [get] }
---
# 하위 리소스 모양: 접미사 `*/log`만 하위 리소스에 맞고 `pods/*`와 `pods`는 맞지 않는다
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: mm-acc-subs }
rules:
  - { apiGroups: [""], resources: ["*/status"], verbs: [get] }
  - { apiGroups: [""], resources: ["pods/*"], verbs: [delete] }
  - { apiGroups: [""], resources: [pods], verbs: [create] }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: mm-acc-names, namespace: mm-acc-a }
rules:
  - { apiGroups: [""], resources: [configmaps], resourceNames: [cm1], verbs: [get] }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: mm-acc-exec, namespace: mm-acc-b }
rules:
  - { apiGroups: [""], resources: [pods/exec, pods/attach], verbs: [create] }
---
# 클러스터 전체
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: mm-acc-alice }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: mm-acc-agg }
subjects: [{ apiGroup: rbac.authorization.k8s.io, kind: User, name: mm-acc-alice }]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: mm-acc-devs-view }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: view }
subjects: [{ apiGroup: rbac.authorization.k8s.io, kind: Group, name: mm-acc-devs }]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: mm-acc-carol }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: mm-acc-nonres }
subjects:
  - { apiGroup: rbac.authorization.k8s.io, kind: User, name: mm-acc-carol }
  - { apiGroup: rbac.authorization.k8s.io, kind: User, name: system:anonymous }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: mm-acc-carol-view }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: view }
subjects: [{ apiGroup: rbac.authorization.k8s.io, kind: User, name: mm-acc-carol }]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: mm-acc-subs }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: mm-acc-subs }
subjects: [{ apiGroup: rbac.authorization.k8s.io, kind: User, name: mm-acc-dave }]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: mm-acc-esc }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: mm-acc-esc }
subjects:
  - { apiGroup: rbac.authorization.k8s.io, kind: Group, name: mm-acc-esc-group }
  - { apiGroup: rbac.authorization.k8s.io, kind: User, name: "mm-acc-ops:jane" }
---
# 네임스페이스 범위
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: mm-acc-bob, namespace: mm-acc-a }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: mm-acc-names }
subjects: [{ apiGroup: rbac.authorization.k8s.io, kind: User, name: mm-acc-bob }]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: mm-acc-robot-edit, namespace: mm-acc-a }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: edit }
subjects: [{ kind: ServiceAccount, name: robot, namespace: mm-acc-a }]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: mm-acc-devs-exec, namespace: mm-acc-b }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: mm-acc-exec }
subjects: [{ apiGroup: rbac.authorization.k8s.io, kind: Group, name: mm-acc-devs }]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: mm-acc-b-sas, namespace: mm-acc-b }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: admin }
subjects: [{ apiGroup: rbac.authorization.k8s.io, kind: Group, name: "system:serviceaccounts:mm-acc-b" }]
---
# 없는 역할을 가리키는 바인딩
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: mm-acc-dangling }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: mm-acc-gone }
subjects: [{ apiGroup: rbac.authorization.k8s.io, kind: User, name: mm-acc-ghost }]
---
# kind에는 aws-auth가 없다. EKS의 것과 같은 모양으로 만든다(템플릿과 system:masters 포함)
apiVersion: v1
kind: ConfigMap
metadata: { name: aws-auth, namespace: kube-system }
data:
  mapRoles: |
    - rolearn: arn:aws:iam::111122223333:role/mm-ops
      username: "mm-acc-ops:{{SessionName}}"
      groups: [mm-acc-devs, mm-acc-esc-group]
    - rolearn: arn:aws:iam::111122223333:role/mm-boss
      username: boss
      groups: ["system:masters"]
YAML
  # 컨트롤러가 aggregation을 채울 때까지 기다린다(mm-acc-agg와 view의 위젯 규칙)
  local i
  for i in $(seq 1 60); do
    if [ "$(kubectl --kubeconfig "$kc" get clusterrole mm-acc-agg -o json | jq '.rules | length')" -ge 2 ] \
      && kubectl --kubeconfig "$kc" get clusterrole view -o json | jq -e '[.rules[] | select(.resources // [] | index("widgets"))] | length > 0' >/dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "aggregation이 채워지지 않았어요" >&2
  return 1
}
