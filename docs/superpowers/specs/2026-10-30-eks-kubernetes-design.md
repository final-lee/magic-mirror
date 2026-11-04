# EKS 쿠버네티스 관리: 설계

## 목표
- EKS 클러스터를 더블클릭하면 `☸️` 탭 하나에서 클러스터를 보고, 고치고, 들어갈 수 있다.
- 터미널의 `kubectl`과 같은 신원(kubeconfig)으로 접속한다.
- 읽기: 개요, 워크로드, 이벤트, YAML, 로그, 네트워크, 접근(IAM ↔ RBAC ↔ IRSA), 보안 점검.
- 변경: 워크로드 조작, 노드 조작, 셸과 port-forward, 권한 변경(RBAC, access entry), YAML 편집과 적용. 모든 변경은 미리보기 → 확인 → 적용 → 기록을 거친다(셸은 열 때 확인).
- 차별점: AWS IAM 주체에서 쿠버네티스 권한까지, ServiceAccount에서 AWS 권한까지 한 화면에서 끝까지 따라간다.

## 범위 밖
- SSM 터널이나 bastion을 앱이 직접 여는 것. 엔드포인트에는 맥에서 바로 닿아야 한다(퍼블릭, 또는 Tailscale·VPN).
- 앱이 직접 토큰을 만드는 접속. kubeconfig의 exec 플러그인만 쓴다.
- EKS 밖의 쿠버네티스 클러스터(kubeconfig에 있어도 열지 않는다).
- NetworkPolicy가 실제로 막는 트래픽 계산, 웹훅 authorizer 평가.
- 클러스터·노드그룹·애드온 생성, 삭제, 업그레이드(AWS 쪽 인프라 변경).
- 디버그용 ephemeral 컨테이너, 셸 입력 기록. (Helm 릴리스 관리는 2026-11-03에 범위에 넣었다: 아래 "Helm")
- 비용 분석.

## 단계
릴리스는 모든 단계가 끝난 뒤 한 번 낸다. 각 단계는 설계의 해당 절을 범위로 계획 → 구현 → 리뷰를 따로 거친다. 모든 단계가 K1 위에서 돈다.

| 단계 | 범위 |
|---|---|
| K1 | 탭, 연결(kubeconfig·exec·SSO·오류 분류), 신원 표시, 권한 미리 계산, watch 기반 목록 갱신 틀 |
| K2 | 개요, 워크로드 목록·상세·소유 관계, 이벤트, YAML 보기, Secret 값 보기 |
| K3 | 로그 |
| K4 | 접근: 신원 연결, RBAC 실효 권한, 권한 표, 누가 할 수 있나, 워크로드 신원(IRSA·Pod Identity) |
| K5 | 보안 점검 |
| K6 | 네트워크 |
| K7 | 변경 공통 틀(미리보기·재확인·기록·되돌리기), A 워크로드 조작, B 노드 조작 |
| K8 | D 권한 변경(RBAC 장바구니, access entry), E YAML 편집과 적용 |
| K9 | C 셸과 port-forward |
| KR | 전체 리뷰, 수정, 릴리스 |

### 진행 예정: Lens·k9s 대비 빈 기능 (2026-11-02 정리)
지금 된 것은 K1·K2와 K3 일부(Pod 로그)다. Lens·k9s의 주요 기능 중 없는 것:
1. 클러스터를 바꾸는 조작: Pod 셸(exec)·port-forward(K9), scale·rollout restart·rollout undo·삭제(K7 A), cordon·uncordon·drain(K7 B), YAML 편집·적용·새로 만들기(K8 E). 컨테이너 attach와 노드 셸(디버그 Pod)은 C 절에 들어왔고(2026-11-02) 구현했다. CronJob 바로 실행은 K7 A의 Job 재실행에 포함, 일시정지는 K7 A.
2. 로그: (2026-11-03 구현함) 워크로드 합친 로그(Pod별 색, 새 Pod 따라 붙기)·since(최근 N분)·파일 저장, 모든 컨테이너 한꺼번에, 서버 타임스탬프·줄바꿈 토글.
3. 리소스 사용량: (2026-11-03 구현함) Pod·컨테이너 CPU/메모리 열(metrics-server), request·limit 대비 %, 워크로드·네임스페이스 집계, 사용량 그래프(Prometheus 없이 앱이 metrics-server 값을 모은다). 아래 "사용량(metrics-server)"과 "사용량 그래프" 참고.
4. 내장 종류 트리: (2026-11-03 구현함) HPA, PDB, ResourceQuota, LimitRange, PriorityClass, RuntimeClass, Lease, Mutating·ValidatingWebhookConfiguration, EndpointSlice, IngressClass, Role·ClusterRole·RoleBinding·ClusterRoleBinding, CustomResourceDefinition 자체. API discovery로 제공 버전만 표시하고 목록·상세 요약과 북마크를 지원한다.
5. 탐색: 키보드 중심 조작(명령 팔레트, `:종류` 이동), `kubectl describe` 형식 출력, xray식 관계 트리, 앱 안 터미널(kubectl), 플러그인.
6. Helm: (2026-11-03 구현함) 릴리스 목록·values·이력·manifest·리소스 연결, 업그레이드(values 편집, 다른 차트)·롤백·삭제, 차트 설치(로컬 경로·저장소·OCI). 아래 "Helm" 참고.
7. 점검·권한: popeye식 위생 점검(K5), RBAC 역조회(K4).

우선순위(매일 쓰는 빈도): ① 셸·port-forward·restart·scale·삭제 ② Pod CPU/메모리 열 ③ 트리에 내장 종류 추가 ④ 로그 K3 나머지 ⑤ Helm 읽기 전용.

### 탐색
- 객체 상세의 describe 탭은 세션에서 고른 kubeconfig와 context로 로컬 `kubectl describe`만 실행한다. 로그인 PATH에서 실행 파일을 찾고 다른 클러스터로 새지 않도록 환경을 정리하며, 30초와 출력 4 MiB로 제한한다. 프로세스 실행 허용 목록에는 이 전용 러너만 추가하고 하위 명령을 외부에서 받지 않는다.
- 실행하지 못하면 이유와 앱이 이미 읽은 요약·조건·컨테이너·이벤트를 대신 보인다. 수동 새로고침과 resourceVersion 변경 시 다시 읽기를 지원한다.
- Secret은 서비스 계정 토큰이나 last-applied 값이 노출될 수 있어 kubectl 결과를 쓰지 않는다. 앱에서 가린 요약과 키·크기만 보여주고 이유를 표시한다.
- 관계 트리(xray, 2026-11-04): 객체 상세의 "관계" 탭. 백엔드 `k8s/xray/`(`pool` 읽어 온 객체 더미, `refs` 본문에서 가리키는 곳 읽기, `graph` 트리 계산, `read` 읽기)와 읽기 전용 명령 `k8s_xray`, 프론트 `src/k8s/xray/`. 읽을 수 있는 목록만으로 계산한다: 네임스페이스 객체는 그 네임스페이스의 Pod·ReplicaSet·Deployment·StatefulSet·DaemonSet·Job·CronJob·Service·EndpointSlice·Ingress·NetworkPolicy·HPA·PDB·PVC와 메타데이터만 읽은 ConfigMap·Secret·ServiceAccount(Secret 값은 받지 않는다), 클러스터 범위 객체(Node·PV·StorageClass·PriorityClass)는 모든 네임스페이스의 Pod·워크로드·PVC·PV를 읽는다(Node는 `spec.nodeName`으로 좁힌다). Pod가 가리키는 Node·PV·StorageClass·PriorityClass는 이름으로 읽고(참조를 따라 최대 4단계), 읽은 결과가 없으면 그 종류를 끝까지 읽었을 때만 "없음"으로 보인다.
  - 네 묶음(노드마다 `edge`): **소유**(소유자 사슬을 위로, 자식을 아래로: Deployment → ReplicaSet → Pod, CronJob → Job → Pod), **참조**(Pod 사양·템플릿의 ServiceAccount·볼륨·환경 변수·imagePullSecrets·PriorityClass·Node, PVC → PV → StorageClass, Ingress TLS Secret, 그리고 거꾸로 ConfigMap·Secret·PVC·PV·StorageClass·Node 등을 쓰는 객체: 소유자도 쓰면 가장 위 소유자만), **선택**(Service·PDB·NetworkPolicy가 Pod 레이블을 고름: `matchLabels`·`matchExpressions` 모두, Service 셀렉터는 라벨 맵, 빈 셀렉터는 Service는 아무것도, PDB·NetworkPolicy는 모두 고른다. 선택자를 가진 객체에서는 고른 Pod), **대상**(Ingress → Service, HPA `scaleTargetRef` ↔ 워크로드, EndpointSlice ↔ Service·Pod, Service 아래 Ingress·EndpointSlice).
  - 노드마다 종류 참조(group·version·kind), 네임스페이스, 이름, 상태 글(목록 줄과 같은 값), 이상 표시(목록과 같은 `problems`), 관계 모습(`roles`: 볼륨·환경 변수·사용 중 …), `presence`(찾음·없음·알 수 없음). 노드를 누르면 소유자·자식 링크와 같은 길(`onOpen`)로 그 객체 상세가 열린다.
  - 한도: 트리 전체 300노드, 한 부모 아래 50개(참조는 종류마다 50개). 넘으면 응답의 `truncated`가 참이고 화면이 알린다. 목록이 쪽 수 한도(6쪽)에서 멈춘 종류는 `partial`로 알리고 "없음"으로 단정하지 않는다. 권한이 없거나(403) 읽지 못한 종류는 실패가 아니라 `gaps`(종류와 오류)로 돌려주고 나머지 관계는 그대로 보인다. 객체 자신을 읽지 못할 때만 명령이 실패한다.
  - 탭은 관계를 계산하는 내장 종류(Pod·워크로드·Service·EndpointSlice·Ingress·NetworkPolicy·HPA·PDB·ConfigMap·Secret·ServiceAccount·PVC·PV·StorageClass·Node·PriorityClass)와, 상세가 이미 소유자나 자식을 가진 객체(사용자 정의 리소스 등)에 있다. 객체의 resourceVersion이 바뀌면 다시 읽고(목록 밖 객체는 30초), [다시 읽기] 단추가 있다.
- 플러그인 설정은 `k8sPlugins`에 이름·설명·종류(`*` 또는 kind 참조)·명령·확인 여부·선택 단축키를 저장한다. 예전 설정은 빈 목록이고, 확인 여부를 생략한 항목은 확인을 기본으로 한다.
- 설정 화면에서 추가·편집·삭제한다. 단축키는 한 글자 또는 수식 키와 한 글자로 적고 고정 키 표 및 다른 플러그인과의 충돌을 거절한다.
- 명령의 `$NAMESPACE`, `$NAME`, `$CONTEXT`, `$KIND`, `$CONTAINER` 값은 셸 단일 인자로 인용한다. kubeconfig 축소는 선택한 context와 그 cluster·user만 남기며 선택한 context를 현재 context로 설정한다.
- 안전하게 치환할 수 있도록 변수는 독립된 단어 또는 일반 따옴표 안에만 둔다. 명령 치환, 백틱, 중괄호 변수, 달러 따옴표, here 문서 등은 저장과 실행 때 거절한다. 따옴표 안의 변수도 따옴표를 잠시 닫아 단일 인자로 인용한다.
- 지금 된 것(2026-11-04, 앱 안 터미널·플러그인 실행):
  - PTY 크레이트 `portable-pty`(0.9): 표준 `Command`는 제어 터미널·창 크기(SIGWINCH)를 다루지 못해 셸이 대화형으로 동작하지 않는다. 쓰는 것은 PTY 열기·크기 변경·자식 종료뿐이고, `CommandBuilder::new`·`spawn_command`는 `k8s/terminal/pty.rs`에만 있게 hygiene 허용 목록에 올렸다(그 셸에서 `kubectl`이 클러스터를 바꿀 수 있어서 kube 쓰기 호출과 같은 취급).
  - 고정: 탭이 연결한 context 하나만 남긴 임시 kubeconfig(`mm-kubeconfig-*.yaml`, 0600, 현재 context 설정)를 `KUBECONFIG`로 주고, 부모의 `KUBECONFIG`·`KUBE*`·`HELM_KUBE*`는 치운다. kubeconfig의 exec 플러그인이 쓰는 AWS 프로필이 있으면 `AWS_PROFILE`로 준다. PATH는 로그인 셸 PATH. 대화형 셸은 `$SHELL`(없으면 `/bin/zsh`)을 `-l`로 연다. 사용자의 rc 파일이 `KUBECONFIG`를 다시 내보내면 고정이 풀릴 수 있다.
  - 수명: 세션은 셸·attach와 같은 `Shells`가 쥔다(입력·크기·닫기는 `k8s_shell_*` 그대로, 열기는 `k8s_terminal_open`). 닫기·탭 닫기(`k8s_close`)·앱 끄기에서 프로세스를 죽이고 임시 파일을 지운다(`cleanup`을 `settle`이 기다린다). 열고 닫은 시각은 변경 기록에 `terminal` 한 줄(대상 이름이 context, 플러그인이면 명령)로 남고 입력·출력은 남기지 않는다.
  - 화면: 왼쪽 메뉴 "터미널"(명령 `k8s.terminal`), 머리줄에 고정한 context, 안쪽 탭으로 여러 터미널, 다른 화면을 봐도 유지(숨기기만), xterm 설정은 `PodTerminal`과 공유(`terminal/xterm.ts`), ⌘⎋로 빠져나온다.
  - 플러그인 실행: 상세 도구 줄 "플러그인" 메뉴에서 확장한 명령을 그대로 보이는 확인 창(확인을 끈 플러그인은 바로)을 거쳐 새 터미널 탭에서 실행한다. 확인한 문자열은 POSIX 인용 규칙에 맞게 `/bin/sh -c <명령>`의 인자 하나로 넘긴다. 재연결이나 화면 재마운트에도 명령은 다시 실행하지 않고 종료된 탭을 보인다. `$KIND`는 `복수형.그룹`, `$CONTAINER`는 Pod의 첫 컨테이너다. 플러그인 단축키는 단축키 보기와 명령 팔레트에도 표시한다.
  - 시험: Rust 환경·argv·임시 파일·수명(대상 닫기, 종료, 기록 실패)·실제 PTY, kind 시험 `k8s::live_tests::terminal`, 프런트 탭·플러그인 확인·키·K8sTab 연결.
  - 강제 종료 뒤 남은 이 사용자의 임시 kubeconfig는 앱 시작 때 정리한다. 재연결로 셸 세션이 닫히면 화면에 종료 상태를 알린다.


## 대상과 탭
- **EKS → Clusters** 행을 더블클릭하면 `☸️ <클러스터 이름>` 탭이 열린다. 이것이 유일한 진입점이고, 사이드바에 별도 메뉴(클러스터 선택 화면)는 두지 않는다.
- 대상은 `{ profile, region, cluster }`. 같은 대상의 탭은 하나만 열린다.
- 탭을 닫으면 그 탭의 watch, 로그 스트림, 셸, port-forward, 연결을 모두 정리한다.
- 하위 화면: 개요, 워크로드, 로그, 접근, 보안 점검, 네트워크, 셸, 포트포워딩, Helm, 변경 기록.
- 상단 막대: kubeconfig context 이름, 클러스터에서 보이는 신원, 네임스페이스 선택(전체 포함), "YAML로 만들기".

## 접속
1. kubeconfig 경로: 앱 설정의 경로 → `KUBECONFIG`(콜론으로 여러 파일) → `~/.kube/config`.
2. `DescribeCluster`로 ARN과 엔드포인트를 얻고, context를 찾는다.
   - 클러스터 이름이 ARN과 같거나, `cluster.server`가 엔드포인트와 같은 context.
   - 여러 개면 고르게 하고, 고른 것은 설정(`Settings.k8sContexts`: 클러스터 ARN → context 이름)에 저장한다.
   - 없으면 `aws eks update-kubeconfig --name <name> --region <region> --profile <profile>`을 복사 버튼과 함께 보여준다.
3. `kube-rs`의 `Config::from_custom_kubeconfig`로 그 context를 읽는다. exec 플러그인은 `kube-rs`가 실행한다.
   - macOS 앱은 셸의 PATH를 물려받지 않는다. 앱이 처음 접속할 때 로그인 셸(`$SHELL -lc 'printf %s "$PATH"'`)로 PATH를 한 번 읽어 exec 플러그인 환경에 넣는다. 실패하면 `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`.
   - TLS는 기존 rustls(aws-lc-rs)를 쓴다.
