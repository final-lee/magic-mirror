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

### 진행 예정: Lens·k9s 대비 빈 기능 (2026-11-02 정리)
지금 된 것은 K1·K2와 K3 일부(Pod 로그)다. Lens·k9s의 주요 기능 중 없는 것:
1. 클러스터를 바꾸는 조작: Pod 셸(exec)·port-forward(K9), scale·rollout restart·rollout undo·삭제(K7 A), cordon·uncordon·drain(K7 B), YAML 편집·적용·새로 만들기(K8 E). 컨테이너 attach와 노드 셸(디버그 Pod)은 C 절에 들어왔고(2026-11-02) 구현했다. CronJob 바로 실행은 K7 A의 Job 재실행에 포함, 일시정지는 K7 A.
2. 로그: 워크로드 합친 로그(Pod별 색, 새 Pod 따라 붙기)·since(최근 N분)·파일 저장(K3 남은 것), 모든 컨테이너 한꺼번에, 서버 타임스탬프·줄바꿈 토글.
3. 리소스 사용량: Pod·컨테이너 CPU/메모리 열(metrics-server, 지금은 개요의 노드 사용량만), request·limit 대비 %, Prometheus 그래프, 워크로드·네임스페이스 집계.
4. 트리에 없는 내장 종류: HPA, PDB, ResourceQuota, LimitRange, PriorityClass, RuntimeClass, Lease, Mutating·ValidatingWebhookConfiguration, EndpointSlice, IngressClass, Role·ClusterRole·RoleBinding·ClusterRoleBinding, CustomResourceDefinition 자체.
5. 탐색: 키보드 중심 조작(명령 팔레트, `:종류` 이동), `kubectl describe` 형식 출력, xray식 관계 트리, 앱 안 터미널(kubectl), 플러그인.
6. Helm: 릴리스 목록·values·이력, 업그레이드·롤백·삭제, 차트 설치(설계에 없음).
7. 점검·권한: popeye식 위생 점검(K5), RBAC 역조회(K4).

우선순위(매일 쓰는 빈도): ① 셸·port-forward·restart·scale·삭제 ② Pod CPU/메모리 열 ③ 트리에 내장 종류 추가 ④ 로그 K3 나머지 ⑤ Helm 읽기 전용.

