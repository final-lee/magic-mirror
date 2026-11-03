#!/usr/bin/env bash
# K5 보안 점검 픽스처. scripts/k8s-live-test.sh가 source로 부른다: 첫 인자는 kubeconfig 경로(없으면 $kc).
#   mm-sec         : 점검마다 하나씩 걸리는 워크로드(priv, host, root, esc, bare, cron, job)와 하나도 걸리지 않는 clean,
#                    default ServiceAccount를 쓰는 워크로드(NetworkPolicy 없음), 권한 점검용 RBAC(관리자·상승 경로·익명·안 쓰는 역할·깨진 바인딩)
#   mm-sec-bound   : default ServiceAccount에 다른 권한(view)을 준 네임스페이스(자동 수정을 하지 않는다)
#   mm-sec-guarded : NetworkPolicy가 있는 네임스페이스(NetworkPolicy 점검에 걸리지 않는다)
#   mm-sec-fix     : 고치기 시험이 실제로 적용하는 객체(fix-esc, fix-cron, default ServiceAccount). 다른 시험이 읽는 객체와 섞이지 않게 따로 둔다
# 이미지는 받을 수 없는 이름(registry.invalid)이어도 된다: 점검은 Pod가 아니라 컨트롤러의 템플릿을 읽는다.
kc="${1:-${kc:?kubeconfig 경로가 필요해요}}"
kubectl --kubeconfig "$kc" apply -f - <<'YAML'
apiVersion: v1
kind: Namespace
metadata: { name: mm-sec }
---
apiVersion: v1
kind: Namespace
metadata: { name: mm-sec-bound }
---
apiVersion: v1
kind: Namespace
metadata: { name: mm-sec-guarded }
---
apiVersion: v1
kind: Namespace
metadata: { name: mm-sec-fix }
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: app, namespace: mm-sec }
automountServiceAccountToken: false
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: runner, namespace: mm-sec }
---
# privileged
apiVersion: apps/v1
kind: Deployment
metadata: { name: priv, namespace: mm-sec }
spec:
  replicas: 1
  selector: { matchLabels: { app: priv } }
  template:
    metadata: { labels: { app: priv } }
    spec:
      containers:
        - name: app
          image: registry.k8s.io/pause:3.10
          securityContext: { privileged: true, runAsNonRoot: false }
---
# hostNetwork · hostPID · hostPath(노드 루트는 위험, /tmp는 보통)
apiVersion: apps/v1
kind: Deployment
metadata: { name: host, namespace: mm-sec }
spec:
  replicas: 1
  selector: { matchLabels: { app: host } }
  template:
    metadata: { labels: { app: host } }
    spec:
      hostNetwork: true
      hostPID: true
      containers:
        - name: app
          image: registry.k8s.io/pause:3.10
          volumeMounts:
            - { name: root, mountPath: /host, readOnly: true }
            - { name: scratch, mountPath: /scratch }
      volumes:
        - { name: root, hostPath: { path: / } }
        - { name: scratch, hostPath: { path: /tmp/mm-sec, type: DirectoryOrCreate } }
---
# root(UID 0)로 실행. allowPrivilegeEscalation은 꺼 둬서 다른 점검과 섞이지 않게 한다
apiVersion: apps/v1
kind: Deployment
metadata: { name: root, namespace: mm-sec }
spec:
  replicas: 1
  selector: { matchLabels: { app: root } }
  template:
    metadata: { labels: { app: root } }
    spec:
      containers:
        - name: app
          image: registry.k8s.io/pause:3.10
          securityContext: { runAsUser: 0, allowPrivilegeEscalation: false }
---
# allowPrivilegeEscalation 미지정(자동 수정 대상). init 컨테이너도 같다
apiVersion: apps/v1
kind: Deployment
metadata: { name: esc, namespace: mm-sec }
spec:
  replicas: 1
  selector: { matchLabels: { app: esc } }
  template:
    metadata: { labels: { app: esc } }
    spec:
      initContainers:
        - name: init
          image: registry.k8s.io/pause:3.10
          command: ["/pause", "-v"]
          securityContext: { runAsNonRoot: true, runAsUser: 1000 }
      containers:
        - name: app
          image: registry.k8s.io/pause:3.10
          securityContext: { runAsNonRoot: true, runAsUser: 1000 }
        - name: side
          image: registry.k8s.io/pause:3.10
          securityContext: { runAsNonRoot: true, runAsUser: 1000, allowPrivilegeEscalation: false }