4. 오류 분류(문구는 구현 계획의 전역 제약에 고정한다)
   - exec 실패이고 출력에 SSO 만료 신호(`Token has expired`, `The SSO session associated with this profile has expired` 등): exec의 `--profile` 인자나 `AWS_PROFILE` 환경변수에서 프로필을 찾아 기존 자동 SSO 로그인을 돌리고 한 번 다시 시도한다. 프로필을 못 찾으면 명령을 안내한다.
   - exec 실패, 실행 파일 없음: `aws` CLI 설치와 PATH 안내.
   - 연결 시간 초과·거부이고 프라이빗 엔드포인트만 열려 있음: "Tailscale 연결을 확인해 주세요". 퍼블릭이면 허용 CIDR 안내.
   - 401: 이 신원이 클러스터에 매핑되지 않음(access entry나 aws-auth 안내).
   - 403: 화면별로 "이 정보를 볼 권한이 없어요"와 필요한 권한.
5. 연결되면
   - `SelfSubjectReview`로 사용자 이름, 그룹, extra(`arn`)를 얻는다. 1.28 미만이면 exec 인자로 대신하고 그렇게 표시한다.
   - exec가 쓰는 프로필과 앱에서 고른 프로필이 다르면 상단에 표시한다.
   - 네임스페이스마다 `SelfSubjectRulesReview`를 처음 쓸 때 받아 두고, 버튼을 미리 비활성화한다. 결과가 불완전(`incomplete`)하면 버튼은 켜 두고 서버 판단에 맡긴다.
6. 갱신: 화면에 보이는 리소스 종류만 watch(`kube::runtime::watcher`)로 받는다. 화면을 떠나면 30초 뒤 멈춘다. 처음 목록은 페이지(`limit`, `continue`)로 받는다.

## 읽기 화면

### 개요
- 클러스터 사용량(2026-11-03, Lens 개요처럼 맨 위): 노드 수와 Ready·NotReady·스케줄 중지·압박 개수 칩, CPU·메모리·Pod 고리 카드(할당 가능량 대비 사용량·요청·제한을 바깥부터 겹친 고리로, 범례에 값·비율과 할당 가능량·용량). 사용량은 15초마다 다시 읽은 노드 사용량 합(읽을 수 없으면 개요를 읽을 때의 값), 요청·제한은 끝나지 않은 Pod의 합(kubectl describe node와 같은 셈, 제한 없는 컨테이너는 0), 용량은 status.capacity. Pod 고리는 놓인 Pod 수 / 할당 가능 Pod 수. 아래에 앱이 모은 노드 사용량 합의 최근 1시간 CPU·메모리 그래프(요청 합·할당 가능 합 기준선).
- 최근 경고: 클러스터 전체 이벤트를 감시해 최근 Warning 8개(시각·이유·대상·메시지)와 이벤트 화면으로 가는 단추.
- 탐색기 상세(2026-11-03): AWS 탐색기에서 EKS 클러스터를 고르면 오른쪽 상세의 기본 값 아래에 위 클러스터 사용량(칩·고리·1시간 그래프)과 최근 경고를 같이 보인다(`ClusterDetailSummary`). EKS 탭과 같은 연결 과정(`useK8sConnection`)과 쿼리를 나눠 쓰고, 상세를 보는 동안 그래프 기록을 모은다. context를 아직 고르지 않았으면 연결하지 않고 EKS 탭으로 안내한다. 오른쪽 상세의 단추는 본문에 두지 않고 모두 제목 줄 오른쪽 위 도구 모음에 모은다("EKS 탭에서 열기", "AWS 콘솔에서 열기", "원본 데이터 보기", 닫기 순서, EKS 상세의 도구 줄과 같은 24px 크기).
- 오른쪽 상세 너비: 앱의 모든 오른쪽 상세는 비율로 연다. 탐색기·VPC 지도·IAM 작업 목록의 상세는 고른 것이 있을 때만 본문 위에 떠서 오른쪽부터 70%를 덮고(✕로 닫는다), EKS·ArgoCD 4열 상세는 저장한 비율(기본 70%)을 쓴다. 어느 쪽도 최소 px 너비를 두지 않는다.
- 클러스터: 버전, 플랫폼 버전, 엔드포인트 공개 범위와 허용 CIDR, 컨트롤 플레인 로깅, Secret 암호화, OIDC 공급자, 인증 모드.
- 노드: 상태(Ready, cordon, 압박 조건), 인스턴스 타입, AZ, 노드그룹(관리형, Fargate, Karpenter NodePool, 자체 관리), kubelet 버전, 할당 가능량 대비 요청량. metrics-server가 있으면 사용량. 노드 목록의 %CPU·%MEM 칸과 노드 상세 요약에도 Pod와 같은 사용량 그래프(할당 가능량 기준)를 둔다.
- 애드온: 현재 버전, 클러스터 버전에 맞는 최신 버전, 상태와 문제.
- 업그레이드 점검: EKS Upgrade Insights 결과, 다음 마이너 버전에서 제거되는 API를 쓰는 리소스(고정 표), 노드와 컨트롤 플레인의 버전 차이.

### 워크로드 (메뉴 이름 "All")
- 화면 열 이름(사용자와 합의): **1열 메뉴**(북마크·개요·All·이벤트·내 권한, `K8sNav`), **2열 종류**(리소스 종류 트리, `KindTree`), **3열 목록**(고른 종류의 객체 목록, `ObjectList`), **4열 상세**(객체 요약·YAML, `ObjectDetail`). 번호는 역할에 붙인다: 북마크 화면은 2열이 없고, 상세를 열기 전에는 4열이 없다. 개요·이벤트·내 권한은 "1열 + 본문".
- 트리: 워크로드(Deployment, StatefulSet, DaemonSet, ReplicaSet, Job, CronJob, Pod), 네트워크(Service, Ingress, NetworkPolicy, Endpoints), 설정(ConfigMap, Secret, ServiceAccount), 저장소(PVC, PV, StorageClass), 네임스페이스, CRD(API discovery로 나열).
- 북마크: 트리의 종류마다 별(☆/★)로 북마크한다. 북마크는 왼쪽 메뉴의 개요 위에 북마크한 순서대로 붙고, 끌어서 순서를 바꾸며 ✕로 뺀다. 누르면 그 종류의 목록만(트리 없이) 연다. 설정(`k8sBookmarks`)에 저장하고 모든 클러스터에 같이 쓴다. 이 클러스터에 없는 사용자 정의 종류는 흐리게 두고 열지 않는다.
- 1열·2열 오른쪽 경계를 끌어 너비(px)를 바꾼다. 놓을 때 설정(`k8sLaneWidths.nav`, `.tree`)에 저장한다.
- 3열에서 행을 누르면 4열이 열리고, 열린 행을 다시 누르면 닫힌다(더블클릭·Enter는 늘 연다).
- 4열은 3열 위에 떠서 오른쪽부터 3열 너비의 70%를 덮는다. 왼쪽 경계를 끌어 30~95%로 바꾸고 `k8sLaneWidths.detailPct`에 저장한다.
- 목록: 종류별 핵심 열, 이상 표시(CrashLoopBackOff, ImagePullBackOff, Pending, OOMKilled, 준비 안 됨), 이름·레이블 셀렉터 필터, "문제 있는 것만".
- 상세: 요약, 소유 관계(ownerReferences 위아래 이동), 컨테이너별 상태와 마지막 종료 이유, 관련 이벤트, YAML 탭(테마 색으로 구문 강조), Pod·Deployment·StatefulSet·DaemonSet·ReplicaSet·Job·Service는 로그 탭. 머리의 뒤로(‹)·닫기(✕)는 아이콘 버튼.
- 사용량(metrics-server, 2026-11-03): 읽기 명령 `k8s_metrics(target, namespace|null)`가 `metrics.k8s.io/v1beta1`의 PodMetrics·NodeMetrics를 읽는다(discovery 없이 바로 목록을 읽고, 404는 없음). Pod 사용량은 컨테이너 사용량의 합이고(CPU는 올림 밀리코어, 메모리는 바이트), Pod마다 컨트롤러 사슬(Pod → ReplicaSet → Deployment, Job → CronJob, StatefulSet·DaemonSet은 그대로)을 담아 화면이 워크로드별로 합산한다. 사슬은 Pod·ReplicaSet·Job의 메타데이터만 읽어 만들고(ReplicaSet·Job은 필요한 경우에만), 읽지 못하면 사슬 없이 사용량만 보인다. Pod와 노드는 따로 읽어, 서버가 없으면(`notInstalled`)·권한이 없으면(`forbidden`)·API는 있으나 응답이 없으면(`notReady`, 503) 오류 대신 쪽마다 `podsUnavailable`·`nodesUnavailable` 사유로 돌려준다. 연결·SSO 오류는 그대로 오류다.
  - 목록 줄: Pod는 컨테이너가 모두 설정했을 때만 요청·제한 합(`cpuRequest`·`cpuLimit`·`memoryRequest`·`memoryLimit`, 밀리코어·바이트)을 값으로 싣는다(일부만의 합은 사용량과 견줄 수 없어 비운다). 노드는 `cpuAllocatable`·`memoryAllocatable`. 상세의 컨테이너 줄도 요청·제한을 싣는다.
  - 목록 열(사용량을 읽을 수 있을 때만, 정렬 가능): Pod는 CPU, 메모리, %CPU/R, %CPU/L, %MEM/R, %MEM/L(k9s와 같은 이름, 요청·제한이 없으면 빈 칸), 노드는 CPU, 메모리, 할당 가능량 대비 %CPU·%MEM, Deployment·StatefulSet·DaemonSet·ReplicaSet·Job·CronJob은 Pod 사용량 합(CPU, 메모리). 비율이 90%를 넘으면 빨갛게 강조한다(정확히 90%는 아님). 읽을 수 없으면 사용량 열을 만들지 않고 목록 위에 한 줄 안내("metrics-server가 없어 사용량을 보여 줄 수 없어요" 등)만 둔다.
  - Pod 상세의 컨테이너 표에 CPU·메모리 사용량과 그 아래에 요청·제한 대비 비율을 보인다(init 컨테이너는 측정되지 않아 비움). 개요에 네임스페이스별 사용량(CPU 상위·메모리 상위 10개, Pod 수) 표를 둔다.
  - 다시 읽기: 연결됐고 그 탭이 보이는 동안 15초마다(`refetchInterval`, 가려진 탭에서는 읽지 않는다). 사용량 열이 있는 종류를 보거나 그런 객체의 상세를 열었을 때만 읽는다. 목록은 선택한 네임스페이스(클러스터 범위 종류는 전체), 개요는 전체를 읽는다. 그와 별도로 그래프 기록용 읽기는 연결된 동안 탭이 가려져도 계속한다(아래 "사용량 그래프").
- 사용량 그래프(2026-11-03, 같은 날 Prometheus 대신 앱 수집으로 바꿈): 클러스터에 Prometheus를 따로 운영하지 않는다. 탭이 연결돼 있는 동안 고른 네임스페이스(전체면 모두)의 `k8s_metrics`를 15초마다 읽어(탭이 가려지거나 창이 뒤로 가도 계속, 목록과 같은 쿼리 키라 같은 네임스페이스면 한 번만 읽는다) 클러스터·context별로 Pod 합계와 컨테이너별 CPU·메모리를 메모리에 모은다(`src/k8s/usageHistory.ts`). 최근 1시간만 남기고, 10초 안의 중복 값은 버리며, 탭을 닫으면 지운다. 앱을 끄면 사라진다. Pod와 Deployment·StatefulSet·DaemonSet 상세의 요약 탭에서 기본 정보(값 목록) 바로 아래, 소유 관계·컨테이너보다 먼저 "사용량" 절이 CPU·메모리 그래프(폭이 되면 나란히)를 최근 1시간 축에 컨테이너(Pod) 또는 Pod(워크로드, 컨트롤러 사슬로 찾는다)별 선을 그리고, 알려진 요청·제한을 점선으로 표시한다. 45초보다 오래 값이 비면 선을 끊는다. metrics-server가 없거나 권한이 없으면 그 까닭을 보인다. metrics-server는 EKS 기본 설치가 아니지만 AWS 커뮤니티 애드온(`metrics-server`)으로 설치할 수 있다. 같은 기록으로 Pod 목록의 %CPU/R·%CPU/L·%MEM/R·%MEM/L 칸을 작업 관리자처럼 테두리·눈금 안에 면과 선을 그린 고정 크기(64×22px, 모든 칸 같음) 추이 그래프로 그리고, 숫자는 바탕 상자 없이 작고 두꺼운 글씨(10px, 굵게)로 그 위 왼쪽에 얹는다(최근 1시간, 지금의 요청·제한 기준 비율, 세로축 0~100%이고 넘으면 최대치까지 늘리며 그때 100% 점선, 90% 넘으면 빨강). 아직 모은 값이 없는 Pod는 빈 틀에 숫자만, 요청·제한이 없으면 빈 칸, 노드 비율 칸은 숫자만 보인다.
- 앱 안 연결: 노드 → 노드 상세, ServiceAccount → 접근 화면, IAM 역할 → IAM 워크스페이스.
- 이벤트 화면: 네임스페이스·클러스터 전체를 시간순으로, Warning만 보기.

### Secret 값
- 목록과 상세: 키, 타입, 값 크기만. YAML 보기에서 `data`, `stringData`는 `••••`로 가린다.
- 키마다 "값 보기"를 누르면 그때 `get`으로 읽어 그 키만 보여준다. 프론트는 값을 React Query 캐시에 두지 않고 컴포넌트 상태에만 두며, 화면을 떠나면 버린다.
- 백엔드는 Secret 목록을 읽을 때 `data` 값을 응답에서 지우고, 값은 `k8s_secret_value` 명령에서만 돌려준다. 로그·기록·오류에 넣지 않는다.