## 대상과 탭
- **EKS → Clusters** 행을 더블클릭하면 `☸️ <클러스터 이름>` 탭이 열린다. 이것이 유일한 진입점이고, 사이드바에 별도 메뉴(클러스터 선택 화면)는 두지 않는다.
- 대상은 `{ profile, region, cluster }`. 같은 대상의 탭은 하나만 열린다.
- 탭을 닫으면 그 탭의 watch, 로그 스트림, 셸, port-forward, 연결을 모두 정리한다.
- 하위 화면: 개요, 워크로드, 로그, 접근, 보안 점검, 네트워크, 셸, 포트포워딩, 변경 기록.
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
- 변경 버튼은 토글 없이 늘 보인다(사용자 결정 2026-11-03: 처음 설계의 **변경** 토글은 버튼을 찾지 못하게 만들어 없앴다). 권한이 없으면 이유와 함께 비활성화. 안전은 미리보기·이름 입력·재확인이 맡는다.
- 버튼 자리와 색(사용자 결정 2026-11-03): 상세 머리 아래 도구 줄 하나에 포트포워딩, YAML 편집(편집 중에는 미리보기·편집 취소), 종류별 조작, 삭제를 모두 두고 오른쪽 정렬한다. 지우기처럼 되돌리기 어려운 것이 맨 오른쪽. 셸 탭의 열기와 요약의 노드·IAM 이동 버튼은 제자리에 둔다.
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
  - 화면: Pod 상세에 "셸" 탭(컨테이너 고르기, 셸/attach, 확인 창)과 터미널(xterm.js, 다른 탭을 봐도 세션 유지, Pod를 바꾸거나 세션을 닫으면 끊김), Pod·Service 상세에 "포트포워딩" 버튼(`k8s_get`의 `ports`에서 고르거나 직접 입력, 로컬 포트는 비우면 자동, 열면 고르기 칸은 닫힌다)이 늘 보인다. 왼쪽 메뉴 "포트포워딩"은 이 클러스터의 목록(브라우저로 열기, 주소 복사, 종료)이다. 권한은 `pods/exec`·`pods/attach`·`pods/portforward`의 `create`를 내 권한(`can`)으로 보고, 없으면 버튼을 끄고 이유를 보인다.
  - 상세의 "이 객체의 포트포워딩"(사용자 결정 2026-11-03): Pod·Service 상세의 도구 줄 아래에 그 객체의 열린 포트포워딩(Pod 상세는 지금 그 Pod로 이어진 Service 포워드도)을 한 줄씩 `127.0.0.1:로컬 → 대상:포트 · (Service면) 붙은 Pod · 상태`와 [브라우저로 열기]·[주소 복사]·[종료]로 보인다. 목록은 3초마다 다시 읽고, 열린 것이 없으면 줄이 없다.
  - 계약에 더한 것: `k8s_attach_open`, `k8s_shell_confirm_name(namespace, pod): string | null`, `k8s_node_shell_open(target, namespace, pod, channel): ShellId`, `ShellId = { id, input }`, `K8sForward`의 `target`·`namespace`·`kind`·`name`·`remotePort`·`pod`·`error`, `k8s_get` 결과의 `ports`(Pod는 컨테이너 포트, Service는 Service 포트와 `target`), 변경 종류 `shell`(기록 전용)·`nodeShell`, 변경 기록 `closedAt`.
  - 노드 셸(구현): Node 상세의 "노드 셸" 버튼(이미지 입력칸, 기본 `busybox:1.36`, 권한은 pods create와 pods/exec)이 변경 틀의 `nodeShell` 변경을 시작한다. 대상은 만들 Pod(`mm-node-shell-<시각>`, 고른 네임스페이스, 모든 네임스페이스면 `default`), 노드는 변경의 `node`. 미리보기는 `POST /api/v1/namespaces/<ns>/pods`와 본문(`nodeName`, `hostPID`·`hostNetwork`·`hostIPC`, privileged, 노드 루트를 `/host`에 마운트, 모든 taint 허용, 8시간 `activeDeadlineSeconds`와 `terminationGracePeriodSeconds: 0`)과 경고를 보이고, 입력할 이름은 늘 노드 이름이다. 서버 dry-run을 거치고(Pod 보안 정책이 막으면 미리보기에서 실패) 적용은 변경 기록에 남는다. 적용이 끝나면 노드 상세가 `k8s_node_shell_open`으로 Pod의 `shell` 컨테이너가 실행될 때까지(최대 60초) 기다렸다가 `nsenter -t 1 -m -u -i -n -p -- sh`로 들어간다. 적용이 성공하는 즉시 백엔드가 만든 Pod의 UID를 읽어 세션 상태(`NodeShells`)에 등록하고, `k8s_node_shell_open`은 그 대상에서 등록한 Pod(이름과 UID가 모두 같은 것)만 한 번 연다(표시가 같아도 YAML 적용 등으로 만든 Pod는 거부). 등록한 Pod는 터미널이 가져가기 전에 탭을 닫거나 앱을 끄거나 적용 기록 쓰기가 실패해도 지운다(지우기는 UID가 같은 Pod만). 열지 못하거나 세션이 끝나거나(셸 종료, 세션 닫기, 탭 닫기, 앱 종료) 하면 같은 변경 틀(미리보기·재확인·`exec.rs`)로 Pod를 지우고 그 지우기도 변경 기록에 남긴다(앱 종료는 최대 10초 기다린다). 끝난 노드 셸은 "다시 열기"가 없다.
  - 남은 것: 없음(K9 범위).