---
# 태그 없는 이미지, latest 이미지, request·limit 없음, probe 없음
apiVersion: apps/v1
kind: Deployment
metadata: { name: bare, namespace: mm-sec }
spec:
  replicas: 0
  selector: { matchLabels: { app: bare } }
  template:
    metadata: { labels: { app: bare } }
    spec:
      containers:
        - { name: untagged, image: registry.invalid/mm/app }
        - { name: latest, image: "registry.invalid/mm/app:latest" }
---
# CronJob의 allowPrivilegeEscalation(Job 템플릿 안에서 고친다)
apiVersion: batch/v1
kind: CronJob
metadata: { name: cron, namespace: mm-sec }
spec:
  schedule: "0 0 1 1 *"
  suspend: true
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: Never
          containers:
            - { name: app, image: "registry.k8s.io/pause:3.10", securityContext: { runAsNonRoot: true, runAsUser: 1000 } }
---
# 컨트롤러가 없는 Job: 점검하지만 템플릿을 바꿀 수 없어 고치지 않는다(컨트롤러 없는 Pod는 drain 시험이 쫓아내서 두지 않는다)
apiVersion: batch/v1
kind: Job
metadata: { name: job, namespace: mm-sec }
spec:
  suspend: true
  template:
    spec:
      restartPolicy: Never
      containers:
        - { name: app, image: "registry.k8s.io/pause:3.10", securityContext: { runAsNonRoot: true, runAsUser: 1000 } }
---
# 점검에 하나도 걸리지 않는 워크로드(default가 아닌 ServiceAccount, 모든 설정이 되어 있다)
apiVersion: apps/v1
kind: Deployment
metadata: { name: clean, namespace: mm-sec }
spec:
  replicas: 1
  selector: { matchLabels: { app: clean } }
  template:
    metadata: { labels: { app: clean } }
    spec:
      serviceAccountName: app
      containers:
        - name: app
          image: registry.k8s.io/pause:3.10
          securityContext: { runAsNonRoot: true, runAsUser: 1000, allowPrivilegeEscalation: false }
          resources: { requests: { cpu: 10m, memory: 16Mi }, limits: { cpu: 100m, memory: 64Mi } }
          readinessProbe: { tcpSocket: { port: 8080 }, initialDelaySeconds: 3600 }
          livenessProbe: { tcpSocket: { port: 8080 }, initialDelaySeconds: 3600 }
---
# default ServiceAccount를 쓰는 워크로드(토큰 자동 마운트). mm-sec에는 NetworkPolicy가 없다
apiVersion: apps/v1
kind: Deployment
metadata: { name: uses-default, namespace: mm-sec-bound }
spec:
  replicas: 0
  selector: { matchLabels: { app: uses-default } }
  template:
    metadata: { labels: { app: uses-default } }
    spec:
      containers:
        - name: app
          image: registry.k8s.io/pause:3.10
          securityContext: { runAsNonRoot: true, runAsUser: 1000, allowPrivilegeEscalation: false }
          resources: { requests: { cpu: 10m, memory: 16Mi }, limits: { cpu: 100m, memory: 64Mi } }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: guarded, namespace: mm-sec-guarded }
spec:
  replicas: 0
  selector: { matchLabels: { app: guarded } }
  template:
    metadata: { labels: { app: guarded } }
    spec:
      serviceAccountName: default
      automountServiceAccountToken: false
      containers:
        - name: app
          image: registry.k8s.io/pause:3.10
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: default-deny, namespace: mm-sec-guarded }
spec:
  podSelector: {}
  policyTypes: [Ingress]
---
# 고치기 시험이 적용하는 객체: esc·cron과 같은 모양
apiVersion: apps/v1
kind: Deployment
metadata: { name: fix-esc, namespace: mm-sec-fix }
spec:
  replicas: 1
  selector: { matchLabels: { app: fix-esc } }
  template:
    metadata: { labels: { app: fix-esc } }
    spec:
      initContainers:
        - name: init
          image: registry.k8s.io/pause:3.10
          command: ["/pause", "-v"]
          securityContext: { runAsNonRoot: true, runAsUser: 1000 }
      containers:
        - name: app
          image: registry.k8s.io/pause:3.10
          securityContext: { runAsNonRoot: true, runAsUser: 1000 }
        - name: side
          image: registry.k8s.io/pause:3.10
          securityContext: { runAsNonRoot: true, runAsUser: 1000, allowPrivilegeEscalation: false }