### 로그
- Pod·컨테이너 하나, 또는 워크로드 하나 아래 모든 Pod를 합쳐서(Pod별 색). Pod가 새로 생기면 따라 붙는다.
- follow, 시작 시점(최근 N줄, 최근 N분), 직전 컨테이너(`previous`).
- 검색과 하이라이트, 일시정지와 자동 스크롤, 파일로 저장(보관 중인 줄).
- 화면 보관은 최근 5만 줄. 백엔드는 줄을 묶어(100ms 또는 500줄) Tauri 채널로 보낸다.
- 백엔드는 Pod spec의 일반 컨테이너 각각에 로그 스트림을 연다(`container: null`은 전체, init 컨테이너는 명시적으로 고른 경우). 워크로드는 Deployment·StatefulSet·DaemonSet·ReplicaSet·Job의 label selector(표현식 포함), Service의 selector로 Pod를 watch한다. 새 Pod는 시작 시각부터 읽고 삭제된 Pod의 스트림은 닫는다. 동시 스트림은 40개로 제한하고 안내한다.
- 모든 요청은 서버 타임스탬프를 받아 RFC3339 접두사를 `ts`와 `text`로 분리한다. 소스별 `lines`·`source`·오류와 전체 `notice`·`end`를 채널로 보낸다. 줄은 소스별 100ms 또는 500줄마다 묶고, 닫기와 `k8s_unwatch`는 자식 스트림까지 멈춘다.
- 저장 명령은 파일명을 안전하게 바꾸고 `~/Downloads`에 새 파일로 쓴다. 같은 이름이 있으면 숫자 접미사를 붙이며 기존 파일은 덮어쓰지 않는다.
- 지금 된 것(2026-11-03): Pod와 Deployment·StatefulSet·DaemonSet·ReplicaSet·Job·Service 상세의 "로그" 탭(CronJob 등 나머지 종류에는 탭이 없다). 명령 `k8s_logs`(Pod, 컨테이너 여럿 가능), `k8s_workload_logs`(워크로드), 둘 다 채널이고 `k8s_unwatch`로 멈추며 탭을 닫으면 같이 멈춘다. 화면 코드는 `LogView`(흐름·칩·보기), `PodLogs`/`WorkloadLogs`(막대), `logSources`(이름표·색·저장 이름).
- 보기 방식(사용자 결정, 2026-11-02): lnav로 보던 방식은 버리고(설치된 lnav를 PTY로 띄웠으나 서비스 JSON 로그를 제대로 읽지 못했다) 앱 안에서 그린다. 기본은 **JSON 정리**, 원하면 **원문**.
  - JSON 정리: `{`로 시작하는 줄을 JSON 객체로 읽어 ▸ 시각(로컬 `MM-DD HH:mm:ss.SSS`, 원래 값은 툴팁) · 레벨(색) · 메시지를 한 줄로 보인다. 흔한 로거의 이름을 읽는다: 시각 `timestamp`·`@timestamp`·`time`·`ts`(ISO 또는 epoch 초·밀리초·마이크로초·나노초), 레벨 `log.level`·`level`·`severity`(pino 숫자 레벨 포함), 메시지 `message`·`msg`. 나머지 필드는 접어 두고, 오류 필드(`error*`, `err*`, `exception`, `stack*`)와 찾는 말이 든 필드는 메시지 옆에 `key=value`로 붙인다. ▸를 누르면 필드 전체(값의 종류별 색)와 JSON 복사. JSON이 아닌 줄은 원문 그대로.
  - 레벨 거르기: 오류·경고·정보·디버그·기타(레벨을 알 수 없는 줄) 칩을 여러 개 함께 고른다. 아무것도 고르지 않으면 모든 줄. 칩마다 줄 수. JSON이 아닌 줄은 맨 앞의 레벨 낱말(`[WARNING] …`, `ERROR: …`)이나 logfmt `level=`로 레벨을 정한다. 찾기의 일치 줄 수와 복사는 보이는 줄만.
  - 공통: 찾기(대소문자 무시, 일치 줄 수), 일시정지(대기 줄 수), 맨 아래 따라가기, 복사(화면에 보이는 그대로), 최근 5만 줄 보관.
  - 합친 로그(워크로드 탭, 또는 Pod의 "모든 컨테이너"): 출처가 둘 이상이면 줄마다 앞에 짧은 Pod 이름(워크로드 이름을 떼고 ReplicaSet 해시도 뗀 끝 5글자, StatefulSet 순번은 온전한 이름)과, 컨테이너가 여럿이면 컨테이너 이름을 `Pod/컨테이너`로 붙인다. 한 Pod의 컨테이너들만이면 컨테이너 이름만. 색은 테마별 팔레트 `--log-c1`~`--log-c8`에서 Pod 이름(한 Pod이면 컨테이너 이름)의 해시로 골라 다시 열어도 같다. 출처 칩(줄 수 포함)을 눌러 출처마다 보이거나 감춘다(레벨 칩의 줄 수도 보이는 출처만 센다). `source ended`인 출처의 칩은 흐리게, `notice`는 힌트로, `error`에 Pod가 있으면 그 출처의 오류만 줄 위에 보이고 나머지는 계속 받는다(다시 붙으면 지운다). Pod가 나중에 붙으면 칩과 이름표가 그때 생긴다(출처가 하나일 때는 이름표 없음).
  - 막대: 컨테이너(**모든 컨테이너** 포함, Pod 탭의 처음 값은 첫 앱 컨테이너, 워크로드 탭은 모든 컨테이너이며 Pod 템플릿의 컨테이너 이름을 고를 수 있다. Service는 템플릿이 없어 선택이 없다), 이전 컨테이너, 따라가기, **기간**(전체·최근 5분·15분·1시간·6시간·24시간 → `sinceSeconds`, 다른 옵션처럼 흐름을 다시 연다), 처음 받을 줄 수(컨테이너마다). **시각**(서버 시각을 로컬 `MM-DD HH:mm:ss.SSS`로 줄 앞에 붙임)과 **줄바꿈**은 화면만 바꾸고 흐름을 다시 열지 않으며, 탭을 열어 둔 동안만 기억한다(기본: 시각 끔, 줄바꿈 켬).
  - **저장**: 보이는 줄(감춘 출처·고른 레벨 밖의 줄은 뺀다)을 화면에 보이는 그대로(이름표와 시각이 보이면 함께) `k8s_logs_save`로 보낸다. 파일 이름은 프런트가 `<Pod 또는 워크로드 이름>-<YYYYMMDD-HHMMSS>.log`(로컬 시각)로 만들어 넘기고, 백엔드가 `~/Downloads`에 쓴 절대 경로를 "저장했어요: <경로>"로 보이며 [Finder에서 보기]는 opener의 `revealItemInDir`를 쓴다. 실패하면 이유를 보인다.