- 노드 셸(2026-11-02 추가, `kubectl debug node`와 같은 방식): 그 노드에 고정한(`nodeName`) 디버그 Pod를 만든다. `hostPID`·`hostNetwork`·`hostIPC`, `privileged`, 노드 루트를 `/host`에 마운트, 이미지는 미리보기에서 고칠 수 있는 기본값(busybox), 명령은 `nsenter -t 1 -m -u -i -n -p -- sh`. Pod 만들기는 변경 공통 틀(미리보기·이름 입력 필수·기록)을 거치고, 셸을 닫으면 Pod를 지운다(지우기도 기록). 네임스페이스는 고른 네임스페이스, 모든 네임스페이스면 `default`.

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
- 지금 된 것(2026-11-02):
  - 변경 종류 `apply { object, force }`(`Operation::Apply`). 본문은 `change/apply.rs`가 만든다: 서버가 채우는 필드를 빼고, 이름·종류를 대상과 맞추고(다르면 거절), 네임스페이스가 없으면 대상의 것을 넣고, 있는 객체면 미리보기 직전에 읽은 `resourceVersion`을 조건으로 건다(없는 객체는 조건 없이 만든다). 호출은 `PATCH …?fieldManager=magic-mirror[&force=true]`(apply-patch). 필드 이름 충돌이 아닌 409는 기존 "미리보기 이후 바뀌었어요"다.
  - 미리보기: 서버 dry-run 결과(서버가 만든 객체)와 현재 객체를 정리해 필드마다 비교한다(`spec.template.spec.containers[0].image` 꼴 경로, 길이가 다른 배열은 통째로). 새로 만들면 객체 전체가 한 항목. 바뀌는 것이 없으면 경고. 충돌은 서버 오류의 `FieldManagerConflict` 원인에서 필드와 소유 manager를 꺼내 `Preview.conflicts`로 보여 주고, 충돌이 있는 미리보기는 적용되지 않는다(화면의 [적용]은 막힘 경고로 꺼지고 백엔드 `check`도 거절). [강제 적용으로 다시 미리보기]가 `force: true` 변경으로 다시 미리보기 하며, 강제 적용은 이름 입력을 받는다(위험한 변경과 같은 게이트). 서버가 객체를 받지 않으면(400·422) Secret이 아닌 객체는 서버의 이유를 그대로 보여 준다.
  - 이름 입력: `roleRef`가 `cluster-admin` ClusterRole인 RoleBinding·ClusterRoleBinding을 만들거나(되살리기 포함) 그런 바인딩의 subjects를 고치면 대상 이름을 입력받는다. 그 밖의 권한 상승 경로(bind·escalate·impersonate 등) 판단은 K4 몫이다.
  - 되돌리기: 있던 객체는 정리한 이전 객체를 `apply`로 다시 적용(`force: false`), 새로 만든 객체는 삭제. 둘 다 기록의 역변경이며 되돌리기 미리보기를 거친다. `aws-auth` ConfigMap은 "access entry로 옮기세요" 경고.
  - 상세 YAML 탭: 변경 모드에서 [편집]이 읽기 전용 YAML을 CodeMirror 6 편집기로 바꾼다(`@codemirror/*`, 구문 오류는 `yaml` 패키지로 찾아 줄 밑줄과 목록으로 보이고 미리보기를 막는다). 편집기에 들어가는 글은 백엔드가 만든 `editYaml`(서버 필드를 뺀 것). 종류·이름·네임스페이스를 바꾸거나 문서가 둘이면 미리보기 전에 거절한다. patch 권한이 없으면 이유와 함께 끈다.
  - Secret: 편집 글에는 `data`·`stringData`·last-applied가 없다. 키별 [값 보기](읽은 값은 컴포넌트 상태에만)로 읽어 고치거나 [새 값 입력]·키 추가로 `stringData`에 넣고, 건드리지 않은 키는 가린 값(••••)으로 보내 백엔드가 현재 값으로 되돌려 놓는다. 바이너리 값은 새 값 입력으로만 바꾼다. 미리보기의 본문·diff에는 값이 없고(바뀐 키만 `•••• (바뀜)`), 기록에는 `data`·`stringData`를 모두 가린 변경만 남으며, 되돌릴 수 없다는 경고를 보인다.
  - 상단 [YAML로 만들기](변경 모드): 붙여 넣은 글을 문서마다 `apply` 변경으로 바꾼다(종류는 클러스터가 내주는 종류에서 apiVersion·kind로 찾고, 네임스페이스가 없는 문서는 고른 네임스페이스로, 모든 네임스페이스면 그 문서의 오류). 최대 50개. 문서별 미리보기(호출·diff·경고·이름 입력)를 한 창에 보이고, 순서대로 적용하다 첫 실패에서 멈추고 나머지는 건너뛴 뒤 [적용한 것 되돌리기]로 거꾸로 되돌리기 미리보기를 연다. 미리보기가 되지 않는 문서(앞 문서가 만드는 네임스페이스 안의 객체 등) 앞까지만 먼저 적용하고 나머지를 다시 미리보기 한다. 별도 배치 명령(`k8s_preview_batch`/`k8s_apply_batch`) 없이 문서마다 `k8s_preview`/`k8s_apply`를 쓰므로 기록도 문서마다 하나이고 변경 기록 화면에서 하나씩 되돌릴 수도 있다.

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
