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
- Helm 릴리스 관리, 디버그용 ephemeral 컨테이너, 셸 입력 기록.
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

## 대상과 탭
- **EKS → Clusters** 행을 더블클릭하면 `☸️ <클러스터 이름>` 탭이 열린다. 이것이 유일한 진입점이고, 사이드바에 별도 메뉴(클러스터 선택 화면)는 두지 않는다.
- 대상은 `{ profile, region, cluster }`. 같은 대상의 탭은 하나만 열린다.
- 탭을 닫으면 그 탭의 watch, 로그 스트림, 셸, port-forward, 연결을 모두 정리한다.
- 하위 화면: 개요, 워크로드, 로그, 접근, 보안 점검, 네트워크, 셸, 포트포워딩, 변경 기록.
- 상단 막대: kubeconfig context 이름, 클러스터에서 보이는 신원, 네임스페이스 선택(전체 포함), **변경** 토글.

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
- 클러스터: 버전, 플랫폼 버전, 엔드포인트 공개 범위와 허용 CIDR, 컨트롤 플레인 로깅, Secret 암호화, OIDC 공급자, 인증 모드.
- 노드: 상태(Ready, cordon, 압박 조건), 인스턴스 타입, AZ, 노드그룹(관리형, Fargate, Karpenter NodePool, 자체 관리), kubelet 버전, 할당 가능량 대비 요청량. metrics-server가 있으면 사용량.
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
- 상세: 요약, 소유 관계(ownerReferences 위아래 이동), 컨테이너별 상태와 마지막 종료 이유, 관련 이벤트, YAML 탭(테마 색으로 구문 강조), Pod는 로그 탭. 머리의 뒤로(‹)·닫기(✕)는 아이콘 버튼.
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
- 지금 된 것(2026-11-02, K3 일부 먼저): 4열 상세의 Pod "로그" 탭. 컨테이너(init 포함) 고르기, 이전 컨테이너, 따라가기, 처음 받을 줄 수(100~50,000). 명령 `k8s_logs`(채널, `k8s_unwatch`로 멈춤, 탭을 닫으면 같이 멈춤). 남은 것: 워크로드 단위 합친 로그(Pod별 색, 새 Pod 따라 붙기), 최근 N분, 파일로 저장.
- 보기 방식(사용자 결정, 2026-11-02): lnav로 보던 방식은 버리고(설치된 lnav를 PTY로 띄웠으나 서비스 JSON 로그를 제대로 읽지 못했다) 앱 안에서 그린다. 기본은 **JSON 정리**, 원하면 **원문**.
  - JSON 정리: `{`로 시작하는 줄을 JSON 객체로 읽어 ▸ 시각(로컬 `MM-DD HH:mm:ss.SSS`, 원래 값은 툴팁) · 레벨(색) · 메시지를 한 줄로 보인다. 흔한 로거의 이름을 읽는다: 시각 `timestamp`·`@timestamp`·`time`·`ts`(ISO 또는 epoch 초·밀리초·마이크로초·나노초), 레벨 `log.level`·`level`·`severity`(pino 숫자 레벨 포함), 메시지 `message`·`msg`. 나머지 필드는 접어 두고, 오류 필드(`error*`, `err*`, `exception`, `stack*`)와 찾는 말이 든 필드는 메시지 옆에 `key=value`로 붙인다. ▸를 누르면 필드 전체(값의 종류별 색)와 JSON 복사. JSON이 아닌 줄은 원문 그대로.
  - 레벨 거르기: 오류·경고·정보·디버그·기타(레벨을 알 수 없는 줄) 칩을 여러 개 함께 고른다. 아무것도 고르지 않으면 모든 줄. 칩마다 줄 수. JSON이 아닌 줄은 맨 앞의 레벨 낱말(`[WARNING] …`, `ERROR: …`)이나 logfmt `level=`로 레벨을 정한다. 찾기의 일치 줄 수와 복사는 보이는 줄만.
  - 공통: 찾기(대소문자 무시, 일치 줄 수), 일시정지(대기 줄 수), 맨 아래 따라가기, 복사(보이는 줄의 원문), 최근 5만 줄 보관.