---
apiVersion: batch/v1
kind: CronJob
metadata: { name: fix-cron, namespace: mm-sec-fix }
spec:
  schedule: "0 0 1 1 *"
  suspend: true
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: Never
          containers:
            - { name: app, image: "registry.k8s.io/pause:3.10", securityContext: { runAsNonRoot: true, runAsUser: 1000 } }
---
# ── 권한 ──
# 모든 권한: 사용자(클러스터 전체), 네임스페이스 안에서만(RoleBinding으로 묶은 cluster-admin), 강한 ServiceAccount
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: mm-sec-alice }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: cluster-admin }
subjects: [{ apiGroup: rbac.authorization.k8s.io, kind: User, name: mm-sec-alice }]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: mm-sec-bob, namespace: mm-sec }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: cluster-admin }
subjects: [{ apiGroup: rbac.authorization.k8s.io, kind: User, name: mm-sec-bob }]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: mm-sec-runner }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: cluster-admin }
subjects: [{ kind: ServiceAccount, name: runner, namespace: mm-sec }]
---
# 권한 상승 경로 넷(bind, impersonate, nodes/proxy, 모든 Secret 읽기)
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: mm-sec-esc }
rules:
  - { apiGroups: [rbac.authorization.k8s.io], resources: [clusterroles], verbs: [bind] }
  - { apiGroups: [""], resources: [users], verbs: [impersonate] }
  - { apiGroups: [""], resources: [nodes/proxy], verbs: [get] }
  - { apiGroups: [""], resources: [secrets], verbs: [get, list] }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: mm-sec-carol }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: mm-sec-esc }
subjects: [{ apiGroup: rbac.authorization.k8s.io, kind: User, name: mm-sec-carol }]
---
# Pod를 만들 수 있는 사용자(강한 ServiceAccount runner가 같은 네임스페이스에 있다)와 읽기만 하는 사용자
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: mm-sec-dave, namespace: mm-sec }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: edit }
subjects: [{ apiGroup: rbac.authorization.k8s.io, kind: User, name: mm-sec-dave }]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: mm-sec-erin, namespace: mm-sec }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: view }
subjects: [{ apiGroup: rbac.authorization.k8s.io, kind: User, name: mm-sec-erin }]
---
# 익명·인증된 모든 주체에게 준 권한
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: mm-sec-peek }
rules:
  - { apiGroups: [""], resources: [configmaps], verbs: [get, list] }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: mm-sec-peek-anon }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: mm-sec-peek }
subjects: [{ apiGroup: rbac.authorization.k8s.io, kind: Group, name: "system:unauthenticated" }]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: mm-sec-everyone, namespace: mm-sec }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: view }
subjects: [{ apiGroup: rbac.authorization.k8s.io, kind: Group, name: "system:authenticated" }]
---
# 쓰이지 않는 역할
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: mm-sec-unused }
rules:
  - { apiGroups: [""], resources: [pods], verbs: [get] }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: unused-role, namespace: mm-sec }
rules:
  - { apiGroups: [""], resources: [pods], verbs: [get] }
---
# default ServiceAccount에 다른 권한을 준 네임스페이스
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: mm-sec-default-view, namespace: mm-sec-bound }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: view }
subjects: [{ kind: ServiceAccount, name: default, namespace: mm-sec-bound }]
YAML
# 없는 역할·없는 ServiceAccount를 가리키는 바인딩(cluster-admin은 bind 권한이 있어 역할이 없어도 만들 수 있다)
kubectl --kubeconfig "$kc" apply -f - <<'YAML'
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: ghost-role, namespace: mm-sec }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: gone }
subjects: [{ apiGroup: rbac.authorization.k8s.io, kind: User, name: mm-sec-ghost }]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: mm-sec-ghost-cluster }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: mm-sec-gone }
subjects: [{ apiGroup: rbac.authorization.k8s.io, kind: User, name: mm-sec-ghost }]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: ghost-sa, namespace: mm-sec }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: view }
subjects: [{ kind: ServiceAccount, name: ghost, namespace: mm-sec }]
YAML
# default ServiceAccount는 네임스페이스를 만든 직후 컨트롤러가 만든다
for ns in mm-sec mm-sec-bound mm-sec-guarded mm-sec-fix; do
  for _ in $(seq 1 30); do kubectl --kubeconfig "$kc" -n "$ns" get serviceaccount default >/dev/null 2>&1 && break; sleep 1; done
done