### ArgoCD (사용자 결정, 2026-11-02)
- 위치: 클러스터 탭 안이 아니라 **사이드바 EKS 밑 "🐙 ArgoCD"** 항목. 누르면 단일 탭이 열리고 AWS 프로필과 무관하다(프로필을 바꿔도 닫히지 않는다).
- 연결: 운영 중인 **ArgoCD API 서버**에 **API 토큰**으로 붙는다(비밀번호 로그인 없음). 미리 넣어 둔 서버는 없다. 처음에는 **1단계 서버 주소**(http(s)://, 이름은 비우면 호스트) → **2단계 API 토큰** 순으로 연결하고, 새로 넣은 서버는 곧바로 골라 토큰을 묻는다(사용자 결정, 2026-11-02). 서버는 여러 개(설정 `argocdServers: [{name, url}]`), 탭에서 고르고 목록을 고친다. 목록에서 빼면 그 서버의 토큰도 키체인에서 지우고, 마지막 서버를 빼면 1단계로 돌아간다.
- 토큰: ArgoCD UI Settings → Accounts → 계정 → Tokens나 `argocd account generate-token`으로 만들어 붙여 넣는다. `/api/v1/session/userinfo`로 확인된 토큰만 **macOS 키체인**(service `magic-mirror.argocd`, account = 서버 URL)에 저장하고, 앱은 메모리 캐시를 둔다. 키체인 호출은 블로킹 스레드에서 한다. 설정 파일·로그·오류에 토큰을 넣지 않는다. `http://` 서버는 평문 전송 경고를 보인다. 401이면 토큰 입력으로 돌아간다(토큰은 지우지 않는다).
- 목록(10초마다 다시 읽음, 탭이 안 보이면 멈춤): 앱 심각도는 오류(오류 조건, Degraded·Missing, 작업 Failed·Error) > 주의(OutOfSync, Progressing 등 그 밖의 문제) > 정상이고, 심한 앱이 먼저. 대상 열의 `https://kubernetes.default.svc`·`in-cluster`는 "이 클러스터"(필터·묶기에서도 한 값).
- 거르기(사용자 결정 2026-11-02, 두 서버의 메타데이터를 보고 정함): 종류마다 다중 선택, 종류 안 OR·종류 사이 AND. 선택지 옆 개수는 그 종류의 선택만 뺀 나머지 조건 기준(Sync·Health 칩은 둘 다 뺀 기준).
  - Sync·Health 칩, 환경 칩, 대상 클러스터·프로젝트 체크 목록, 레이블 필터(`key=value` 또는 `key`, 입력하면 데이터에 있는 후보와 개수, Enter는 고른 후보 → 입력과 같은 후보 → 첫 후보 → 후보가 없을 때만 입력 그대로; 같은 키는 OR, 다른 키는 AND), 검색(이름·레이블 값·대상 네임스페이스).
  - 환경은 레이블이 들쭉날쭉해 추론한다: `preview=true` → 레이블 `environment` → `env`(마지막 토막, `ai-dev` → dev) → 이름 토막 → 대상 네임스페이스 → 대상 클러스터(`dev2` → dev). prod·production → prd, staging·stage → stg, development → dev. 값은 dev·stg·prd·ops·demo·preview·미분류(이 순서로 보인다). 이름 옆 환경 열의 배지(상태색과 겹치지 않는 색)에 마우스를 올리면 어디서 읽었는지 보인다. 환경으로 묶으면 환경 열은 뺀다.
- 묶기: "묶기"와 "그 안에서" 두 단계, 기준은 ApplicationSet·환경·대상 클러스터·프로젝트·네임스페이스·레이블 키(데이터에 있는 키마다)·없음. 기본은 ApplicationSet 한 단계. 2단계는 1단계와 같을 수 없고 1단계가 없음이면 쓰지 않는다. 순서는 어느 기준이든 빨강 → 노랑 → 정상이 먼저(사용자 결정 2026-11-02: 정상보다 문제 묶음이 밑에 오면 안 된다), 같은 색 안에서는 값이 없는 묶음(ApplicationSet 없음, 레이블 없음 등)이 맨 뒤, 그 밖은 환경이면 위의 고정 순서, 나머지는 이름 순.
  - 1단계는 각진 카드(사용자 결정 2026-11-02). 카드 왼쪽 굵은 줄과 테두리로 상태를 구분한다(오류 빨강 8px, 주의 노랑 8px, 정상 파랑 4px; ApplicationSet 자체가 Error여도 빨강). 머리 줄은 색을 바꾸지 않고 ▾/▸·이름·상태 막대(이름 바로 뒤, 묶음마다 같은 자리)·요약 칩(오류·OutOfSync·주의·정상, 앱 하나는 한 칸)·앱 수. ApplicationSet으로 묶을 때만 generator·상태·Error 메시지와 앱 없는 ApplicationSet 카드. 표 머리는 위에 하나, 열 너비를 고정해 카드 사이에 열이 맞는다.
  - 2단계는 카드 안의 얇은 소제목 줄(▾/▸·이름·요약 칩·앱 수) 아래에 그 묶음의 행.
  - 문제 우선 접기(사용자 결정 2026-11-02, 정상 표시가 자리를 너무 차지해서): 문제가 있는 카드·소제목은 펴고, 모두 정상인 카드는 얇고 흐린 머리 줄로 접어 바짝 붙이고, 모두 정상인 소제목도 접는다. 문제와 정상이 섞인 묶음은 문제 행 아래 정상 행을 엷은 초록 줄 하나로 접고, 그 줄에 `정상 Application N개`와 정상 앱 이름을 늘어놓는다(넘치면 …). 누르면 그 자리에서 펼친다. 묶지 않을 때도 같다.
  - Sync·Health 칩을 고르거나 검색하면 찾은 것을 접지 않는다. 사용자가 직접 펴거나 접은 것은 탭이 열린 동안 그대로 둔다. "모두 펼치기"는 모두 펴고, 다시 누르면("정상 접기") 처음 규칙으로 돌아간다(둘 다 직접 펴고 접은 기억은 지운다).
- 서버마다 마지막으로 고른 필터·묶기를 설정 `argocdViews`(서버 주소 → Sync·Health·환경·클러스터·프로젝트·레이블·묶기 두 단계)에 남겨 다시 열면 그대로 보인다. 검색어는 남기지 않는다. 서버를 지우면 함께 지운다. 읽지 못하는 묶기 값은 기본값으로.
- 상세: 개요(상태, 마지막 작업과 실패 리소스, 조건 전문, 소스·values 파일, 대상, 동기화 정책, 이미지, ApplicationSet), 리소스 트리(`resource-tree` API의 부모 관계로 Deployment → ReplicaSet → Pod 들여쓰기, 노드별 Health·info, Application의 Sync 상태·hook·삭제 예정 표시), 동기화 이력, YAML/JSON(Application 전체).
- 실행: Refresh·Hard refresh(`GET …?refresh=`), Sync(확인 창, Prune·Dry run 기본 끔, `POST …/sync`). 권한 판단과 요청자 기록은 ArgoCD 서버가 한다. 진행 중이면 Sync를 끈다. 클러스터에 직접 쓰지 않으므로 `k8s::hygiene` 예외는 없다.
- 명령: `argocd_set_token`, `argocd_forget_token`, `argocd_session`, `argocd_apps`, `argocd_appsets`, `argocd_app`, `argocd_tree`, `argocd_refresh`, `argocd_sync` (`src-tauri/src/argocd/`, `src-tauri/src/argocd_commands.rs`, 프론트 `src/argocd/`).

### 네트워크
- Service·Ingress → ALB·NLB: AWS Load Balancer Controller 태그(`elbv2.k8s.aws/cluster`, `service.k8s.aws/stack`, `ingress.k8s.aws/stack`)와 status 호스트명으로 짝을 찾는다. 리스너, 대상 그룹 상태.
- 노드 → 서브넷·AZ. VPC CNI면 Pod IP가 속한 서브넷.
- 기존 VPC 다이어그램 열기(클러스터 노드와 로드밸런서 강조).
- NetworkPolicy는 목록과 상세만.
- 지금 된 것 (2026-11-03): 왼쪽 메뉴 "🌐 네트워크"(읽기 전용, `k8s_network`, `src-tauri/src/k8s/network/`, 프론트 `src/k8s/network/`). 탭 넷:
  - **로드밸런서**: type이 LoadBalancer인 Service와 모든 Ingress. 짝은 status 호스트명(DNS 이름과 같음, 대소문자·끝 점·`dualstack.` 무시)을 먼저 보고, 없으면 태그로 찾는다. 태그는 `elbv2.k8s.aws/cluster`가 이 클러스터 이름이어야 하고 `service.k8s.aws/stack`=`네임스페이스/이름`(Service), `ingress.k8s.aws/stack`=그룹 이름 또는 `네임스페이스/이름`(Ingress)이다. 호스트명이 있으면 호스트명이 이긴다. 짝이 없으면 이유(주소 없음 / ELBv2에 없음 / AWS 읽기 실패)를 보인다. ELBv2만 읽으므로 클래식 로드 밸런서(CLB)는 "찾지 못함"으로 나오고 안내 문구에 CLB일 수 있다고 적는다(CLB SDK를 새로 들이지 않았다). 행을 누르면 70% 상세: 요약, 로드 밸런서, 리스너(기본 동작과 ALB 규칙), 대상 그룹과 대상 상태(정상·비정상과 사유, 대상 IP는 Pod로, 인스턴스 ID는 노드로 링크). 클러스터 태그가 붙었지만 어떤 객체도 가리키지 않는 로드 밸런서는 아래에 따로 보인다.
  - **노드·서브넷**: 노드 → providerID의 인스턴스 ID → EC2(DescribeInstances, 필터로 조회) → 서브넷·AZ. 서브넷 표는 클러스터 VPC 전체(남은 IP, 용량, 노드 수, Pod 수). VPC는 EKS DescribeCluster, 실패하면 인스턴스의 VPC.
  - **Pod IP**: kube-system에 `k8s-app=aws-node` Pod가 있으면 VPC CNI로 보고 Pod IP를 서브넷 CIDR에 대어(가장 긴 접두) 서브넷별 Pod 수를 센다. hostNetwork Pod는 노드 IP라 세지 않고, 어느 서브넷에도 없는 IP는 따로 센다. VPC CNI가 아니면 서브넷에 잇지 않고 Pod 목록만 보인다.
  - **NetworkPolicy**: 목록과 상세(대상 Pod, 방향, 들어오고 나가는 규칙 요약: 기본 policyTypes 적용, 모두 차단·모두 허용 구분). 정책이 하나도 없는 네임스페이스에 표시(시스템 네임스페이스는 흐리게). 실제로 막히는 트래픽은 계산하지 않는다.
  - AWS를 읽지 못한 부분(권한, SSO 만료, 시간 초과)은 화면 위에 이유와 함께 한 줄로 묶여 남고 나머지는 그대로 보인다.
  - [VPC 다이어그램 열기]는 클러스터의 노드(인스턴스 ID)와 로드 밸런서(ARN)를 강조해서 기존 VPC 구조도 탭을 연다(`VpcMapTab`의 선택 속성 `highlight`, 앱의 `openVpc`에 선택 필드 `highlight`). 이미 열린 탭은 새 강조를 받을 때만 바꾼다. 상세의 [VPC 다이어그램에서 보기]는 그 로드 밸런서 하나만 강조한다. 강조 리소스는 칸이 넘쳐도 "+N"에 묻히지 않게 앞에 놓고, 막대에서 끌 수 있다.

## 접근

### 신원 연결
- access entry(`ListAccessEntries`, `DescribeAccessEntry`, `ListAssociatedAccessPolicies`)와 `kube-system/aws-auth`(`mapRoles`, `mapUsers`, 템플릿 `{{SessionName}}` 등)를 모은다.
- 인증 모드에 따라 유효한 쪽을 표시한다(`API_AND_CONFIG_MAP`에서는 access entry가 먼저).
- access policy는 고정 대응표로 바꾼다: `AmazonEKSClusterAdminPolicy` → `cluster-admin`, `AmazonEKSAdminPolicy` → `admin`, `AmazonEKSEditPolicy` → `edit`, `AmazonEKSViewPolicy` → `view`. 범위가 네임스페이스면 그 네임스페이스에만. 표에 없는 정책은 "평가하지 못함".
- `AWSReservedSSO_<권한 세트>_<해시>` 역할은 권한 세트 이름으로 묶어 보여준다.

### 실효 권한 (순수 함수)
- 입력: Role, ClusterRole, RoleBinding, ClusterRoleBinding, 신원 매핑, access policy. 출력: 주체(사용자, 그룹, ServiceAccount, IAM 주체)별 규칙과 출처 경로.
- 처리: `aggregationRule`, `*`, `resourceNames`, 하위 리소스, `nonResourceURLs`, 기본 그룹(`system:authenticated`, `system:serviceaccounts`, `system:serviceaccounts:<ns>`).
- RBAC과 EKS access policy만 계산한다. 화면에 "RBAC과 EKS access policy만 계산해요"를 적는다.
- **엔진 API**(`k8s/access/engine.rs`, 순수. K5 보안 점검과 K8 D의 RBAC 변경 미리보기가 부른다):
  - `evaluate(rbac, principals) -> Evaluation`: `Rbac`(Role·ClusterRole(`aggregationRule` 포함)·RoleBinding·ClusterRoleBinding)과 유효한 신원 매핑(`Principal`: IAM 주체의 쿠버네티스 사용자 이름·그룹·access policy)을 받아 주체별 `SubjectRules`를 만든다. 규칙마다 `Grant`(범위 + 규칙 + 출처 `Source`: 방법(직접·매핑이 준 그룹·기본 그룹·access policy·`system:masters` 내장) → 바인딩 → 역할 → 합쳐 준 ClusterRole).
  - `Evaluation::can(subject, Query { verb, group, resource, subresource, namespace, name }) -> Decision { allowed, grants }`와 `can_non_resource(subject, verb, path)`. 목록에 없는 주체(바인딩에 이름이 없는 ServiceAccount 등)는 그 자리에서 계산한다.
  - `Evaluation::who_can(&Query) -> Vec<WhoCan>`: 할 수 있는 주체와 경로. 기본 그룹(`system:authenticated` 등)에서 물려받은 권한은 그 그룹 항목에만 두고 사용자·ServiceAccount 줄마다 되풀이하지 않는다.
  - `diff::diff(before, after) -> Vec<SubjectDiff>`: 두 RBAC 시점에서 누가 무엇을 얻고 잃는지. 달라진 규칙에서 대표 요청을 만들어 양쪽을 평가하고 결과가 바뀐 것만 낸다(`*`는 두 시점의 규칙에 나온 (그룹, 리소스)와 표준 동사로 펼치고 나머지는 `*`로 적는다).
  - `Evaluation::dangling()`: 없는 역할을 가리키는 바인딩. `Evaluation::identity_of(subject)`: SubjectAccessReview 대조에 쓸 사용자·그룹.
- **의미**(API 서버의 RBAC 인가와 같다): `*`는 모든 동사·그룹·리소스(하위 리소스 포함)에 맞고, `pods`는 `pods/exec`에 맞지 않으며 `*/exec`만 하위 리소스에 맞는다(`pods/*`는 맞지 않는다). `resourceNames`는 이름을 지정한 요청에만 맞는다. RoleBinding은 그 네임스페이스에만(ClusterRole을 가리켜도, `nonResourceURLs`는 무시), ClusterRoleBinding은 모든 네임스페이스·클러스터 범위·비리소스 URL에 적용한다. 네임스페이스 없는 요청(`kubectl get pods -A` 포함)은 ClusterRoleBinding으로 받은 권한만 맞는다. `aggregationRule`은 선택자에 맞는 다른 ClusterRole의 규칙을 이름 순서로 합치고(여러 단계, 순환은 끊는다) 그 ClusterRole에 적어 둔 `rules`는 쓰지 않는다. 모든 주체는 `system:authenticated`(`system:anonymous`는 `system:unauthenticated`), ServiceAccount는 `system:serviceaccounts`와 `system:serviceaccounts:<ns>`도 가진다. `system:masters`는 API 서버가 모두 허용한다. User 바인딩의 이름이 `system:serviceaccount:<ns>:<name>`이면 그 ServiceAccount에 적용된다. IAM 사용자 이름이 `{{SessionName}}` 템플릿이면 그 템플릿에 맞는 이름의 User 바인딩을 "특정 세션 이름일 때만"으로 표시해 적용한다.
- **권한 표**: 주체 × 네임스페이스(열: 클러스터 전체 + 고른 네임스페이스 최대 8). 주체는 바인딩에 이름이 나온 사용자·그룹·ServiceAccount와 유효한 IAM 주체다(바인딩에 이름이 없는 ServiceAccount는 `system:serviceaccounts*` 그룹 행으로 본다). 칸 일곱은 대표 요청 몇 개가 이름 지정 없이 허용되는지로 정한다. 단계는 전부(모두 허용)·일부(일부만 허용되거나 `resourceNames`로 정해진 이름만)·없음. 네임스페이스 열은 그 네임스페이스의 요청(ClusterRoleBinding 권한 포함), 클러스터 전체 열은 클러스터 범위 요청(ClusterRoleBinding 권한만)으로 계산한다.

  | 칸 | 대표 요청 | 전부 | 일부 |
  |---|---|---|---|
  | 읽기 | pods, services, configmaps, persistentvolumeclaims, deployments, statefulsets, daemonsets, jobs, cronjobs, ingresses 10종 × get·list·watch | 30개 모두 | 하나라도 |
  | 쓰기 | 같은 10종 × create·update·patch | 30개 모두 | 하나라도 |
  | 삭제 | 같은 10종 × delete·deletecollection | 20개 모두 | 하나라도 |
  | exec·attach·port-forward | pods/exec, pods/attach, pods/portforward의 create | 셋 모두 | 하나라도 |
  | Secret 읽기 | secrets × get·list·watch | 셋 모두 | 하나라도 |
  | RBAC 변경 | roles·rolebindings(클러스터 전체 열은 clusterroles·clusterrolebindings도) × create·update·patch·delete | 모두 | 하나라도 |
  | 권한 상승 가능 | 직접: roles·clusterroles의 escalate·bind, users·groups·serviceaccounts의 impersonate, serviceaccounts/token create, nodes/proxy get·create. 간접: pods·deployments·statefulsets·daemonsets·jobs·cronjobs create(Pod를 만들어 다른 ServiceAccount 토큰을 쓴다), secrets get·list(토큰 읽기) | 직접 경로 하나라도 | 간접 경로 하나라도(직접은 이름 한정만) |

  칸을 누르면 오른쪽 상세(70%)에 단계, 확인한 동작별 허용 여부, 바인딩 경로가 보인다. 큰 클러스터를 위해 한 쪽(25행)씩 백엔드가 계산해 보내고, 종류 칩·이름 필터·네임스페이스 고르기(검색)가 있다. 계산 결과(`Evaluation`)는 대상마다 캐시하고 연결이 바뀌면 버린다([다시 읽기]는 새로 읽는다).
- **누가 할 수 있나**: 동사 + 리소스(kubectl 식 `pods`, `deployments.apps`, `pods/exec`) + 네임스페이스(+ 이름) → 주체와 경로(1000명까지). [클러스터에 대조]는 `SubjectAccessReview`를 주체마다 보내고(최대 100명, 동시 4개) 계산은 허용인데 클러스터가 거부한 줄에 "다름"을 붙인다. 이 신원이 `create subjectaccessreviews`를 할 수 없으면(내 권한의 규칙 목록으로 확인) 이유와 함께 꺼 둔다. 세션 이름 템플릿에만 기대는 권한은 클러스터에 같은 신원이 없어 대조하지 않는다.

### 워크로드 신원
- ServiceAccount마다 IRSA 어노테이션, Pod Identity 연결(`ListPodIdentityAssociations`), 쓰는 Pod.
- IRSA 확인: 역할의 신뢰 정책에 이 클러스터의 OIDC 공급자와 `sub` = `system:serviceaccount:<ns>:<sa>`(또는 맞는 와일드카드), `aud` = `sts.amazonaws.com` 조건이 있는지. 없으면 "연결돼 있지만 동작하지 않음".
- Pod Identity는 연결의 역할 신뢰 정책이 `pods.eks.amazonaws.com`에 `sts:AssumeRole`과 `sts:TagSession`을 허용하는지 같은 방식으로 확인한다.
- ServiceAccount의 `eks.amazonaws.com/audience` 어노테이션이 있으면 그 값을 `aud`로 확인한다(기본 `sts.amazonaws.com`). `sub`·`aud` 조건은 `StringEquals`·`StringLike`(와일드카드)·`StringEqualsIgnoreCase`만 풀고, 다른 연산자(`StringNotEquals` 등)에 기대면 "확인하지 못함"이다. 여러 문장 중 하나라도 맞으면 동작한다.
- 역할을 읽지 못하면(IAM 권한 없음 등) 그 연결만 "확인하지 못함"이고 나머지는 그대로 보인다. 역할을 누르면 IAM 워크스페이스에서 그 역할을 연다.
- IRSA와 Pod Identity가 모두 있으면 "보통 IRSA가 먼저 쓰여요"를 적는다. Pod는 끝나지 않은 것만 읽고, ServiceAccount·Pod 목록은 쪽 한도(40쪽)에서 잘리면 알린다.

### 지금 된 것 (2026-11-03)
- K4 전부: 위의 엔진·권한 표·누가 할 수 있나·신원 연결·워크로드 신원과 왼쪽 메뉴 "🛡 접근"(내 권한 아래). 읽기 전용이고 EKS API는 모의 응답으로만 시험했다(`k8s/access/read/tests.rs`). 실제 클러스터 대조는 kind(`k8s::live_tests::access`, 픽스처 `scripts/k8s-live/access.sh`)에서 `SubjectAccessReview`와 `kubectl auth can-i --as`에 요청마다 맞춘다.
- 신원 연결 읽기: 인증 모드가 `CONFIG_MAP`이면 access entry API를 부르지 않고(그 모드에서는 오류가 난다), 인증 모드를 읽지 못하면 두 출처를 모두 유효하다고 본다. access entry는 목록 → 항목마다 `DescribeAccessEntry`·`ListAssociatedAccessPolicies`를 동시에 8개씩 읽고 한 항목이 실패하면 그 항목만 "자세히 읽지 못했어요"로 남긴다. aws-auth가 없으면 오류가 아니다. 출처마다 실패는 응답의 `gaps`로 오고 화면에 "이 부분을 읽지 못했어요: …"로 보인다.
- aws-auth 이름을 비우면 인증기처럼 ARN을 사용자 이름으로 보고, `{{AccountID}}`는 채우며 `{{SessionName}}` 등은 그대로 둔다. aws-auth의 `rolearn`은 경로 없이, access entry의 주체는 경로를 포함하니 같은 주체인지는 (계정, 종류, 이름)으로 비교한다.

## 보안 점검
- 클러스터: 퍼블릭 엔드포인트가 `0.0.0.0/0`, 컨트롤 플레인 로깅 꺼짐, Secret 암호화 꺼짐, 표준 지원 종료 90일 이내 버전, aws-auth 사용, 생성자 관리자 권한 남음.
- 권한: `cluster-admin`·`system:masters` 주체, `system:authenticated`·`system:anonymous`에 준 권한, 권한 상승 경로(`bind`, `escalate`, `impersonate`, Pod 생성 + 강한 SA 사용, `nodes/proxy`, Secret 전체 읽기), 쓰이지 않는 Role과 바인딩.
- 워크로드: privileged, hostPath, hostNetwork, hostPID, root 실행, `allowPrivilegeEscalation`, request·limit 없음, probe 없음, `latest`나 태그 없는 이미지, default SA 토큰 자동 마운트, NetworkPolicy 없는 네임스페이스, IMDS hop limit이 2 이상인 노드그룹(Pod가 노드 역할을 쓸 수 있음).
- 항목별 켜고 끄기, 시스템 네임스페이스(`kube-system`, `kube-public`, `kube-node-lease`, `amazon-*`) 기본 제외.
- 각 항목은 대상으로 연결되고, 고칠 수 있는 항목은 해당 변경 미리보기로 이어진다.

### 지금 된 것 (2026-11-04)
왼쪽 메뉴 "🔍 보안 점검"(내 권한·접근 아래, 읽기 전용). 백엔드 `src-tauri/src/k8s/checks/`(순수 점검 + `read.rs` 읽기), 명령 `k8s_findings(target) → Report`(`k8s_security_commands.rs`), 프론트 `src/k8s/security/`. 처음 계약의 `force`는 두지 않았다(화면의 쿼리가 60초 캐시하고 [다시 점검]이 새로 읽는다).
- **결과 모양**: `Finding { id, check, severity(high·medium·low), target, namespace, system, message, evidence[], fix? }`. 대상(`target`)은 클러스터 객체(워크로드 화면에서 연다), 주체(사용자·그룹·ServiceAccount·IAM 주체: 접근 화면·IAM·ServiceAccount 객체로 간다), AWS 리소스(`cluster`·`nodegroup`·`nodepool`·`instance`, 열기 없음) 셋이다. `Report { findings, skipped[], gaps[], fetchedAt }`: 입력을 읽지 못한 점검은 `skipped`, 이유는 `gaps`(목록이 쪽 한도에서 잘린 것은 `partial`)에 남고 나머지 점검은 그대로 돈다. AWS 클라이언트를 만들지 못해도 AWS 부분만 gap이다.
- **점검 28개** (이름은 `CheckId`와 프론트 `CHECKS`가 같다)
  - 클러스터 6: `clusterPublicEndpoint`(퍼블릭이 켜지고 허용 CIDR에 `0.0.0.0/0`·`::/0`이 있거나 비었음, 높음), `clusterLoggingOff`(다섯 유형 중 꺼진 것. audit·authenticator가 꺼졌으면 중간, 아니면 낮음), `clusterSecretsPlain`(`encryptionConfig`에 secrets 없음, 중간), `clusterVersionSupport`(표준 지원 종료까지 90일 이내 중간, 지났으면 높음), `clusterAwsAuth`(실제로 쓰이는 aws-auth 매핑이 있음. 노드 역할뿐이면 낮음, 아니면 중간), `clusterCreatorAdmin`(클러스터 전체 `AmazonEKSClusterAdminPolicy` access entry 중 클러스터 생성 −60초~+300초에 만들어진 것. EKS는 만든 신원을 알려 주지 않아 "추정"이라고 밝힌다, 중간).
  - 버전 지원 기간은 `DescribeClusterVersions`(`includeAll`)의 `endOfStandardSupportDate`를 먼저 쓰고, 읽지 못했거나 그 버전이 없으면 코드의 고정 표(`checks/versions.rs`, 출처: AWS 문서 "Amazon EKS Kubernetes versions"의 표준 지원 종료일, 1.23~1.33)를 쓰며 증거에 어느 쪽인지 적는다. 둘 다 모르면 점검하지 않는다.
  - 권한 10(접근 화면의 실효 권한 엔진 `Evaluation`의 `Grant`를 그대로 쓰고 RBAC을 다시 계산하지 않는다): `adminSubject`(모든 동사·그룹·리소스 규칙. 클러스터 전체 높음, RoleBinding으로 네임스페이스 안만이면 중간, 기본 그룹 `system:masters`는 낮음), `anonymousAccess`(`system:unauthenticated`·`system:anonymous`는 높음, `system:authenticated`는 중간(모든 권한이면 높음), 바인딩 하나당 문제 하나), `escalateBind`·`impersonate`(`serviceaccounts/token` 만들기 포함)·`nodesProxy`·`secretsReadAll`(클러스터 전체 범위만, 이름 한정은 제외, 관리자는 따로 세지 않는다), `podCreateStrongSa`(강한 ServiceAccount가 있는 같은 네임스페이스에서 Pod·Deployment 등을 만들 수 있는 주체. 강함 = 관리자이거나 위 상승 경로가 있음), `unusedRole`(바인딩이 없고 `aggregationRule`로도 합쳐지지 않는 Role·ClusterRole, 낮음), `bindingMissingRole`(낮음), `bindingMissingSubject`(없는 ServiceAccount, 목록을 끝까지 읽었을 때만, 중간).
  - 기본 구성은 뺀다: 주체의 기본 그룹에서 물려받은 권한과 `system:`·`kubeadm:`·`eks:`로 시작하는 바인딩이 준 권한(익명 점검에서 `system:public-info-viewer` 등), `system:`·`eks:`·`kubeadm:` 이름과 `kubernetes.io/bootstrapping=rbac-defaults` 라벨이 붙은 역할, EKS access policy가 가리키는 `cluster-admin`·`admin`·`edit`·`view`.
  - 워크로드 12(Pod 템플릿 기준: Deployment·StatefulSet·DaemonSet·Job·CronJob과 컨트롤러 없는 Pod. 컨트롤러가 만든 Pod·Job은 컨트롤러에서 한 번만 본다. 점검마다 워크로드 하나에 문제 하나): `privileged`(높음), `hostPath`(노드 루트·`*.sock`·`/etc`·kubelet·런타임 디렉터리는 높음, 나머지 중간), `hostNetwork`(중간), `hostPid`(높음), `runsAsRoot`(UID 0 명시는 중간, UID·`runAsNonRoot` 모두 미지정은 낮음), `privilegeEscalation`(미지정·true, 중간. privileged 컨테이너와 Windows Pod는 제외), `resourcesMissing`·`probesMissing`(Job·CronJob 제외)·`imageLatest`(태그 없음·`latest`, 다이제스트 고정은 제외)(낮음), `saTokenAutomount`(네임스페이스의 `default` ServiceAccount를 쓰는 워크로드가 있는데 토큰 자동 마운트가 꺼져 있지 않음. 그 ServiceAccount에 다른 권한이 있으면 중간, 아니면 낮음), `noNetworkPolicy`(워크로드가 있으면 중간, 없으면 낮음), `imdsHopLimit`(관리형 노드그룹 시작 템플릿의 `HttpPutResponseHopLimit`과 노드 인스턴스(`DescribeInstances`)의 값이 2 이상. 노드그룹·NodePool·인스턴스 단위, 높음. 시작 템플릿 하나를 읽지 못하면 그 노드그룹만 gap).
- **자동으로 고치는 것(안전한 부분만)**: ① `default` ServiceAccount의 `automountServiceAccountToken: false` — 그 ServiceAccount에 기본 그룹 말고 다른 권한이 없다고 RBAC으로 확인될 때만(RBAC을 읽지 못하면 고치지 않는다). ② 컨테이너·init 컨테이너의 `allowPrivilegeEscalation: false` 더하기 — 미지정인 컨테이너만(사람이 `true`로 둔 것, privileged, `CAP_SYS_ADMIN` 컨테이너는 제외), Pod 템플릿을 바꿀 수 있는 Deployment·StatefulSet·DaemonSet·CronJob만(Pod와 Job은 만든 뒤에 바꿀 수 없어 증거에 이유를 적는다). 값을 사람이 정해야 하는 것(request·limit·probe·이미지 태그)과 서비스가 깨질 수 있는 것(hostNetwork·hostPID·root 실행·NetworkPolicy)은 고치지 않는다. AWS 쪽 항목은 이 앱이 바꾸지 않는다.
  - 고치기는 바꾸는 필드만 담은 부분 객체의 `apply` 변경(server-side apply, `force: false`)으로 기존 미리보기·이름 입력·재확인·기록·되돌리기 틀을 그대로 거친다. 충돌은 미리보기가 보여 주고 강제 적용은 그 틀의 이름 입력이다. 주의 문구(롤아웃, setuid·capability 영향, Helm·ArgoCD·Flux가 관리하면 다음 배포 때 되돌아감)는 상세에 보인다. patch 권한이 없으면 이유와 함께 꺼지고 규칙이 불완전하면 켜 둔다. 적용하면 점검을 바로 다시 읽는다.
- **화면**: 심각도·분류 카드(누르면 거르기), 검색, [시스템 네임스페이스 포함], [점검 항목별로 묶기](접고 펴는 묶음), [점검 항목] 켜고 끄기(분류별 모두 켜기·끄기, 항목마다 찾은 수와 "읽지 못해 점검하지 못했어요" 표시), 읽지 못한 부분과 점검하지 못한 항목 줄. 목록은 `ListTable`(심각도·점검 항목·대상·네임스페이스·내용·자동 수정)이고 행을 누르면 70% 상세(요약, 증거, 왜 중요한가요, 해결 방법, 자동으로 고치기)가 열린다. 도구 모음: [워크로드 화면에서 열기]/[ServiceAccount 열기]/[IAM에서 열기]/[접근 화면에서 보기], 맨 오른쪽 [자동으로 고치기].
- **설정**: `Settings.k8sSecurityChecks { disabled: string[], includeSystem: bool }`(모든 클러스터에 같이 적용, 키가 없는 예전 설정은 모두 켜고 시스템 네임스페이스는 뺀다). 점검은 항상 전부 계산하고 화면이 걸러서 켜고 끄기가 바로 반영된다. 시스템 네임스페이스는 `is_system_namespace`(`kube-system`·`kube-public`·`kube-node-lease`·`amazon-*`)로 정하고 문제의 `namespace`로 따진다(클러스터 점검은 네임스페이스가 없어 늘 보인다).
- **시험**: 점검마다 단위 시험(경계: 90일/91일, CIDR 변형, 로그 유형, 컨테이너·init 덮어쓰기, 기본 그룹·내장 바인딩 제외, 네임스페이스 범위 구분, 자동 수정 대상·제외, 읽지 못한 입력의 skipped·gap), EKS·EC2는 모의 AWS 응답(`checks/mock_aws.rs`: DescribeCluster·DescribeClusterVersions·노드그룹·시작 템플릿·DescribeInstances, 쪽 넘기기·거부·부분 실패), 화면은 `src/k8s/security/*.test.*`. kind 실제 시험은 `k8s::live_tests::security`(`scripts/k8s-live/security.sh`: 점검마다 걸리는 워크로드와 RBAC): 찾은 문제의 집합을 픽스처와 대조하고, 권한 없는 계정은 gap·skipped, 고치기는 서버 dry-run diff → 적용 → 다시 점검에서 사라짐을 확인한다.

## 변경

### 공통
- 변경 버튼은 토글 없이 늘 보인다(사용자 결정 2026-11-03: 처음 설계의 **변경** 토글은 버튼을 찾지 못하게 만들어 없앴다). 권한이 없으면 이유와 함께 비활성화. 안전은 미리보기·이름 입력·재확인이 맡는다.
- 버튼 자리와 색(사용자 결정 2026-11-03): 상세 머리 아래 도구 줄 하나에 YAML 편집(편집 중에는 미리보기·편집 취소), 종류별 조작, 삭제를 모두 두고 오른쪽 정렬한다. 지우기처럼 되돌리기 어려운 것이 맨 오른쪽. 셸 탭의 열기와 요약의 IAM 이동 버튼은 제자리에 둔다. Pod의 노드는 요약의 노드 칸에서 소유자처럼 이름 링크로 연다.
- 버튼 크기(사용자 결정 2026-11-03): EKS·ArgoCD 탭의 모든 `.btn`은 한 크기(높이 24px, 글자 12px, 내용만큼의 너비)다. 탭 바깥(`k8s-pane`·`argo-pane`)의 버튼은 바꾸지 않는다.
- EKS·ArgoCD 버튼의 여섯 역할은 파랑 실행·미리보기, 노랑 주의 조작, 빨강 삭제, 회색 보조, 강조색 테두리 이동, 투명 테두리 취소이며 노드 셸 닫기는 취소의 빨강 변형이다. 공통 미리보기 푸터와 다른 탭은 바꾸지 않는다.
- 미리보기: API 호출(동사, 경로, 본문), 필드 diff, 영향, 경고. 쿠버네티스 쓰기는 모두 server-side dry-run을 먼저 돌린다.
- 이름 입력이 필요한 위험한 변경: 네임스페이스가 `kube-system`이거나 이름에 `prod`가 들어감, drain, `cluster-admin`이나 권한 상승 경로를 주는 바인딩, 앱의 현재 신원이 권한을 잃는 변경, `AmazonEKSClusterAdminPolicy` 연결.
- 적용 시 재확인: 미리보기 직전에 GET한 `resourceVersion`을 조건으로 보낸다. status 갱신만으로 409가 생긴 경우 status·resourceVersion·managedFields를 뺀 객체 전체(메모리의 SHA-256으로 비교)와 계획이 같으면 새 버전으로 dry-run을 다시 하고 적용한다. generation이나 spec 등 그 밖의 내용이 바뀌면 "미리보기 이후 바뀌었어요"로 멈춘다. 미리보기 dry-run 중 버전이 바뀌면 최신 객체로 다시 계획한다. 장바구니는 적용 전에 계획을 다시 만들어 미리보기와 다르면 멈춘다.
- 기록: IAM·PG와 같은 `jsonl.rs`를 쓰는 `k8s` 기록 파일. 되돌리기는 같은 미리보기를 거친다.
- 지금 된 것: K7 단일 변경은 서버 dry-run을 거쳐 호출·diff·영향·경고를 보관하고 적용 시 같은 계획과 연결을 재확인한다. 변경 기록은 `k8s-changes.jsonl`, 되돌리기는 기록된 역변경을 다시 미리보기한다. Secret은 값과 재생성용 객체를 기록하지 않는다.

### A. 워크로드 조작
| 동작 | 대상 | 되돌리기 |
|---|---|---|
| scale | Deployment, StatefulSet | 이전 replicas |
| rollout restart | Deployment, StatefulSet, DaemonSet | 불가(rollout undo 안내) |
| rollout undo | Deployment(ReplicaSet 리비전), StatefulSet·DaemonSet(ControllerRevision) | 원래 리비전으로 |
| Pod 삭제 | Pod | 불가. 컨트롤러 없는 Pod는 경고 |
| 삭제 | 목록·watch가 되는 모든 종류(Pod 제외 위 행) | 컨트롤러·소유자가 없으면 기록한 정리된 객체로 다시 만들기(Secret은 값을 기록하지 않아 불가). Namespace·Node·CRD·PV 삭제와 소유자가 있는 객체(컨트롤러가 다시 만든다는 경고)는 이름 입력 |
| Job 재실행 | Job, CronJob → 새 Job | 만든 Job 삭제 |
| 일시정지·재개 | CronJob(`suspend`) | 반대 |
- 소유자 없는 Job을 지울 때 기록하는 되살리기용 객체에서는 서버가 만든 selector(`manualSelector: true`가 아닐 때)와 `controller-uid`·`job-name`(`batch.kubernetes.io/` 포함) 라벨을 뺀다(남기면 새 UID와 맞지 않아 dry-run이 거부한다).
- 적용 후 rollout 진행(준비된 새 Pod 수)을 보여준다.
- K7 백엔드는 소유자 UID로 리비전을 고르고 scale·restart·rollout undo·삭제·Job 재실행·CronJob 일시정지와 재개를 수행한다. 삭제 재생성에는 서버가 채운 메타데이터와 상태를 빼며, 새 Job 이름은 미리보기에서 정한다.
- 워크로드 변경 화면: 상세에서 작업을 고르고 미리보기에서 호출·필드 변경·영향·경고를 확인한다. 변경 기록의 되돌리기도 같은 미리보기를 거친다.
- 상세의 rollout 진행은 watch 행의 ready·updated·desired를 이용한다. StatefulSet 행에는 updated 수가 없어 ready 수만 보여 준다.
- rollout undo 리비전 선택은 대상 get과 ReplicaSet 또는 ControllerRevision list 권한도 확인한다.

### B. 노드 조작
- cordon·uncordon: 서로 되돌리기.
- 지금 된 것: Node 상세에서 스케줄 중지·재개를 공통 미리보기와 기록·되돌리기로 수행한다.
- drain: 미리보기에 옮길 Pod, 건너뛸 DaemonSet Pod, emptyDir 손실 경고, 컨트롤러 없는 Pod 경고, PDB로 막힐 Pod. 적용은 cordon → Eviction을 하나씩. 429가 이어지면 5분 뒤 멈추고 이미 옮긴 것은 그대로 둔다. 되돌리기는 uncordon만.
- drain 지금 된 것 (K7 drain):
  - 계획은 순수 함수(`drain::plan_drain`): 노드의 모든 Pod(`spec.nodeName` 필드 선택자)를 옮길 것·건너뛸 것으로 나눈다. DaemonSet이 컨트롤러인 Pod, 미러(static) Pod(`kubernetes.io/config.mirror`), 이미 종료 중인 Pod는 건너뛴다. 끝난(Succeeded·Failed) Pod는 경고 없이 옮긴다. emptyDir 볼륨이 있으면 데이터 손실 경고, 컨트롤러(`controller: true`) 소유자가 없으면 "다시 만들어지지 않음" 경고. 같은 네임스페이스에서 Pod를 고르는(`matchLabels`, `matchExpressions`, 빈 선택자는 전부) PodDisruptionBudget 중 `status.disruptionsAllowed`가 0인 것이 있으면 그 Pod를 "막힐 Pod"로 표시한다. PDB 목록을 읽을 권한이 없으면 알 수 없다는 경고를 낸다.
  - 미리보기는 공통 틀(`k8s_preview`)을 거친다. 이름 입력(노드 이름)은 늘 요구한다. 호출 목록은 cordon PATCH 하나와 Pod마다 Eviction POST이고, 서버 dry-run은 cordon에만 돌린다(Eviction은 Pod마다 호출이 늘고, 막힘은 PDB 상태로 미리 계산해서 보여 준다). 미리보기에는 `drain`(옮길 Pod 표시, 건너뛸 Pod) 필드가 더해진다.
  - 적용은 `k8s_drain(target, node, confirmText, channel)`로만 한다(`k8s_apply`는 drain을 거절). 미리보기한 계획을 꺼내 노드(status 제외)와 옮길 Pod 집합(UID)이 그대로인지, 이름 입력이 맞는지 다시 확인하고 곧바로 번호를 돌려준다. 이후 작업이 cordon → Eviction을 하나씩 보내며 `started`, `cordoned`, `pod`(상태 pending·evicting·terminating·evicted·blocked·lingering·failed와 합계), `finished`(completed·stopped·timedOut·failed·lingering) 메시지를 채널로 흘린다.
  - Eviction은 `exec.rs`의 `evict`만 보낸다. kube의 `evict`는 `deleteOptions`를 잘못된 이름으로 보내 UID 조건이 사라져서 `eviction` 하위 리소스를 직접 만들고, 본문의 UID 조건으로 계획 뒤에 같은 이름으로 다시 만들어진 Pod는 건드리지 않는다. 404·409는 이미 없는 것으로 본다.
  - kube 클라이언트의 기본 재시도(429·503·504를 `Retry-After`만큼 기다리며 최대 15번)는 Eviction 요청에만 끈다. 켜 두면 PDB가 막은 Eviction이 429 대신 몇 분씩 멈춰 있는다(kind에서 확인). 세션은 로그인 PATH를 넣은 kubeconfig를 들고 있다가 drain을 시작할 때 재시도 없는 두 번째 클라이언트(`connect::eviction_client`)를 만들어 `exec::evict`에만 쓴다(exec 플러그인은 그때 한 번 더 돈다). cordon을 포함한 나머지 호출은 기본 재시도를 그대로 쓰므로 큰 클러스터의 API Priority & Fairness 429는 이전처럼 조용히 다시 시도된다.
  - Eviction이 받아들여져도 Pod는 종료 유예 동안 남아 있으므로 바로 옮긴 것으로 세지 않는다. 받아들여진 Pod는 `terminating`으로 두고 그 UID의 Pod가 사라지면(같은 이름으로 다시 생긴 Pod는 사라진 것으로 본다) `evicted`로 센다. 기다림은 다음 Pod의 Eviction을 막지 않고, 한 바퀴가 끝날 때와 쉬는 동안 1초마다 살핀다. 기다림 한도는 Pod의 `terminationGracePeriodSeconds`(없으면 30초)에 여유 30초를 더한 시간이고, 넘으면 `lingering`("종료 지연")으로 표시하고 다음으로 넘어간다. 모두 받아들여졌지만 종료 지연이 남으면 끝 결과는 `lingering`(기록은 실패 + 이유)이다. Pod 읽기에 실패하면 아직 있는 것으로 보고 한도가 끝을 정한다. 사라진 Pod도 429로 막힌 Pod가 있을 때의 "진전"으로 센다. 중단하면 기다리던 Pod는 `terminating`인 채로 끝난다.
  - drain이 받은 노드 이름 입력은 cordon의 확인 문구로도 넘긴다(이름에 `prod`가 든 노드의 cordon이 이름 확인에서 거절되지 않게).
  - 429(PDB)는 막힌 Pod로 두고 다음 Pod를 먼저 하며, 한 바퀴가 끝나면 1초부터 두 배씩(최대 30초) 늘려 가며 다시 시도한다. 어떤 Pod도 옮기지 못한 채 429만 5분 이어지면 멈춘다(`timedOut`). 이미 옮긴 Pod는 그대로 둔다. 다른 Pod를 하나라도 옮기면 5분을 다시 센다. 그 밖의 API 오류는 그 Pod만 `failed`로 두고 계속하며, 권한(401·403)·연결 오류는 계속할 수 없어 바로 멈춘다(`failed`).
  - 중단은 `k8s_unwatch(번호)`: 지금 하는 Eviction을 마치고(기다리는 중이면 바로) 멈춘다. 대상을 닫거나(`k8s_close`) 다시 연결하면 같은 신호로 멈추고 항목을 잊는다(끊지 않으므로 기록은 남는다). 채널을 닫아도 멈춘다. 프론트는 화면을 떠날 때도 중단한다.
  - 기록: cordon을 했으면 cordon 기록(되돌리기 = uncordon)과 drain 기록(`drain: Pod N개 옮김, M개 막힘…`, 끝까지 마친 경우만 성공, 중단·시간 초과·실패는 이유와 함께 실패 기록, 되돌리기 없음)을 남긴다. 미리보기 때 이미 스케줄이 중지된 노드는 cordon을 건너뛰고 기록하지 않으며 되돌릴 것이 없다.
  - 화면: 변경 모드의 Node 상세에 "drain" 버튼(노드 patch와 `pods/eviction` create 권한이 확실히 없으면 이유와 함께 비활성화). 미리보기에 옮길 Pod 표(경고 표시)와 건너뛸 Pod 표를 보이고, 적용하면 진행 창(Pod별 상태, 합계, 중단, 끝나면 요약과 "스케줄 중지는 변경 기록에서 되돌릴 수 있어요")으로 바뀐다.
  - 시험: 계획과 상태 기계는 단위 시험(`drain/tests.rs`, `drain/run/tests.rs`, `drain/apply/tests.rs`, `exec/tests.rs`의 가짜 API 서버로 Eviction 응답 분류와 어느 클라이언트가 재시도하는지, 멈춘 시계로 5분 한도), 화면은 `DrainFlow.test.tsx`, kind 실제 시험은 `drain_moves_pods_off_a_worker_around_a_budget_then_uncordons`(워커 노드, PDB로 막힌 Pod와 보통 Pod, 컨트롤러 없는 emptyDir Pod). `scripts/k8s-live-test.sh`가 컨트롤 플레인 하나와 워커 하나로 kind 클러스터를 만든다.

### C. 셸과 port-forward
- 셸: `kube-rs` `exec`(웹소켓). `/bin/bash`, 없으면 `/bin/sh`. 터미널은 xterm.js, 크기 변경을 전달한다. 열 때 확인, 위험 네임스페이스면 이름 입력. 기록은 열고 닫은 시각과 대상만.
- port-forward: `kube-rs` `portforward`. 로컬은 `127.0.0.1`만, 포트는 자동(직접 지정 가능). Service는 준비된 Pod 하나로, 그 Pod가 사라지면 다른 Pod로 다시 붙는다. 포트포워딩 화면에서 보고 닫는다. 탭을 닫거나 앱을 끄면 모두 닫는다.
- attach(2026-11-02 추가): 컨테이너의 주 프로세스에 붙는다(`kube-rs` `attach`). `stdin`·`tty`가 켜진 컨테이너만 입력을 보낸다(아니면 출력만). 셸과 같은 터미널. "입력·Ctrl-C가 주 프로세스로 간다" 경고와 함께 연다.
- 지금 된 것(2026-11-02, K9 셸·attach·port-forward·노드 셸. 변경 공통 틀에 합쳤다):
  - 백엔드: `k8s/shell.rs`(exec·attach), `k8s/forward.rs`(port-forward). `kube`에 `ws` 기능을 켰다. 세션은 `K8sState`의 `shells`·`forwards`가 쥐고 `k8s_close`(탭 닫기)와 앱 종료(`RunEvent::Exit`)에서 모두 닫는다. 같은 대상을 닫지 않고 다시 열어도(재연결) 옛 세션을 닫는다.
  - 셸: 명령은 `/bin/sh -c '[ -x /bin/bash ] && exec /bin/bash; exec /bin/sh'`(bash가 있으면 bash, 없으면 sh). tty로 열고 크기 변경을 전달한다. 입력은 출력과 다른 작업이 써서 큰 붙여넣기가 출력을 막지 않는다. 출력은 UTF-8 경계를 이어 붙여 글로 보내고, 끝나면 `exit`(종료 코드 또는 사유, 코드 없이 닫히면 연결이 끊긴 것)를 보낸다. 열기 전에 Pod를 읽어 컨테이너가 있고 실행 중인지 본다.
  - attach(`k8s_attach_open`): 컨테이너 설정의 `stdin`·`tty`가 둘 다 켜졌을 때만 입력(`input: true`). tty가 아니면 stderr도 받고, tty면 stdout만(서버가 tty와 stderr 동시 요청을 거절한다). 화면은 "입력·Ctrl-C가 주 프로세스로 간다" 경고를 열기 전 확인과 세션 동안 보여 주고, 입력이 없으면 "출력만 볼 수 있어요"를 보인다.
  - 확인과 위험 판단: 위험한 대상(네임스페이스가 `kube-system`이거나 이름에 `prod`, 또는 객체 이름에 `prod`)은 `confirmText`가 Pod 이름과 같아야 열린다. 판단은 변경 공통 틀의 `change::dangerous`·`confirm_name` 하나다(미리보기의 `confirmName`과 셸 확인이 같은 함수를 쓴다). 화면은 규칙을 따로 갖지 않고 `k8s_shell_confirm_name`으로 입력할 이름을 묻는다.
  - 기록: 셸·attach·노드 셸 세션은 변경 기록(`k8s-changes.jsonl`)에 한 줄(`Operation::Shell { container, mode }`, 대상 Pod, 되돌리기 없음)로 남고 닫을 때 `closedAt`이 채워진다(열고 닫은 시각과 대상만, 입력·출력은 어디에도 없다). 기록을 쓰지 못하면 열지 않는다. 변경 기록 화면이 이 줄을 "닫음 시각"과 함께 보인다(되돌리기 버튼 없음). `k8s-shell.jsonl`은 없앴다.
  - port-forward: 로컬은 `127.0.0.1`만. 로컬 포트를 정하지 않으면 원격과 같은 번호(1024 이상)를 먼저 시도하고 안 되면 운영체제가 고른 포트. 열기 전에 대상을 읽고 웹소켓을 한 번 열어 보고 닫아 권한·연결 오류를 바로 알린다. 로컬 연결이 올 때마다 `pods/portforward`를 하나씩 연다. Service는 셀렉터의 준비된(Ready, 지워지는 중 아님) Pod 중 이름순 첫 Pod에 붙고(붙어 있던 Pod가 아직 준비돼 있으면 옮기지 않는다), Pod를 지켜보다가 그 Pod가 사라지거나 준비가 풀리면 다른 Pod로 옮긴다(이름 있는 `targetPort`는 고른 Pod의 컨테이너 포트 이름으로 푼다). 준비된 Pod가 없으면 연결 하나가 최대 15초 기다린다. TCP 포트만.
  - 화면: Pod 상세에 "셸" 탭(컨테이너 고르기, 셸/attach, 확인 창)과 터미널(xterm.js, 다른 탭을 봐도 세션 유지, Pod를 바꾸거나 세션을 닫으면 끊김)이 늘 보인다. 왼쪽 메뉴 "포트포워딩"은 이 클러스터의 목록(브라우저로 열기, 주소 복사, 종료)이다. 권한은 `pods/exec`·`pods/attach`·`pods/portforward`의 `create`를 내 권한(`can`)으로 보고, 없으면 버튼을 끄고 이유를 보인다.
  - 상세의 포트포워딩 영역(사용자 결정 2026-11-03): Pod·Service 상세의 도구 줄 아래에 따로 여는 버튼 없이 늘 있다. 첫 줄은 `포트포워딩 · 대상 포트(k8s_get의 ports 또는 직접 입력) · 로컬 포트(비우면 자동) · [열기]`, 그 아래에 그 객체의 열린 포트포워딩(Pod 상세는 지금 그 Pod로 이어진 Service 포워드도)을 한 줄씩 `127.0.0.1:로컬 → 대상:포트 · (Service면) 붙은 Pod · 상태`와 [브라우저로 열기]·[주소 복사]·[종료]로 보인다. 목록은 3초마다 다시 읽는다.
  - 계약에 더한 것: `k8s_attach_open`, `k8s_shell_confirm_name(namespace, pod): string | null`, `k8s_node_shell_open(target, namespace, pod, channel): ShellId`, `ShellId = { id, input }`, `K8sForward`의 `target`·`namespace`·`kind`·`name`·`remotePort`·`pod`·`error`, `k8s_get` 결과의 `ports`(Pod는 컨테이너 포트, Service는 Service 포트와 `target`), 변경 종류 `shell`(기록 전용)·`nodeShell`, 변경 기록 `closedAt`.
  - 노드 셸(구현): Node 상세의 "노드 셸" 버튼(이미지 입력칸, 기본 `busybox:1.36`, 권한은 pods create와 pods/exec)이 변경 틀의 `nodeShell` 변경을 시작한다. 대상은 만들 Pod(`mm-node-shell-<시각>`, 고른 네임스페이스, 모든 네임스페이스면 `default`), 노드는 변경의 `node`. 미리보기는 `POST /api/v1/namespaces/<ns>/pods`와 본문(`nodeName`, `hostPID`·`hostNetwork`·`hostIPC`, privileged, 노드 루트를 `/host`에 마운트, 모든 taint 허용, 8시간 `activeDeadlineSeconds`와 `terminationGracePeriodSeconds: 0`)과 경고를 보이고, 입력할 이름은 늘 노드 이름이다. 서버 dry-run을 거치고(Pod 보안 정책이 막으면 미리보기에서 실패) 적용은 변경 기록에 남는다. 적용이 끝나면 노드 상세가 `k8s_node_shell_open`으로 Pod의 `shell` 컨테이너가 실행될 때까지(최대 60초) 기다렸다가 `nsenter -t 1 -m -u -i -n -p -- sh`로 들어간다. 적용이 성공하는 즉시 백엔드가 만든 Pod의 UID를 읽어 세션 상태(`NodeShells`)에 등록하고, `k8s_node_shell_open`은 그 대상에서 등록한 Pod(이름과 UID가 모두 같은 것)만 한 번 연다(표시가 같아도 YAML 적용 등으로 만든 Pod는 거부). 등록한 Pod는 터미널이 가져가기 전에 탭을 닫거나 앱을 끄거나 적용 기록 쓰기가 실패해도 지운다(지우기는 UID가 같은 Pod만). 열지 못하거나 세션이 끝나거나(셸 종료, 세션 닫기, 탭 닫기, 앱 종료) 하면 같은 변경 틀(미리보기·재확인·`exec.rs`)로 Pod를 지우고 그 지우기도 변경 기록에 남긴다(앱 종료는 최대 10초 기다린다). 끝난 노드 셸은 "다시 열기"가 없다.
  - 남은 것: 없음(K9 범위).
- 노드 셸(2026-11-02 추가, `kubectl debug node`와 같은 방식): 그 노드에 고정한(`nodeName`) 디버그 Pod를 만든다. `hostPID`·`hostNetwork`·`hostIPC`, `privileged`, 노드 루트를 `/host`에 마운트, 이미지는 미리보기에서 고칠 수 있는 기본값(busybox), 명령은 `nsenter -t 1 -m -u -i -n -p -- sh`. Pod 만들기는 변경 공통 틀(미리보기·이름 입력 필수·기록)을 거치고, 셸을 닫으면 Pod를 지운다(지우기도 기록). 네임스페이스는 고른 네임스페이스, 모든 네임스페이스면 `default`.

### D. 권한 변경
- RBAC: 바인딩 추가·제거, 바인딩의 주체 추가·빼기. 권한 표에서 셀로 담는 장바구니(최대 50), 한 번에 미리보기. 미리보기는 실효 권한 계산기로 "누가 무엇을 얻고 잃는지". 적용은 하나씩, 첫 실패에서 멈추고 이미 적용한 것은 되돌리기를 제안한다(IAM 할당 표와 같다). 제거는 원래 객체 전체를 기록해 되돌릴 때 다시 만든다.
- access entry: 생성, 삭제, k8s 그룹 변경, access policy 연결·해제(범위 포함). EKS API로. 되돌리기도 EKS API로.
- aws-auth는 전용 편집을 두지 않는다. E로 고치면 "access entry로 옮기세요" 경고.
- 지금 된 것 (2026-11-04, K8 D): 백엔드 `k8s/rbac/`(`plan` 바인딩 계획, `eks` access entry 계획, `world` 상태와 `Planner`, `assess` 영향·위험, `commit` 읽기·dry-run·재확인·적용)와 `exec/eks.rs`(EKS 쓰기는 여기서만, hygiene이 지킨다). 변경 종류 `bindingCreate`·`bindingSubjects`·`accessEntryCreate|Delete|Groups`·`accessPolicyAssociate|Disassociate`, 바인딩 삭제는 공통 `delete`(되돌리기 = 지운 원본으로 `bindingCreate`). 미리보기에 `effect`(실효 권한 엔진 `access::diff`가 본 누가 무엇을 얻고 잃는지, 권한 상승 주체, 앱 신원의 손실)가 붙는다.
  - 이름 입력: cluster-admin 바인딩, 권한 상승 경로를 새로 얻는 주체(엔진 권한 표의 "권한 상승" 칸이 직접 경로로 바뀜), `kube-system`·`prod`, 앱의 현재 신원(SelfSubjectReview → 신원 매핑, 없으면 사용자·그룹으로 만든 주체)이 권한을 잃음, `AmazonEKSClusterAdminPolicy`, 영향을 끝까지 계산하지 못함(RBAC·access entry·aws-auth를 읽지 못함). access entry는 ARN 마지막 마디를 입력한다.
  - 장바구니(최대 50, 대상마다, 화면을 옮겨도 남음): 권한 표 칸 상세의 "권한 바꾸기"와 바인딩 상세 도구에서 담고, 막대의 [한 번에 미리보기]가 `k8s_preview_batch`로 변경을 앞 변경이 적용된 상태에서 차례로 계획(항목별 호출·차이·영향 + 전체 영향)한다. 적용은 `k8s_apply_batch`: 전체를 다시 계획해 미리보기와 다르면 아무것도 적용하지 않고, 같으면 하나씩 리소스 버전 조건으로 적용하다 첫 실패에서 멈춘다. 적용한 것은 변경 기록의 되돌리기로 거꾸로 되돌리는 미리보기를 연다. 장바구니는 RBAC 변경만 받는다(access entry는 하나씩).
  - 신원 탭에서 access entry 만들기·그룹 변경·정책 연결·해제·삭제. EKS 권한은 미리 확인하지 못해 단추는 인증 모드가 `CONFIG_MAP`일 때만 끄고 API 오류를 그대로 보인다. 정책 연결이 실패하면 방금 만든 entry는 지운다. aws-auth 행에는 "access entry로 옮기세요"를 보이고 YAML 편집 경고(`AWS_AUTH_WARNING`)는 그대로다.
  - 시험: 순수 계획·위험·영향·되돌리기와 가짜 쿠버네티스·EKS(`rbac/mock_kube.rs`, `mock_eks.rs`)로 미리보기·적용·재확인·일괄·중간 실패·되돌리기, kind(`k8s::live_tests::rbac`, `scripts/k8s-live/rbac.sh`).

### E. YAML 편집과 적용
- 편집기: CodeMirror 6(YAML 모드, 문법 검사). `status`, `managedFields`, `metadata.uid`, `resourceVersion`, `creationTimestamp`, `generation`은 빼고 보여준다.
- 새로 만들기: 붙여 넣은 YAML(문서 여러 개 가능)을 각각 미리보기.
- 미리보기: server-side apply dry-run 결과와 현재 객체의 diff. field manager `magic-mirror`. 충돌이면 필드와 소유 manager를 보여주고, 강제 적용(`force`)은 이름 입력을 받는다.
- 되돌리기: 적용 전 객체(정리한 형태)를 기록하고 다시 적용. 새로 만든 리소스는 삭제.
- Secret: 값은 가린 채 시작, 키별 "값 보기" 후 편집 또는 새 값 입력. 기록에 Secret 값을 남기지 않으므로 Secret 변경은 "되돌릴 수 없음".
- 지금 된 것(2026-11-02):
  - 변경 종류 `apply { object, force }`(`Operation::Apply`). 본문은 `change/apply.rs`가 만든다: 서버가 채우는 필드를 빼고, 이름·종류를 대상과 맞추고(다르면 거절), 네임스페이스가 없으면 대상의 것을 넣고, 있는 객체면 미리보기 직전에 읽은 `resourceVersion`을 조건으로 건다(없는 객체는 조건 없이 만든다). 호출은 `PATCH …?fieldManager=magic-mirror[&force=true]`(apply-patch). 필드 이름 충돌이 아닌 409는 기존 "미리보기 이후 바뀌었어요"다.
  - 미리보기: 서버 dry-run 결과(서버가 만든 객체)와 현재 객체를 정리해 필드마다 비교한다(`spec.template.spec.containers[0].image` 꼴 경로, 길이가 다른 배열은 통째로). 새로 만들면 객체 전체가 한 항목. 바뀌는 것이 없으면 경고. 충돌은 서버 오류의 `FieldManagerConflict` 원인에서 필드와 소유 manager를 꺼내 `Preview.conflicts`로 보여 주고, 충돌이 있는 미리보기는 적용되지 않는다(화면의 [적용]은 막힘 경고로 꺼지고 백엔드 `check`도 거절). [강제 적용으로 다시 미리보기]가 `force: true` 변경으로 다시 미리보기 하며, 강제 적용은 이름 입력을 받는다(위험한 변경과 같은 게이트). 서버가 객체를 받지 않으면(400·422) Secret이 아닌 객체는 서버의 이유를 그대로 보여 준다.
  - 이름 입력: `roleRef`가 `cluster-admin` ClusterRole인 RoleBinding·ClusterRoleBinding을 만들거나(되살리기 포함) 그런 바인딩의 subjects를 고치면 대상 이름을 입력받는다. 그 밖의 권한 상승 경로(bind·escalate·impersonate 등) 판단은 K4 몫이다.
  - 되돌리기: 있던 객체는 정리한 이전 객체를 `apply`로 다시 적용(`force: false`), 새로 만든 객체는 삭제. 둘 다 기록의 역변경이며 되돌리기 미리보기를 거친다. `aws-auth` ConfigMap은 "access entry로 옮기세요" 경고.
  - 상세 YAML 탭: 변경 모드에서 [편집]이 읽기 전용 YAML을 CodeMirror 6 편집기로 바꾼다(`@codemirror/*`, 구문 오류는 `yaml` 패키지로 찾아 줄 밑줄과 목록으로 보이고 미리보기를 막는다). 편집기에 들어가는 글은 백엔드가 만든 `editYaml`(서버 필드를 뺀 것). 종류·이름·네임스페이스를 바꾸거나 문서가 둘이면 미리보기 전에 거절한다. patch 권한이 없으면 이유와 함께 끈다.
  - Secret: 편집 글에는 `data`·`stringData`·last-applied가 없다. 키별 [값 보기](읽은 값은 컴포넌트 상태에만)로 읽어 고치거나 [새 값 입력]·키 추가로 `stringData`에 넣고, 건드리지 않은 키는 가린 값(••••)으로 보내 백엔드가 현재 값으로 되돌려 놓는다. 바이너리 값은 새 값 입력으로만 바꾼다. 미리보기의 본문·diff에는 값이 없고(바뀐 키만 `•••• (바뀜)`), 기록에는 `data`·`stringData`를 모두 가린 변경만 남으며, 되돌릴 수 없다는 경고를 보인다.
  - 상단 [YAML로 만들기](변경 모드): 붙여 넣은 글을 문서마다 `apply` 변경으로 바꾼다(종류는 클러스터가 내주는 종류에서 apiVersion·kind로 찾고, 네임스페이스가 없는 문서는 고른 네임스페이스로, 모든 네임스페이스면 그 문서의 오류). 최대 50개. 문서별 미리보기(호출·diff·경고·이름 입력)를 한 창에 보이고, 순서대로 적용하다 첫 실패에서 멈추고 나머지는 건너뛴 뒤 [적용한 것 되돌리기]로 거꾸로 되돌리기 미리보기를 연다. 미리보기가 되지 않는 문서(앞 문서가 만드는 네임스페이스 안의 객체 등) 앞까지만 먼저 적용하고 나머지를 다시 미리보기 한다. 별도 배치 명령(`k8s_preview_batch`/`k8s_apply_batch`) 없이 문서마다 `k8s_preview`/`k8s_apply`를 쓰므로 기록도 문서마다 하나이고 변경 기록 화면에서 하나씩 되돌릴 수도 있다.

### Helm
릴리스 읽기와 변경(2026-11-03). 왼쪽 메뉴 "⎈ Helm". 읽기는 helm CLI 없이 앱이 직접 하고, 변경만 helm CLI로 한다. 변경은 변경 공통 틀(미리보기 → 이름 입력 → 재확인 → 적용 → 기록 → 되돌리기)을 그대로 거친다.

- **읽기(kube로, helm 불필요)**: helm은 릴리스를 Secret(`type: helm.sh/release.v1`, 라벨 `owner=helm`·`name`·`version`·`status`)으로 저장한다. `data.release`는 쿠버네티스 base64 → helm base64 → gzip → JSON 순(kind에서 helm v4로 확인)이고 앱이 그대로 푼다(`flate2`; 풀린 크기는 64MiB로 제한). ConfigMap 드라이버(`HELM_DRIVER=configmap`)도 함께 읽는다(같은 리비전이 둘 다 있으면 Secret). 한쪽을 읽을 권한이 없으면 다른 쪽만 쓰고, 둘 다 없으면 권한 오류다.
  - 목록: 먼저 메타데이터만(`list_metadata`, 라벨로 이름·리비전·상태) 받아 릴리스마다 가장 높은 리비전을 고르고 그 데이터만 가져와 푼다(동시 8개). 푼 요약은 저장소 객체의 uid·resourceVersion을 키로 기억해 10초 폴링 때 다시 받지 않는다. 풀지 못하는 데이터는 오류가 아니라 라벨 값만 있는 줄(`unreadable`)이 된다. 선택한 네임스페이스만, 모두면 전체.
  - 상세: 지금 보는 리비전(기본 최신)의 요약, 사용자 values(`config`, 있는 그대로), 계산된 values(차트 기본값 + 사용자 값, null은 키 삭제, 서브차트는 부모 값 아래 이름으로 합침: `helm get values --all`과 같음을 kind에서 확인), notes, manifest, manifest에서 뽑은 리소스(종류·이름·네임스페이스), 훅, 선언된 의존 차트, 모든 리비전의 이력(상태·갱신·차트·앱 버전·설명).
  - manifest는 `---`로 나눠 객체로 읽고(`kind: List`는 펼침) 화면에는 Secret의 값을 가려 보인다(원문 주석은 유지). values는 사용자가 준 값이라 있는 그대로 보인다.
  - 상태 배지: deployed(초록), superseded·uninstalled(흐림), failed·unknown(빨강), pending-*·uninstalling(노랑). 문제(failed·unknown·uninstalling·pending-*)는 목록 위 "문제 N" 칩과 "문제 있는 것만" 거르기로 바로 본다.
- **화면**: 목록은 `ListTable`(이름·네임스페이스(전체일 때만)·상태·차트·앱 버전·리비전·갱신·설명), 이름·차트·네임스페이스·상태 거르기. 10초마다(탭이 보일 때만) 다시 읽고, Helm 변경을 적용하면 바로 다시 읽는다. 행을 누르면 목록 너비의 70%를 덮는 상세(`.k8s-detail`)가 열린다. 탭: 요약(릴리스·차트·리소스·훅·의존 차트), values(준 값 / 계산된 값), 매니페스트, 이력, notes. 리소스는 이 클러스터가 내주는 종류(discovery)면 이름을 눌러 워크로드 화면에서 연다(네임스페이스가 없으면 릴리스의 네임스페이스). 모르는 종류(CRD 없음)는 글로 둔다. 이력 줄은 [보기](옛 리비전을 읽기 전용으로, 위에 안내와 [최신으로])와 [이 리비전으로 롤백]. 위쪽 오른쪽 도구 모음: `[이력 남기기] [업그레이드] [롤백] [삭제]`(삭제가 맨 오른쪽), 목록 위에 [차트 설치]. 옛 리비전을 보는 동안은 변경 단추를 이유와 함께 끈다.
- **helm 찾기**: 로그인 셸의 PATH(exec 플러그인과 같은 `k8s::path::login_path`)에서 실행 가능한 `helm`을 찾고 `helm version`으로 버전을 읽는다. 없거나 3.13 미만(서버 dry-run 없음)이면 변경 단추(업그레이드·롤백·삭제·설치)는 꺼지고 `title`·`aria-description`에 이유(설치 안내)를 보인다. 읽기는 helm이 없어도 된다. 권한은 릴리스 저장소(Secret, ConfigMap 드라이버면 ConfigMap)의 `create`(업그레이드·롤백)·`delete`(삭제)를 내 권한(`can`)으로 보고, 확실히 없을 때만 끈다.
- **helm 실행(`k8s/helm/run.rs`가 프로세스를 띄우는 유일한 곳)**: 인자는 셸을 거치지 않는 배열이고 세션의 `--kube-context`와 `--kubeconfig`(읽은 kubeconfig가 하나일 때, 여럿이면 `KUBECONFIG` 환경 변수)를 넘긴다. `HELM_DRIVER`는 릴리스를 읽은 저장소로 늘 정해 주고, 사용자 셸에서 물려받은 `HELM_KUBE*`·`HELM_NAMESPACE`·`KUBECONFIG`·`HELM_DRIVER`는 치워 다른 클러스터로 새지 않게 한다. 릴리스 이름(DNS 소문자 53자)·네임스페이스·차트·저장소(http(s), 사용자 정보 없음)·버전은 `-`로 시작하거나 공백이 있으면 거절한다. 시간 제한: 미리보기 3분, 적용 10분. helm의 stderr는 SSO 만료는 앱의 SSO 오류로, 클러스터 연결 실패는 연결 안내로, 나머지는 첫 줄 몇 개(토큰은 가림, 400자)로 보인다.
- **변경 종류**(`Operation`에 더함, 대상은 릴리스 `helm.sh/Release`): `helmUpgrade { values, chart }`, `helmRollback { revision }`, `helmUninstall { keepHistory }`, `helmInstall { chart, values, createNamespace }`. 차트는 `{ reference, repo, version }`: 로컬 경로(절대 경로, `~/`), `oci://…`, 저장소의 차트 이름(저장소 주소와 함께, 또는 이미 helm에 등록한 `repo/chart`). 상대 경로는 받지 않는다(helm의 작업 폴더가 정해져 있지 않다).
  - 업그레이드: 저장된 릴리스 JSON에서 차트(Chart.yaml, values.yaml, values.schema.json, templates, files·crds, 서브차트는 `charts/<이름>/`)를 임시 폴더에 되살려 저장소 접속 없이 같은 차트로 `helm upgrade --reset-values -f values.yaml`을 한다(편집한 글이 사용자 values 전체가 되므로 키를 지우는 편집도 반영된다; 저장된 서브차트는 이미 조건·별칭이 적용된 것이라 Chart.yaml의 `dependencies`는 뺀다. 파일 이름이 폴더 밖을 가리키면 거절). "다른 차트로"는 위 차트 위치로 같은 명령을 한다.
  - 미리보기: 업그레이드·설치는 `helm … --dry-run=server -o json`으로 렌더링한 새 manifest를 현재 manifest와 객체별로(그룹·종류·네임스페이스·이름으로 짝지음, apiVersion만 올라가면 한 객체의 변경) 견줘 `Deployment web · spec.replicas` 꼴 필드 항목(새 객체·지워지는 객체는 객체 전체 한 항목)과 `values · replicaCount` 꼴 values 차이를 보인다. Secret은 값 없이 바뀐 키만(`••••`, `•••• (바뀜)`). 롤백은 helm을 부르지 않고 현재 리비전과 그 리비전의 manifest·values를 견준다(삭제돼 이력만 남은 릴리스를 같은 리비전으로 되살리는 것도 롤백이고 모든 객체가 새로 생긴다). 삭제는 지워질 객체 전체를 보인다. 경고: 바뀌는 것 없음, 빠지는 객체 수, 훅(`pre/post-upgrade` 등) 개수, failed·pending 상태, `helm.sh/resource-policy: keep`으로 남는 객체, 삭제는 되돌릴 수 없음(이력을 지울 때).
  - 이름 입력: 삭제는 늘 릴리스 이름. 그 밖에는 공통 규칙(`change::dangerous`: 네임스페이스가 `kube-system`이거나 네임스페이스·릴리스 이름에 `prod`).
  - 재확인: 적용 직전에 같은 계획을 다시 만들어(서버 dry-run 포함) 미리보기를 본 릴리스와 같은지(리비전 번호와, 리비전·상태·manifest·사용자 values의 해시. 설치는 "릴리스 없음") 확인하고 다르면 "미리보기 이후 바뀌었어요"로 멈춘다. 이름 입력은 백엔드가 다시 확인한다. 렌더링 결과가 매번 달라지는 차트(`randAlphaNum` 등)를 위해 해시는 렌더링 결과가 아니라 현재 릴리스 상태만 쓴다.
  - 되돌리기(기록의 역변경, 같은 미리보기를 거친다): 업그레이드·롤백 → 업그레이드 직전 리비전으로 롤백(롤백으로 되살린 경우는 다시 삭제(이력 유지)), 설치 → 삭제(만든 네임스페이스는 남는다는 경고), 삭제 → 이력을 남겼으면 롤백으로 되살리기, 남기지 않았으면 되돌릴 수 없음.
  - 기록: `k8s-changes.jsonl`에 변경 한 줄(요약 = 미리보기의 영향 문장)을 남기되 **values는 기록하지 않는다**(`change::apply::redact`가 `helmUpgrade`·`helmInstall`의 values를 비운다). 되돌리기용 역변경에는 values가 없다. 오류 글에는 values 조각이 실릴 수 있는 YAML 해석 오류를 넣지 않고 고정 문구만 쓴다.
- **hygiene 예외(의도적)**: 클러스터 쓰기가 kube 호출이 아니라 helm 프로세스로 나가므로 `k8s::hygiene`에 규칙을 더했다. ① `Command::new(`(프로세스 실행)는 로그인 셸의 PATH를 읽는 `k8s/path.rs`와 helm을 실행하는 `k8s/helm/run.rs`에만 있다. ② 클러스터를 바꾸는 helm 하위 명령 이름(`"upgrade"`·`"install"`·`"uninstall"`·`"rollback"`)은 인자를 만드는 `k8s/helm/cli.rs`에만 있다. 읽기 모듈(`read`·`release`·`detail`·`manifest`)과 `k8s_helm_commands.rs`는 kube 쓰기 호출을 쓰지 않으며 같은 스캔을 받는다(`live_tests/` 아래 파일은 시험 전용이라 스캔하지 않는다).
- **명령**: `k8s_helm_tool()`, `k8s_helm_releases(target, namespace | null)`, `k8s_helm_release(target, namespace, name, revision | null)`, `k8s_helm_show_values(chart)`(설치 창의 "차트 기본값 불러오기", 클러스터에 닿지 않음). 변경은 `k8s_preview`/`k8s_apply`가 `Operation::Helm*`를 `k8s::helm::plan`으로 보낸다. `Session`에 읽은 kubeconfig 경로 목록(`kubeconfig_paths`)을 더했다. 프론트 `src/k8s/helm/`.
- **시험**: 순수 부분은 단위 시험(릴리스 해석·계산된 값·압축 폭탄, manifest 나누기·객체별 차이·Secret 가리기, 명령 인자·차트 위치 검증, helm 찾기·버전·환경 변수·시간 제한·오류 분류, 차트 되살리기와 경로 탈출 거절, 계획·재확인·values 비기록, 가짜 API 서버로 목록·ConfigMap 드라이버·권한·쪽 넘기기·캐시). 화면은 `src/k8s/helm/*.test.tsx`(목록·거르기·문제·상세·도구 모음 권한·helm 없음·리소스 열기·이력·변경 틀 미리보기·이름 입력·기록 되돌리기). kind 실제 시험은 `k8s::live_tests::helm`(`scripts/k8s-live/helm.sh`가 로컬 차트로 `flow`(리비전 둘)·`broken`(failed)·`cmrel`(ConfigMap 드라이버)을 helm으로 설치하고 로컬 차트 저장소를 띄운다): 목록·상세·이력을 helm 출력과 대조, 업그레이드(미리보기 뒤 외부 변경이면 낡음) → 기록(values 없음) → 되돌리기 → 롤백 → 삭제(이름 확인)를 helm·kubectl로 확인, 이력 유지 삭제와 롤백 복구, 로컬 경로·저장소 ref 설치와 저장소 차트로 업그레이드.
- 남은 것·알려진 한계: Chart.yaml의 의존성 조건(`condition`·`tags`)은 저장된 서브차트를 그대로 쓰므로 values 편집으로 켜고 끌 수 없다(다른 차트로 업그레이드하면 된다). 로컬 경로 설치에서 의존 차트를 받지 않은 차트는 helm이 거절한 이유가 미리보기 오류로 보인다. 앱이 직접 `--wait`·`--atomic`은 쓰지 않는다(적용은 helm이 리소스를 제출하면 끝나고, 롤아웃 진행은 워크로드 상세에서 본다).

### 탐색: `:` 이동과 한 글자 키 (k9s식, 2026-11-04)
키보드만으로 종류·메뉴를 오가고 고른 행에 동작을 거는 부분이다. 모든 키는 키맵 레지스트리를 지나고(`keybindings.ts` 표 + `useCommand`, 설계: `2026-11-04-keymap-design.md`), 화면 코드는 `src/k8s/nav/`에 있다.

- **종류 별칭(`k8s_kinds`)**: API 서버가 알려 주는 `shortNames`(`po`, `deploy`, `svc`)와 단수 이름(`singularName`)을 `K8sKind`에 더했다(`shortNames: string[]`, `singularName: string`). 집계 discovery(`/api`, `/apis`, 1.26+)의 `shortNames`·`singularResource`를 그룹마다 권장(맨 앞) 버전에서 읽고(`read/kinds.rs::discover_names`), kube의 `Discovery`가 버리는 값이라 같은 두 요청을 따로 한 번 더 보낸다(종류 읽기와 `join`). 별칭은 있으면 좋은 정보라서 이 요청이 실패·시간 초과여도 종류 목록은 그대로 나가고 별칭만 빈다.
- **이름 풀이(`nav/aliases.ts`)**: `:` 뒤 이름 하나를 대소문자 없이 복수형·단수형·Kind·짧은 이름·그룹을 붙인 이름(`deployments.apps`, `widgets.v1.acme.io`)과 견준다. 서버가 주지 않는 k9s 별칭(`sec`, `dp`, `ro`·`rb`·`cr`·`crb` 등)만 표(`EXTRA`)로 더하고, 종류 목록을 아직 못 읽었으면 내장 종류가 이 표로 열린다. 같은 이름이 여럿이면 코어 그룹 > 내장 그룹 > 사용자 정의 순으로 이기고, 같은 우선순위에서 둘 이상(서로 다른 사용자 정의 그룹의 `wd`)이면 고르지 않고 어느 그룹들인지 보이며 "복수형.그룹으로 적어요"라고 한다. 모르는 이름은 퍼지(없으면 편집 거리 2 이내)로 가까운 이름을 곁들여 입력줄 아래 오류로 보인다.
- **`:` 명령 줄(`k8s.goto`, `nav/GotoBar.tsx`)**: EKS 탭이 연결돼 있고 입력칸·터미널·대화상자에 커서가 없을 때 `:`로 탭 맨 위에 한 줄 입력줄이 열린다. 치는 대로 메뉴·종류 후보(퍼지, 최대 8개, 이름이 같은 메뉴와 종류는 메뉴 하나)와 대표 이름·그룹·다른 이름을 보이고, `Tab`·`⇧Tab`이 후보를 입력줄에 채워 돌고, `Enter`가 이동하고, `Esc`·✕·커서가 줄 밖으로 가면 닫는다(Esc는 원래 있던 자리로, 이동했으면 새 목록으로 커서를 돌린다). 정확히 맞는 이름만 이동하고 `de` 같은 일부는 짐작해서 가지 않는다(Tab으로 채워야 한다).
  - 종류: 메뉴를 워크로드(All)로 바꾸고 그 종류의 목록을 연다(왼쪽 종류 트리에서 선택됨, 열려 있던 상세는 닫힘). 북마크 화면에서도 같은 길이다. 메뉴 항목을 직접 누르면 `:`가 고른 종류는 잊고 기본 종류(Pod)부터 시작한다.
  - 메뉴: `overview`·`workloads`(all)·`events`(ev)·`network`(net)·`forwards`(pf)·`helm`·`permissions`(내 권한)·`access`·`security`·`changes`. 종류 별칭과 겹치는 이름(`events`)은 메뉴가 이긴다. ArgoCD·Argo Workflows는 EKS 탭 화면이 아니라서 넣지 않았다.
  - 네임스페이스: `ns <이름>`(`namespace <이름>`)은 위쪽 네임스페이스 선택을 바꾸고(후보는 네임스페이스 watch가 아는 이름, `ns all`은 모든 네임스페이스), 없는 이름은 가까운 이름과 함께 거절한다. 인자 없는 `:ns`는 Namespace 종류 목록으로 간다(`ns`가 그 종류의 짧은 이름).
  - 기록: 실행에 성공한 명령은 브라우저 저장소(`mm.k8s.goto-history`, 최근 20개, 같은 명령은 하나)에 남고, 빈 입력줄에 "최근 명령"으로 보이며 `↑`·`↓`이 기록을 오간다(`↓`로 치던 글자까지 돌아온다). 실패한 명령은 남기지 않는다.
- **한 글자 키**(표: 키맵 설계 "EKS 목록의 k9s식 한 글자 키"): 목록 상자(`.k8s-list-pane`) 안에 커서가 있고 입력칸·터미널·대화상자가 아닐 때만 레지스트리가 보낸다(`when: k8sListFocus && !inputFocus && !terminalFocus && !dialogOpen`). 숨은 탭은 host 규칙으로 받지 않는다. 키는 상세 도구 줄의 **단추를 누르는 것**으로 일한다(`nav/rowKeys.ts`: 상세 안의 `data-tab`·`data-k8s-action` 단추를 찾아 `click()`). 그래서 종류별 적용 여부·권한(`can`)·상태(cordon 여부)·미리보기부터 여는 변경 틀이 단추와 같은 하나의 규칙이다.
  - `j`·`k`·`g`·`G`(`ListTable`의 `vimKeys`, 목록 컴포넌트가 직접 처리: 워크로드·Helm·네트워크 로드밸런서·정책·보안 점검 목록), `/`는 ⌘F와 같다(EKS 본문 어디서나).
  - `y` YAML 탭, `d` describe 탭(상세가 `data-tab="describe"` 탭을 내줄 때; 없으면 "이 상세에는 describe 보기가 없어요"), `e` YAML 편집(편집 단추), `l` 로그 탭(Pod·워크로드), `s` Pod는 셸 탭(방식 칸을 "셸"로) / Deployment·StatefulSet은 복제본 수 칸으로 커서를 옮기고 Enter로 scale 미리보기, `a` 셸 탭에서 방식을 attach로(세션은 평소처럼 확인 단계를 거쳐 연다), `⇧F` Pod·Service의 포트포워딩 줄(대상 포트 칸)로 커서, `r` rollout restart 미리보기(Deployment·StatefulSet·DaemonSet), `c`·`u` 노드 cordon·uncordon 미리보기(이미 그 상태면 안내만), `⌃D` 삭제 미리보기(모든 종류), `0` 모든 네임스페이스(네임스페이스가 있는 종류에서만).
  - 하지 못하면 아무것도 하지 않고 목록 아래 상태 줄(`role="status"`, 4초 뒤 사라짐·✕로 닫음)에 이유를 보인다: 행을 아직 안 골랐다, 상세를 읽는 중이다, 이 종류에서는 쓸 수 없다(키마다 맞는 종류를 문장으로), 권한이 없다(단추의 `title`과 같은 문구), 이미 cordon된 노드·이미 모든 네임스페이스.
  - 바꾸는 키는 어떤 것도 바로 적용하지 않는다. scale은 숫자를 고친 뒤 Enter(단추를 누른 것과 같다), 나머지는 단추를 누른 것과 같이 미리보기 창이 뜬다.
- **지금 되지 않는 것**: 접근 탭의 표(신원·권한 표·누가 할 수 있나·워크로드 신원)와 이벤트·포트포워딩·변경 기록 표는 `ListTable`이 아니라서 `j`·`k`·`g`·`G`가 없다(⌘F·`/`는 된다). `d`는 describe 탭이 이 브랜치에 들어와야 동작한다.

## 계약 (Tauri 명령)
```ts
type K8sTarget = { profile: string; region: string; cluster: string };
k8s_open(target, context: string | null): K8sSession          // context 찾기·접속·신원. 후보가 여럿이면 후보를 돌려준다
k8s_close(target): void
k8s_overview(target): K8sOverview
k8s_kinds(target): K8sKind[]                                    // API discovery(+ shortNames·singularName)
k8s_list(target, kind, namespace: string | null, selector: string | null): K8sList
k8s_watch(target, kind, namespace, channel): WatchId            // 변경분을 채널로
k8s_unwatch(watchId): void
k8s_get(target, kind, namespace, name): K8sObjectView           // 상세, 소유 관계, 이벤트, 정리된 YAML(Secret 값 가림)
k8s_secret_value(target, namespace, name, key): string
k8s_events(target, namespace | null): K8sEvent[]
k8s_logs(target, namespace, pod, options, onEvent): StreamId
k8s_workload_logs(target, kind, namespace, name, options, onEvent): StreamId
k8s_logs_save(fileName, text): string                          // 저장된 절대 경로
k8s_unwatch(watchId): void
k8s_access(target, force: boolean): AccessView                 // 신원 매핑(access entry·aws-auth), 인증 모드, 주체 수, 읽지 못한 부분(gaps). 계산 결과는 대상별 캐시
k8s_access_matrix(target, MatrixQuery): MatrixPage             // 권한 표 한 쪽: 종류·이름 필터, 열(네임스페이스), offset·limit. 칸은 주체마다 열당 7개(0·1·2)
k8s_access_cell(target, subject, cell, namespace | null): CellDetail  // 칸의 확인한 동작별 허용 여부와 바인딩 경로
k8s_who_can(target, Query): WhoCanView                         // { entries: { subject, grants }[], total }
k8s_review(target, Query, subject): ReviewResult               // SubjectAccessReview 대조 { allowed, denied, reason }
k8s_workload_identity(target): WorkloadView                    // ServiceAccount별 IRSA·Pod Identity·Pod와 신뢰 정책 확인, gaps
k8s_findings(target): SecurityReport                              // 점검 결과 한 장(findings, skipped, gaps). 항목 켜고 끄기는 화면이 거른다
k8s_network(target): K8sNetworkView
k8s_preview(target, K8sChange): K8sPreview
k8s_apply(target, K8sChange, confirmText | null, undoOf | null): K8sApplyResult
k8s_preview_batch(target, K8sChange[]): K8sBatchPreview        // E(YAML 만들기)는 쓰지 않는다: 문서마다 k8s_preview/k8s_apply. D(RBAC 장바구니)용
k8s_apply_batch(target, K8sChange[], confirmText | null, undoOf: string[] | null): K8sBatchResult
k8s_drain(target, node, confirmText, channel): StreamId        // 진행 상황을 채널로. 중단은 k8s_unwatch(streamId)
k8s_shell_open(target, namespace, pod, container, confirmText | null, channel): ShellId   // ShellId = { id, input }
k8s_attach_open(target, namespace, pod, container, confirmText | null, channel): ShellId  // 셸과 같은 채널·입력·크기·닫기. 입력은 컨테이너에 stdin·tty가 켜져 있을 때만(input)
k8s_shell_input(shellId, data: string): void
k8s_shell_resize(shellId, cols, rows): void
k8s_shell_close(shellId): void
k8s_shell_confirm_name(namespace, pod): string | null            // 위험하지 않으면 null. 셸·attach 확인 창이 입력칸을 둘지 정한다
k8s_node_shell_open(target, namespace, pod, channel): ShellId    // 변경 틀로 만든 노드 셸 Pod에 들어간다. 닫으면 Pod를 지운다
k8s_forward_open(target, K8sForwardRequest): K8sForward        // { id, localPort, target, namespace, kind, name, remotePort, pod, error }
k8s_forward_list(): K8sForward[]                                // 모든 탭의 것. pod(지금 붙은 Pod)와 error(최근 실패)는 지금 값
k8s_forward_close(id): void
k8s_change_log(): K8sChangeLogEntry[]
k8s_undo(logId): K8sUndo
k8s_undo_batch(batchId): K8sUndo
```
- 세부 타입은 각 단계의 구현 계획에서 정하고, 필드는 더하기만 한다.
- 스트림(watch, 로그, drain, 셸)은 Tauri `Channel`로 보낸다.
- Secret 값, 토큰, 셸 입력·출력은 기록·오류·로그에 넣지 않는다.

## 구조
- 의존성: `kube`(features `client`, `config`, `runtime`, `ws`, `rustls-tls`), `k8s-openapi`(EKS 지원 범위 중 가장 낮은 버전 feature), `serde_yaml`. 프론트 `@xterm/xterm`, `@codemirror/*`(YAML).
- 백엔드 `src-tauri/src/k8s/`
  - `connect.rs`: kubeconfig 읽기, context 찾기, PATH, `kube::Client`, 오류 분류, SSO 재시도. 탭별 연결 관리.
  - `read/`: 목록, 상세, 소유 관계, 이벤트, discovery, Secret 가리기.
  - `stream/`: watch, 로그, drain 진행.
  - `access/`: `rbac`(RBAC 모델·aggregation), `engine`(실효 권한·can·who-can), `matrix`(권한 표 칸), `diff`(두 시점 비교), `identity`(access entry·aws-auth·인증 모드·access policy 대응표·SSO 묶기), `workload`(IRSA·Pod Identity 신뢰 정책 확인, IAM 모듈의 정책 파서 재사용) — 모두 순수 함수. `read`(읽기 호출과 부분 실패 모으기), `review`(SubjectAccessReview), `view`(화면 응답). 명령은 `k8s_access_commands.rs`.
  - (옛 계획의 `identity.rs`는 `access/workload.rs`가 맡는다.)
  - `checks/`: 보안 점검 — 순수 함수.
  - `network.rs`: 로드밸런서 짝 찾기, 서브넷.
  - `change/`: 변경 종류, 요청 만들기, 역변경, 미리보기·경고 — 순수 함수.
  - `commit.rs`: 재확인 후 적용, 장바구니 순서·중단.
  - `exec.rs`: 쿠버네티스·EKS에 쓰기 요청을 보내는 유일한 곳(dry-run 포함).
  - `shell.rs`, `forward.rs`: 셸과 port-forward 세션.
  - `log.rs`: 변경 기록(`jsonl.rs`).
  - `k8s_commands.rs`: Tauri 명령. 계획 저장소는 IAM의 `PlanStore<P>`.
- 안전 규칙
  - 쓰기 요청(POST, PUT, PATCH, DELETE, eviction, EKS 변경 API)은 `k8s/exec.rs`에서만 보낸다. 셸과 port-forward는 `shell.rs`, `forward.rs`에서만 연다. hygiene 테스트가 다른 파일에서 쓰기 API를 쓰지 않는지 확인한다(PG `hygiene.rs`와 같다).
  - 읽기 함수는 GET·LIST·WATCH와 `SelfSubject*Review`, `SubjectAccessReview`만 쓴다.
- 프론트 `src/k8s/`: IAM·PG 부품을 다시 쓴다(ListTable, PickerSheet, PreviewFooter, useApplyFlow, 할당 표의 칸·칠하기·장바구니, ChangeLog).

## 테스트
- 단위(Rust): kubeconfig context 찾기, exec 인자에서 프로필 찾기, 오류 분류, Secret 가리기, YAML 정리, 실효 권한(aggregation, 와일드카드, 하위 리소스, resourceNames, 기본 그룹), access policy 대응, aws-auth 파싱, IRSA 신뢰 확인, 점검, 로드밸런서 짝 찾기, 변경 요청·역변경·경고, drain 계획. 픽스처로 돈다.
- 실제 쿠버네티스 대조: `scripts/k8s-live-test.sh`가 Docker로 kind 클러스터(지원 범위 최저·최고 두 버전)를 띄우고 `#[ignore]` 테스트를 돌린다.
  - RBAC 시나리오를 만들고 실효 권한 계산을 `SubjectAccessReview`와 동작마다 비교한다.
  - watch, 로그 follow, exec, port-forward, server-side apply dry-run과 충돌, `resourceVersion` 재확인, eviction과 PDB, rollout undo.
  - EKS 전용 부분(access entry, Upgrade Insights, Pod Identity)은 모의 AWS 응답으로만 단위 테스트한다.
- 프론트(vitest): 화면, 로그 보관 한도, Secret 값 보기 수명, 장바구니, 미리보기, 셸 터미널 연결을 API를 흉내 내어 확인한다.
- 수동(실제 EKS, Tailscale): 체크리스트에 "EKS 쿠버네티스" 절을 더한다(context 없음 안내, Tailscale 끔 안내, SSO 만료 재로그인, 신원 표시, 권한 표를 `kubectl auth can-i`와 대조, 로그, 셸, port-forward, scale과 되돌리기, drain, RBAC 장바구니, access entry, YAML 적용과 충돌).