### ArgoCD (사용자 결정, 2026-11-02)
- 위치: 클러스터 탭 안이 아니라 **사이드바 EKS 밑 "🐙 ArgoCD"** 항목. 누르면 단일 탭이 열리고 AWS 프로필과 무관하다(프로필을 바꿔도 닫히지 않는다).
- 연결: 운영 중인 **ArgoCD API 서버**에 **API 토큰**으로 붙는다(비밀번호 로그인 없음). 미리 넣어 둔 서버는 없다. 처음에는 **1단계 서버 주소**(http(s)://, 이름은 비우면 호스트) → **2단계 API 토큰** 순으로 연결하고, 새로 넣은 서버는 곧바로 골라 토큰을 묻는다(사용자 결정, 2026-11-02). 서버는 여러 개(설정 `argocdServers: [{name, url}]`), 탭에서 고르고 목록을 고친다. 목록에서 빼면 그 서버의 토큰도 키체인에서 지우고, 마지막 서버를 빼면 1단계로 돌아간다.
- 토큰: ArgoCD UI Settings → Accounts → 계정 → Tokens나 `argocd account generate-token`으로 만들어 붙여 넣는다. `/api/v1/session/userinfo`로 확인된 토큰만 **macOS 키체인**(service `magic-mirror.argocd`, account = 서버 URL)에 저장하고, 앱은 메모리 캐시를 둔다. 키체인 호출은 블로킹 스레드에서 한다. 설정 파일·로그·오류에 토큰을 넣지 않는다. `http://` 서버는 평문 전송 경고를 보인다. 401이면 토큰 입력으로 돌아간다(토큰은 지우지 않는다).
- 목록(10초마다 다시 읽음, 탭이 안 보이면 멈춤): Sync·Health 칩 다중 선택(묶음 안 OR·묶음 사이 AND), 프로젝트·이름 거르기, ApplicationSet으로 묶기(generator·Error 메시지·앱 수), 문제 앱(OutOfSync·Healthy 아님·오류 조건·작업 실패) 먼저. 대상 열의 `https://kubernetes.default.svc`·`in-cluster`는 "이 클러스터".
- 상세: 개요(상태, 마지막 작업과 실패 리소스, 조건 전문, 소스·values 파일, 대상, 동기화 정책, 이미지, ApplicationSet), 리소스 트리(`resource-tree` API의 부모 관계로 Deployment → ReplicaSet → Pod 들여쓰기, 노드별 Health·info, Application의 Sync 상태·hook·삭제 예정 표시), 동기화 이력, YAML/JSON(Application 전체).
- 실행: Refresh·Hard refresh(`GET …?refresh=`), Sync(확인 창, Prune·Dry run 기본 끔, `POST …/sync`). 권한 판단과 요청자 기록은 ArgoCD 서버가 한다. 진행 중이면 Sync를 끈다. 클러스터에 직접 쓰지 않으므로 `k8s::hygiene` 예외는 없다.
- 명령: `argocd_set_token`, `argocd_forget_token`, `argocd_session`, `argocd_apps`, `argocd_appsets`, `argocd_app`, `argocd_tree`, `argocd_refresh`, `argocd_sync` (`src-tauri/src/argocd/`, `src-tauri/src/argocd_commands.rs`, 프론트 `src/argocd/`).

### 네트워크
- Service·Ingress → ALB·NLB: AWS Load Balancer Controller 태그(`elbv2.k8s.aws/cluster`, `service.k8s.aws/stack`, `ingress.k8s.aws/stack`)와 status 호스트명으로 짝을 찾는다. 리스너, 대상 그룹 상태.
- 노드 → 서브넷·AZ. VPC CNI면 Pod IP가 속한 서브넷.
- 기존 VPC 다이어그램 열기(클러스터 노드와 로드밸런서 강조).
- NetworkPolicy는 목록과 상세만.

## 접근

### 신원 연결
- access entry(`ListAccessEntries`, `DescribeAccessEntry`, `ListAssociatedAccessPolicies`)와 `kube-system/aws-auth`(`mapRoles`, `mapUsers`, 템플릿 `{{SessionName}}` 등)를 모은다.
- 인증 모드에 따라 유효한 쪽을 표시한다(`API_AND_CONFIG_MAP`에서는 access entry가 먼저).
- access policy는 고정 대응표로 바꾼다: `AmazonEKSClusterAdminPolicy` → `cluster-admin`, `AmazonEKSAdminPolicy` → `admin`, `AmazonEKSEditPolicy` → `edit`, `AmazonEKSViewPolicy` → `view`. 범위가 네임스페이스면 그 네임스페이스에만. 표에 없는 정책은 "평가하지 못함".
- `AWSReservedSSO_<권한 세트>_<해시>` 역할은 권한 세트 이름으로 묶어 보여준다.

### 실효 권한 (순수 함수)
- 입력: Role, ClusterRole, RoleBinding, ClusterRoleBinding, 신원 매핑, access policy. 출력: 주체(사용자, 그룹, ServiceAccount, IAM 주체)별 규칙과 출처 경로.
- 처리: `aggregationRule`, `*`, `resourceNames`, 하위 리소스, `nonResourceURLs`, 기본 그룹(`system:authenticated`, `system:serviceaccounts`, `system:serviceaccounts:<ns>`).
- RBAC만 계산한다. 화면에 "RBAC과 EKS access policy만 계산해요"를 적는다.
- 권한 표: 주체 × 네임스페이스. 칸은 읽기, 쓰기, 삭제, exec·attach·port-forward, Secret 읽기, RBAC 변경, 권한 상승 가능. 칸을 누르면 동작과 바인딩 경로.
- 누가 할 수 있나: 동사 + 리소스(+ 하위 리소스) + 네임스페이스(+ 이름) → 주체와 경로. 결과는 `SubjectAccessReview`로 대조할 수 있다(대조 결과가 다르면 표시).

### 워크로드 신원
- ServiceAccount마다 IRSA 어노테이션, Pod Identity 연결(`ListPodIdentityAssociations`), 쓰는 Pod.
- IRSA 확인: 역할의 신뢰 정책에 이 클러스터의 OIDC 공급자와 `sub` = `system:serviceaccount:<ns>:<sa>`(또는 맞는 와일드카드), `aud` = `sts.amazonaws.com` 조건이 있는지. 없으면 "연결돼 있지만 동작하지 않음".
- 역할을 누르면 IAM 워크스페이스에서 그 역할을 연다.

## 보안 점검
- 클러스터: 퍼블릭 엔드포인트가 `0.0.0.0/0`, 컨트롤 플레인 로깅 꺼짐, Secret 암호화 꺼짐, 표준 지원 종료 90일 이내 버전, aws-auth 사용, 생성자 관리자 권한 남음.
- 권한: `cluster-admin`·`system:masters` 주체, `system:authenticated`·`system:anonymous`에 준 권한, 권한 상승 경로(`bind`, `escalate`, `impersonate`, Pod 생성 + 강한 SA 사용, `nodes/proxy`, Secret 전체 읽기), 쓰이지 않는 Role과 바인딩.
- 워크로드: privileged, hostPath, hostNetwork, hostPID, root 실행, `allowPrivilegeEscalation`, request·limit 없음, probe 없음, `latest`나 태그 없는 이미지, default SA 토큰 자동 마운트, NetworkPolicy 없는 네임스페이스, IMDS hop limit이 2 이상인 노드그룹(Pod가 노드 역할을 쓸 수 있음).
- 항목별 켜고 끄기, 시스템 네임스페이스(`kube-system`, `kube-public`, `kube-node-lease`, `amazon-*`) 기본 제외.
- 각 항목은 대상으로 연결되고, 고칠 수 있는 항목은 해당 변경 미리보기로 이어진다.

## 변경

### 공통
- **변경** 토글을 켜야 버튼이 보인다. 권한이 없으면 이유와 함께 비활성화.
- 미리보기: API 호출(동사, 경로, 본문), 필드 diff, 영향, 경고. 쿠버네티스 쓰기는 모두 server-side dry-run을 먼저 돌린다.
- 이름 입력이 필요한 위험한 변경: 네임스페이스가 `kube-system`이거나 이름에 `prod`가 들어감, drain, `cluster-admin`이나 권한 상승 경로를 주는 바인딩, 앱의 현재 신원이 권한을 잃는 변경, `AmazonEKSClusterAdminPolicy` 연결.
- 적용 시 재확인: 미리보기 때 `resourceVersion`을 조건으로 보낸다. 409면 "미리보기 이후 바뀌었어요"로 멈춘다. 장바구니는 적용 전에 계획을 다시 만들어 미리보기와 다르면 멈춘다.
- 기록: IAM·PG와 같은 `jsonl.rs`를 쓰는 `k8s` 기록 파일. 되돌리기는 같은 미리보기를 거친다.

### A. 워크로드 조작
| 동작 | 대상 | 되돌리기 |
|---|---|---|
| scale | Deployment, StatefulSet | 이전 replicas |
| rollout restart | Deployment, StatefulSet, DaemonSet | 불가(rollout undo 안내) |
| rollout undo | Deployment(ReplicaSet 리비전), StatefulSet·DaemonSet(ControllerRevision) | 원래 리비전으로 |
| Pod 삭제 | Pod | 불가. 컨트롤러 없는 Pod는 경고 |
| Job 재실행 | Job, CronJob → 새 Job | 만든 Job 삭제 |
| 일시정지·재개 | CronJob(`suspend`) | 반대 |
- 적용 후 rollout 진행(준비된 새 Pod 수)을 보여준다.

### B. 노드 조작
- cordon·uncordon: 서로 되돌리기.
- drain: 미리보기에 옮길 Pod, 건너뛸 DaemonSet Pod, emptyDir 손실 경고, 컨트롤러 없는 Pod 경고, PDB로 막힐 Pod. 적용은 cordon → Eviction을 하나씩. 429가 이어지면 5분 뒤 멈추고 이미 옮긴 것은 그대로 둔다. 되돌리기는 uncordon만.

### C. 셸과 port-forward
- 셸: `kube-rs` `exec`(웹소켓). `/bin/bash`, 없으면 `/bin/sh`. 터미널은 xterm.js, 크기 변경을 전달한다. 열 때 확인, 위험 네임스페이스면 이름 입력. 기록은 열고 닫은 시각과 대상만.
- port-forward: `kube-rs` `portforward`. 로컬은 `127.0.0.1`만, 포트는 자동(직접 지정 가능). Service는 준비된 Pod 하나로, 그 Pod가 사라지면 다른 Pod로 다시 붙는다. 포트포워딩 화면에서 보고 닫는다. 탭을 닫거나 앱을 끄면 모두 닫는다.

### D. 권한 변경
- RBAC: 바인딩 추가·제거, 바인딩의 주체 추가·빼기. 권한 표에서 셀로 담는 장바구니(최대 50), 한 번에 미리보기. 미리보기는 실효 권한 계산기로 "누가 무엇을 얻고 잃는지". 적용은 하나씩, 첫 실패에서 멈추고 이미 적용한 것은 되돌리기를 제안한다(IAM 할당 표와 같다). 제거는 원래 객체 전체를 기록해 되돌릴 때 다시 만든다.
- access entry: 생성, 삭제, k8s 그룹 변경, access policy 연결·해제(범위 포함). EKS API로. 되돌리기도 EKS API로.
- aws-auth는 전용 편집을 두지 않는다. E로 고치면 "access entry로 옮기세요" 경고.

### E. YAML 편집과 적용
- 편집기: CodeMirror 6(YAML 모드, 문법 검사). `status`, `managedFields`, `metadata.uid`, `resourceVersion`, `creationTimestamp`, `generation`은 빼고 보여준다.
- 새로 만들기: 붙여 넣은 YAML(문서 여러 개 가능)을 각각 미리보기.
- 미리보기: server-side apply dry-run 결과와 현재 객체의 diff. field manager `magic-mirror`. 충돌이면 필드와 소유 manager를 보여주고, 강제 적용(`force`)은 이름 입력을 받는다.
- 되돌리기: 적용 전 객체(정리한 형태)를 기록하고 다시 적용. 새로 만든 리소스는 삭제.
- Secret: 값은 가린 채 시작, 키별 "값 보기" 후 편집 또는 새 값 입력. 기록에 Secret 값을 남기지 않으므로 Secret 변경은 "되돌릴 수 없음".

## 계약 (Tauri 명령)
```ts
type K8sTarget = { profile: string; region: string; cluster: string };
k8s_open(target, context: string | null): K8sSession          // context 찾기·접속·신원. 후보가 여럿이면 후보를 돌려준다
k8s_close(target): void
k8s_overview(target): K8sOverview
k8s_kinds(target): K8sKind[]                                    // API discovery
k8s_list(target, kind, namespace: string | null, selector: string | null): K8sList
k8s_watch(target, kind, namespace, channel): WatchId            // 변경분을 채널로
k8s_unwatch(watchId): void
k8s_get(target, kind, namespace, name): K8sObjectView           // 상세, 소유 관계, 이벤트, 정리된 YAML(Secret 값 가림)
k8s_secret_value(target, namespace, name, key): string
k8s_events(target, namespace | null): K8sEvent[]
k8s_logs(target, K8sLogRequest, channel): StreamId
k8s_stop(streamId): void
k8s_access(target, force: boolean): K8sAccessView               // 신원 매핑, 실효 권한, 권한 표
k8s_who_can(target, K8sWhoCanQuery): K8sWhoCan
k8s_review(target, K8sWhoCanQuery, subject): boolean           // SubjectAccessReview 대조
k8s_workload_identity(target): K8sWorkloadIdentity[]
k8s_findings(target, force: boolean): K8sFindings
k8s_network(target): K8sNetworkView
k8s_preview(target, K8sChange): K8sPreview
k8s_apply(target, K8sChange, confirmText | null, undoOf | null): K8sApplyResult
k8s_preview_batch(target, K8sChange[]): K8sBatchPreview
k8s_apply_batch(target, K8sChange[], confirmText | null, undoOf: string[] | null): K8sBatchResult
k8s_drain(target, node, confirmText, channel): StreamId        // 진행 상황을 채널로
k8s_shell_open(target, namespace, pod, container, confirmText | null, channel): ShellId
k8s_shell_input(shellId, data: string): void
k8s_shell_resize(shellId, cols, rows): void
k8s_shell_close(shellId): void
k8s_forward_open(target, K8sForwardRequest): K8sForward        // { id, localPort }
k8s_forward_list(): K8sForward[]
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
  - `access/`: 신원 매핑(access entry, aws-auth), access policy 대응표, 실효 권한, 권한 표, who-can — 순수 함수.
  - `identity.rs`: IRSA 신뢰 정책 확인(IAM 모듈의 정책 파서 재사용), Pod Identity.
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
