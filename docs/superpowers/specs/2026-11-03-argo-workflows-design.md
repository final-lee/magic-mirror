# Argo Workflows 대시보드: 설계

## 목표
- 운영 중인 **Argo Server API**에 붙어 Workflow·CronWorkflow·템플릿을 보고, 실패를 빨리 찾고, 다시 돌리거나 멈춘다.
- `kubectl`과 같은 신원으로 붙는다: 서버가 `--auth-mode=client`면 kubeconfig context의 자격 증명(EKS는 `aws eks get-token`)을 Bearer 토큰으로 쓴다. 토큰을 붙여 넣는 방식도 둔다.
- 같은 context로 쿠버네티스 API도 읽어(선택) Argo Server가 주지 않는 것(이벤트, ServiceAccount의 IAM 역할)을 채운다.

## 사용자 결정 (2026-11-03)
- 연결: Argo Server API를 처음부터 함께 쓴다(아카이브, Retry, 서버가 대신 읽는 로그).
- 위치: ArgoCD처럼 **사이드바 EKS 밑 "⚙️ Argo Workflows"**, 단일 탭, AWS 프로필과 무관(프로필을 바꿔도 닫히지 않는다).
- 범위: 읽기·점검·조작을 한 번에 낸다.

## 구현 중 결정 (2026-11-03, 리뷰 반영)
- 목록 API는 살아 있는 Workflow 뒤에 아카이브(DB) 것을 붙여 준다. DB에서 온 것은 `workflow-archiving-status: Persisted` 레이블로 알아보고 `archived`로 표시해 상세·동작을 보관함 경로로 보낸다. 같은 uid가 살아 있으면 살아 있는 쪽만 남긴다.
- suspend 템플릿에서 기다리는 Workflow는 `spec.suspend` 없이 Running이라, 실행 중인 Suspend 노드가 있으면 정지된 것으로 보고 Resume을 켠다(Argo `IsWorkflowSuspended`와 같다).
- 스케줄: robfig/cron 별칭 `@midnight`·`@annually`를 받고, `@every <기간>`은 마지막 실행(없으면 만든 시각)을 기준으로 다음 실행과 놓침을 계산한다(컨트롤러가 잡은 시각은 밖에서 알 수 없다).
- exec 자격 증명 캐시의 열쇠는 context 이름 + 그 사용자 설정의 해시: kubeconfig를 바꿔 같은 이름이 다른 신원을 가리키면 이전 토큰을 쓰지 않는다.
- `KubeContext.ssoProfile`로 첫 연결(`argowf_session`)부터 exec 프로필을 넘겨, SSO가 만료됐으면 자동 로그인이 돈다.
- `WfRow.activeDeadlineSeconds`(목록 `fields`에 포함): 점검의 "오래 실행 중"은 워크플로 수준 제한이 있으면 뺀다. `CronRow.template`·`clusterTemplate`: 템플릿을 쓰는 Cron 수와, SA를 알 수 없는 Cron을 default SA 점검에서 빼는 데 쓴다.

## 확인한 환경 (personal `stg-eks`, 2026-11-03)
- Argo Workflows v4.1.6, `argo-server --auth-mode=client --secure=false`, Tailscale ingress `https://argo-workflows-stg.<tailnet>.ts.net`.
- 토큰 없이 부르면 `401 {"code":16,"message":"token not valid…"}`. `aws eks get-token`의 토큰을 Bearer로 넣으면 모든 네임스페이스 목록(`/api/v1/workflows/`)이 읽힌다. `userinfo`는 `{}`.
- 아카이브(persistence)와 아티팩트 저장소는 없다(`archived-workflows` → `items: null`). 컨트롤러 기본값 `podGC: OnPodSuccess`, `ttlStrategy.secondsAfterSuccess: 30d`.
- 실패한 Workflow의 Pod와 이벤트는 이미 없을 수 있다(로그 API가 빈 응답). 화면은 "Pod가 지워져 로그가 없어요"로 안내한다.

## 범위 밖
- Argo Events, WorkflowEventBinding 편집, Sensor.
- Workflow·템플릿 YAML 편집기와 새 Workflow를 YAML로 만들기(템플릿·Cron에서 실행, 다시 제출만).
- 아티팩트 내려받기(저장소가 생기면 S3 탐색기로 여는 것은 다음 단계).
- ⌘K 리소스 찾기에 Workflow 넣기(AWS 목록 색인과 성격이 달라 다음 단계).

## 탭과 연결
- 사이드바 EKS 서비스를 펴면 `🐙 ArgoCD` 아래 `⚙️ Argo Workflows`. 누르면 탭 `⚙️ Argo Workflows` 하나(id `argowf`).
- 서버 목록은 설정 `argoWorkflowsServers: [{ name, url, context }]`. `context`는 kubeconfig context 이름(그 자격 증명으로 붙는다) 또는 `null`(키체인의 API 토큰으로 붙는다). 미리 넣어 둔 서버는 없다.
- 처음 연결: **1단계 서버 주소**(http(s)://, 이름은 비우면 호스트) → **2단계 인증**: [kubeconfig context] 목록(기본: 고른 것 없음, context 이름·클러스터) 또는 [API 토큰]. ArgoCD 연결 화면(`ArgoSteps`, `ArgoServerEditor`, `ArgoTokenForm`)과 같은 모양.
- context 인증: 백엔드가 kubeconfig(앱 설정 경로 → `KUBECONFIG` → `~/.kube/config`)에서 그 context의 사용자를 찾아 `token`이 있으면 그것, `exec`가 있으면 플러그인을 돌려 `ExecCredential.status.token`을 얻는다(PATH는 `k8s::path::login_path`, env·args는 kubeconfig 그대로). `expirationTimestamp` 1분 전까지 메모리에 둔다. 401이면 한 번 새로 받아 다시 시도한다. 토큰은 키체인·설정·로그·오류에 넣지 않는다.
- 토큰 인증: `magic-mirror.argo-workflows` 서비스로 키체인에 둔다(account = 서버 URL). `Bearer `로 시작하면 그대로, 아니면 붙인다. 확인은 `GET /api/v1/version`이 200인지(서버 모드에 따라 `userinfo`가 비어 있을 수 있다).
- 세션 줄: `<신원> · v4.1.6`. 신원은 `userinfo`의 email·subject, 없으면 context 이름, 그것도 없으면 "토큰".
- 서버를 빼면 그 서버의 토큰을 키체인에서 지우고 화면 기억(`argoWorkflowsViews[url]`)도 버린다.
- `http://` 서버는 평문 전송 경고(ArgoCD와 같다). 네트워크 오류는 "Argo Server에 닿지 못했어요. Tailscale·VPN 연결을 확인해 주세요".

## 화면
왼쪽 메뉴: **Workflows · CronWorkflows · 템플릿 · 보관함 · 점검**. 각 목록은 탭이 보일 때만 다시 읽는다(Workflows 5초, 나머지 30초, 탭이 가려지면 멈춤). 행을 누르면 오른쪽에 상세가 겹쳐 뜬다(ArgoCD 상세와 같은 틀). 모든 목록 필터는 공통 퍼지 검색(`src/lib/fuzzy.ts`).

### Workflows
- 요약 띠: 지금 Running · Pending, 최근 24시간 성공 · 실패(실패율), 연속 실패 중인 Cron 수(누르면 점검).
- 거르기: phase 칩(Running, Pending, Succeeded, Failed, Error — 개수는 칩 선택을 뺀 기준), 네임스페이스 다중 선택, 원천(Cron 이름, 템플릿 이름) 다중 선택, 검색(이름·네임스페이스·Cron·템플릿·레이블 값). 서버별로 마지막 거르기를 기억한다(검색어는 빼고).
- 열: 이름, 네임스페이스, 상태(phase 점 + 진행 `3/7`), 원천(`⏱ cron` · `📄 template` · `직접`), 시작(상대 시각), 걸린 시간(실행 중이면 지금까지), 메시지(실패면 빨강, 한 줄).
- 순서: 실행 중·대기 → 최근 실패 → 나머지, 각 묶음 안은 시작 시각 내림차순.

### Workflow 상세
머리: 이름, 네임스페이스, phase, 진행, 시작·끝·걸린 시간, 원천 링크(Cron·템플릿 상세로), 실행한 사람(`workflows.argoproj.io/creator-email`·`creator` 레이블), [실패 단계로] 버튼(실패면), 동작 버튼.
- **개요**: 메시지, 조건(conditions), 입력 파라미터, entrypoint, ServiceAccount와 IAM 역할(context 연결일 때 `eks.amazonaws.com/role-arn`), `activeDeadlineSeconds`, `podGC`, `ttlStrategy`, 자원 사용량(`resourcesDuration` cpu·memory 초), 레이블.
- **단계**: `status.nodes`를 부모-자식(`children`)으로 들여 쓴 트리 + 같은 줄의 타임라인 막대(워크플로 시작~끝 기준, 실행 중이면 지금까지). 노드 종류(Pod, Steps, StepGroup, DAG, TaskGroup, Retry, Skipped, Suspend, Container)는 아이콘·흐린 글로 구분하고, StepGroup·TaskGroup은 접어서 보일 수 있다. 노드를 누르면 아래에 노드 상세: 메시지, 템플릿, 시작·끝, 재시도 횟수(Retry 노드 자식 수), 입력·출력 파라미터, 아티팩트 이름, exit code, Pod 이름 + [로그].
- **로그**: 노드 하나 또는 워크플로 전체(Pod별 색). 컨테이너(main 기본, init·wait 선택), follow(실행 중이면 켬), 최근 N줄(기본 1000). 검색·일시정지·자동 스크롤·JSON 줄 펼치기(기존 `PodLogs`의 버퍼·검색·JSON 표시 재사용). Pod가 없으면 안내.
- **이벤트**: context 연결일 때 Workflow와 그 Pod의 쿠버네티스 이벤트(시각, 종류, 사유, 메시지). 토큰 연결이면 "kubeconfig context로 연결하면 이벤트도 보여요".
- **YAML**: Workflow 전체(JSON을 YAML로, `managedFields` 빼고).
- [실패 단계로]: 실패한 Pod 노드 중 가장 먼저 끝난 것을 골라 단계 탭에서 노드 상세를 열고, 그 노드 로그의 마지막 50줄을 함께 보인다. 재시도로 결국 성공한 시도(성공한 Retry 노드 바로 아래의 시도, 또는 `boundaryId`로 거슬러 올라가 그런 시도 안에 든 Pod)는 뺀다. DAG의 `children`은 다음 작업으로 가는 흐름이라 포함 관계로 쓰지 않는다.

### CronWorkflows
- 열: 이름, 네임스페이스, 스케줄(사람 말 + 원문, 시간대), 다음 실행(상대 시각), 마지막 실행 결과, 최근 10회 막대(성공 초록 · 실패 빨강 · 실행 중 파랑, Workflow 목록의 `workflows.argoproj.io/cron-workflow` 레이블로 모음), 정지됨, concurrencyPolicy.
- 사람 말: `30 19 * * *` + `Asia/Seoul` → "매일 19:30 (Asia/Seoul)". 흔한 모양(매분·매시·매일·평일·요일·매월 n일, `@hourly` 등)만 바꾸고 나머지는 원문.
- 다음 실행: 백엔드가 스케줄·시간대로 다음 5회를 계산한다(`schedules` 여러 개, 옛 `schedule` 하나, `CRON_TZ=` 접두사).
- 놓친 실행: 직전 예정 시각 + `startingDeadlineSeconds`(없으면 5분)가 지났는데 `lastScheduledTime`이 그보다 이르면 "놓침".
- 상세: 스케줄과 다음 5회, 상태(활성 Workflow, 성공·실패 수), 실행 이력(이 Cron의 Workflow 목록, 누르면 Workflow 상세), workflowSpec 요약, YAML. 동작: 지금 실행, 정지, 재개, 삭제.

### 템플릿
- WorkflowTemplate(네임스페이스)과 ClusterWorkflowTemplate(`클러스터` 배지)을 한 목록에. 열: 이름, 범위, 파라미터 수, 이 템플릿을 쓰는 Cron 수, 최근 실행 성공률(Workflow 목록의 `workflows.argoproj.io/workflow-template`·`cluster-workflow-template` 레이블).
- 상세: 설명(annotation `workflows.argoproj.io/description`), 파라미터(이름, 기본값, enum, 설명), entrypoint와 템플릿 이름들, 쓰는 Cron, 최근 실행, YAML. 동작: 실행(파라미터 폼).

### 보관함
- `GET /api/v1/archived-workflows`. 비어 있거나 아카이브를 켜지 않은 서버면 "보관된 Workflow가 없어요. 서버에 아카이브를 켜지 않았을 수 있어요". 열은 Workflows와 같다. 상세는 같은 화면(이벤트·로그 없음). 동작: 다시 제출, Retry, 삭제.

### 점검
카드(건수와 위험/주의/참고 색, 누르면 아래 목록, 항목을 누르면 상세):
- 연속 실패 Cron(최근 실행 3회 이상 연달아 실패) — 위험
- 놓친 실행이 있는 Cron — 주의
- 오래 실행 중(1시간 넘게 Running이고 `activeDeadlineSeconds` 없음) — 주의
- 오래 대기(10분 넘게 Pending) — 주의
- 제한 시간 없는 Cron·템플릿(워크플로와 모든 템플릿에 `activeDeadlineSeconds` 없음) — 참고
- `default` ServiceAccount로 도는 Cron·템플릿 — 참고

## 조작
모든 조작은 확인 창을 거친다. 권한 판단과 기록은 Argo Server가 한다(클러스터에 직접 쓰지 않으므로 `k8s::hygiene` 예외 없음). 이름이나 네임스페이스에 `prod`가 들어가면 이름을 쳐야 [적용]이 켜진다(삭제·Terminate·Stop만). 동작이 끝나면 목록과 상세를 다시 읽고 "…했어요"를 3초 보인다. 실패하면 서버 메시지를 보이고 [다시 시도].

| 대상 | 동작 | API | 켜지는 때 |
|---|---|---|---|
| Workflow | Stop (exit handler는 돈다) | `PUT /api/v1/workflows/{ns}/{name}/stop` | Running·Pending |
| Workflow | Terminate (exit handler도 건너뜀) | `PUT …/terminate` | Running·Pending |
| Workflow | Suspend · Resume | `PUT …/suspend` · `…/resume` | Running · 정지됨 |
| Workflow | Retry (실패한 단계부터, [성공한 단계도 다시] 끔 기본) | `PUT …/retry` `{restartSuccessful, nodeFieldSelector?}` | Failed·Error |
| Workflow | 다시 제출 ([memoized] 끔 기본, 파라미터 바꾸기) | `PUT …/resubmit` `{memoized, parameters: ["k=v"]}` | 끝난 것 |
| Workflow | 삭제 | `DELETE /api/v1/workflows/{ns}/{name}` | 언제나 |
| 보관 Workflow | 다시 제출 · Retry · 삭제 | `PUT /api/v1/archived-workflows/{uid}/resubmit`·`/retry` (`{namespace, …}`), `DELETE …/{uid}` | |
| CronWorkflow | 지금 실행 | `POST /api/v1/workflows/{ns}/submit` `{resourceKind: "CronWorkflow", resourceName}` | |
| CronWorkflow | 정지 · 재개 · 삭제 | `PUT /api/v1/cron-workflows/{ns}/{name}/suspend`·`/resume`, `DELETE` | |
| 템플릿 | 실행 (파라미터 폼, 네임스페이스 선택은 ClusterWorkflowTemplate만) | `POST /api/v1/workflows/{ns}/submit` `{resourceKind, resourceName, submitOptions: {parameters}}` | |

실행·다시 제출이 만든 Workflow는 곧바로 상세로 연다.

## 계약 (Tauri 명령)
모든 명령은 `server: ArgoWfServerRef`를 받는다. 백엔드는 URL별로 인증 방식(context 이름 또는 토큰)을 그때마다 받은 값으로 정한다.

```ts
type ArgoWfServerRef = { url: string; context: string | null };
type ArgoWfSession = { url: string; version: string; identity: string; auth: "context" | "token"; kube: boolean /* 이벤트·IAM 역할을 읽을 수 있나 */; ssoProfile: string | null /* exec 플러그인의 AWS 프로필: 프론트가 명령의 최상위 profile로 넘겨 SSO 자동 로그인이 돈다 */ };
type KubeContext = { name: string; cluster: string; server: string | null };

argowf_contexts(): KubeContext[]
argowf_set_token(url: string, token: string): ArgoWfSession         // 확인하고 키체인에 저장
argowf_forget_token(url: string): void
argowf_session(server): ArgoWfSession | null                         // 토큰 방식인데 저장된 토큰이 없으면 null

type WfRow = {
  namespace: string; name: string; uid: string; resourceVersion: string;
  phase: "Pending" | "Running" | "Succeeded" | "Failed" | "Error" | "";
  message: string | null; progress: string | null;            // "3/7"
  startedAt: string | null; finishedAt: string | null;        // RFC3339
  cron: string | null; template: string | null; clusterTemplate: boolean;
  creator: string | null; suspended: boolean; archived: boolean;
  labels: Record<string, string>;
};
argowf_workflows(server): WfRow[]                                     // 모든 네임스페이스
argowf_archived(server): WfRow[]

type WfNode = {
  id: string; name: string; displayName: string;
  type: string; phase: string; message: string | null;
  templateName: string | null; templateScope: string | null;
  startedAt: string | null; finishedAt: string | null;
  children: string[]; boundaryId: string | null;
  podName: string | null;                                     // Pod 노드만(아래 규칙)
  exitCode: string | null;
  inputs: { name: string; value: string | null }[]; outputs: { name: string; value: string | null }[];
  artifacts: string[];                                        // 입출력 아티팩트 이름
  resourcesDuration: Record<string, number>;
};
type WfDetail = {
  row: WfRow; nodes: WfNode[];
  parameters: { name: string; value: string | null }[];
  entrypoint: string | null; serviceAccount: string | null;
  activeDeadlineSeconds: number | null; podGC: string | null; ttl: string | null;
  conditions: { type: string; status: string; message: string | null }[];
  resourcesDuration: Record<string, number>;
  yaml: string;
};
argowf_workflow(server, namespace: string, name: string): WfDetail
argowf_archived_workflow(server, uid: string): WfDetail
argowf_role_arn(server, namespace: string, serviceAccount: string): string | null   // context 연결만, 아니면 null

type K8sEventRow = { at: string | null; type: string; reason: string; message: string; object: string; count: number };
argowf_events(server, namespace: string, name: string): K8sEventRow[]    // Workflow + 그 Pod들. context 연결이 아니면 오류(화면이 안내)

type LogLine = { pod: string; text: string };
type WfLogMessage = { type: "lines"; lines: { pod: string; text: string }[] } | { type: "error"; error: AppError } | { type: "end" };
argowf_logs(server, namespace, name, podName: string | null, container: string, follow: boolean, tailLines: number | null, onEvent: Channel<WfLogMessage>): number   // 흐름 번호
argowf_logs_stop(id: number): void
type CronRow = {
  namespace: string; name: string; schedules: string[]; timezone: string | null;
  suspended: boolean; concurrencyPolicy: string | null; startingDeadlineSeconds: number | null;
  lastScheduledTime: string | null; active: string[];          // 활성 Workflow 이름
  succeeded: number | null; failed: number | null;
  nextRuns: string[];                                           // RFC3339, 최대 5
  missed: boolean;
  serviceAccount: string | null; hasDeadline: boolean;
  labels: Record<string, string>;
};
argowf_crons(server): CronRow[]
argowf_cron(server, namespace, name): { row: CronRow; entrypoint: string | null; template: string | null; parameters: { name: string; value: string | null }[]; yaml: string }

type TemplateRow = {
  kind: "WorkflowTemplate" | "ClusterWorkflowTemplate"; namespace: string | null; name: string;
  description: string | null; parameters: { name: string; value: string | null; enum: string[]; description: string | null }[];
  entrypoint: string | null; templates: string[];
  serviceAccount: string | null; hasDeadline: boolean;
};
argowf_templates(server): TemplateRow[]
argowf_template(server, kind, namespace: string | null, name): { row: TemplateRow; yaml: string }

type WfAction =
  | { kind: "stop" } | { kind: "terminate" } | { kind: "suspend" } | { kind: "resume" }
  | { kind: "retry"; restartSuccessful: boolean; nodeFieldSelector: string | null }
  | { kind: "resubmit"; memoized: boolean; parameters: string[] }
  | { kind: "delete" };
argowf_workflow_action(server, namespace, name, action: WfAction): string | null     // 새로 만든 Workflow 이름(resubmit)
argowf_archived_action(server, uid, namespace, action: retry | resubmit | delete): string | null
argowf_cron_action(server, namespace, name, action: { kind: "suspend" | "resume" | "delete" | "submit" }): string | null   // submit은 새 Workflow 이름
argowf_submit_template(server, kind, templateNamespace: string | null, namespace: string, name: string, parameters: string[]): string   // 새 Workflow 이름
```

- 오류는 기존 `AppError`. 401·403은 `{ kind: "other" }`가 아니라 토큰 오류로 구분할 수 있게 ArgoCD와 같은 고정 문구(`ARGOWF_TOKEN_INVALID`, `ARGOWF_TOKEN_MISSING`)를 쓴다. context 인증의 exec 실패는 기존 k8s 문구(`exec_failed`)를 쓴다. SSO 만료면 기존 SSO 자동 로그인이 동작하도록 `ssoExpired`로 바꾼다(exec 플러그인의 stderr가 기존 k8s 분류와 같은 신호일 때).
- Pod 이름: `workflows.argoproj.io/pod-name-format` 어노테이션이 `v1`이면 노드 id. 아니면 Argo `util.GeneratePodName`(v4.1.6) 규칙: 워크플로 이름 == 노드 이름이면 워크플로 이름, 노드 이름에 `.inline`이 없으면 접두사 `<워크플로>-<templateName>`, 아니면 `<워크플로>`; 접두사를 길이 제한으로 자르고 `-<fnv32a(노드 이름)>`.
- 서버 응답의 `managedFields`는 YAML에서 뺀다. 목록 응답은 `fields=` 쿼리로 필요한 칸만 받는다.

## 구조
- 백엔드 `src-tauri/src/argowf/`: `client.rs`(HTTP, 인증, 키체인, 401 재시도), `auth.rs`(kubeconfig context 토큰), `rows.rs`(응답 → 행·노드·상세, Pod 이름), `cron.rs`(다음 실행·놓침), `logs.rs`(스트림), `kube.rs`(이벤트, ServiceAccount). 명령 `src-tauri/src/argowf_commands.rs`.
- 프론트 `src/argowf/`: `ArgoWfTab`(연결·메뉴), `WorkflowList`, `WorkflowDetail`(`NodeTree`, `WfLogs`, `WfEvents`), `CronList`/`CronDetail`, `TemplateList`/`TemplateDetail`/`SubmitForm`, `ArchiveList`, `Findings`, `ActionDialog`, `cronText.ts`(사람 말), `findings.ts`(점검 순수 함수), `queries.ts`, `api.ts`, `text.ts`, `types.ts`.
- ArgoCD의 연결 부품(`ArgoSteps`, `ArgoServerEditor`, `ArgoTokenForm`)은 필요한 만큼 일반화해 함께 쓴다.

## 테스트
- 단위(Rust): 행·노드 파싱(실제 v4.1.6 응답 모양의 익명 픽스처: 단일 Pod + Retry, Steps, DAG, Suspend), Pod 이름 규칙, 다음 실행(시간대, 여러 스케줄, `CRON_TZ=`), 놓침, 토큰 머리, 401 재시도, exec 결과 파싱·만료, 오류 문구에 토큰이 없음.
- 단위(프론트): 사람 말 스케줄, 점검 함수, 목록 거르기·순서·칩 개수, 단계 트리·타임라인, 실패 단계 찾기, 조작 확인(이름 입력, 켜지는 때), 연결 단계.
- 실제 서버 대조: personal `stg-eks`의 Argo Server에서 읽기 화면을 확인한다. 조작은 실제 잡을 건드리지 않게 따로 만든 시험용 템플릿으로만 한다.

## 2차: Argo UI 기능 채우기 (사용자 결정 2026-11-03: "죄다 넣자")
Argo Workflows v4.1.6 UI(`ui/src/app-router.tsx`, `ui/src/workflows/components/*`)에 있고 1차에 없던 것을 모두 넣는다. 데스크톱 앱에서 그대로는 뜻이 없는 것(Widgets·공유 링크·API Docs·Help)은 같은 쓸모를 내는 모양으로 바꾼다. 계약은 `src/argowf/types.ts`·`api.ts`가 원본이다.

### 서버 정보와 네임스페이스
- `GET /api/v1/info`(`argowf_info`): `managedNamespace`, `links`, `columns`. managedNamespace가 있으면 모든 호출이 그 네임스페이스로 가고 네임스페이스 고르기는 잠긴다.
- 서버마다 `namespace`(설정)를 고를 수 있다: 모든 네임스페이스를 읽을 권한이 없는 신원은 하나를 고른다. 모든 네임스페이스 목록이 403이면 "네임스페이스를 골라 주세요"와 고르기를 띄운다.
- 고르기는 자유 입력이 아니라 드롭다운이다. Argo의 네임스페이스는 쿠버네티스 네임스페이스 그 자체지만 대부분에는 Argo 자원이 없으므로, 모든 네임스페이스로 읽은 Workflow(최대 500)·CronWorkflow·WorkflowTemplate·Event Binding이 있는 네임스페이스만 후보로 둔다(쿠버네티스 namespace 목록은 쓰지 않는다). 설정에 저장된 것은 지금 자원이 없어도 후보에 남는다. 후보를 하나도 못 찾는 신원(아직 아무것도 없는 클러스터, 한 네임스페이스만 볼 수 있는 토큰)만 "직접 넣기…"로 이름을 넣는다.
- `GET /api/v1/userinfo`(`argowf_userinfo`): **User Info** 화면(issuer, subject, groups, email, SA). [토큰 복사](`argowf_copy_token`)는 지금 쓰는 `Bearer …`를 클립보드에만 넣는다(CLI용, Argo UI와 같다).

### 목록(Workflows·보관함)
- 서버에서 거르기: 네임스페이스, 레이블 선택자(레이블 필터 칩을 선택자로 바꾼다), 이름(정확히·접두·포함), 만든 뒤·끝나기 전 날짜, phase. `listOptions.limit`(기본 200)과 `continue`로 페이지를 나누고 [더 보기]로 잇는다. 보관함도 같다.
- 실시간: 첫 페이지를 읽은 뒤 `GET /api/v1/workflow-events/{ns}`(SSE, `argowf_watch`)로 바뀐 것만 받는다. 끊기면 폴링(5초)으로 돌아갔다가 10초 뒤 다시 붙는다. 상세도 `argowf_watch_workflow`로 받는다.
- 여러 개 골라 Stop·Terminate·Suspend·Resume·Retry·다시 제출·삭제(`argowf_batch_action`, 하나씩 부르고 결과 표). 위험 이름 규칙은 고른 것 중 하나라도 걸리면 "선택한 N개"를 쳐야 켜진다.
- 열: 서버 info의 `columns` + 서버마다 고른 레이블 열(`labelColumns`). 행의 레이블을 누르면 그 레이블 필터가 붙는다. [내 것만](creator 레이블 = 세션 신원).
- 실행 중 행은 `estimatedDuration` 기준 진행 막대.
- 행을 고르면 지금처럼 오른쪽 상세(이것이 Argo UI의 drawer 역할).

### 상세
- **그래프** 탭: DAG/Steps를 층 배치로 그린 SVG(확대·축소·끌기, 가로/세로, phase·노드 종류 거르기, StepGroup·TaskGroup 접기, 아티팩트 노드 보이기). 노드를 누르면 아래 노드 상세. 트리+타임라인은 **단계** 탭에 그대로 둔다.
- 노드 동작: 노드 하나만 Retry(`nodeFieldSelector: id=<id>`, 파라미터 바꾸기 가능), Resume, Stop. Suspend 노드에서 [값 넣고 이어 가기]: 템플릿의 출력 파라미터(기본값·enum) 폼 → `PUT …/set`(`setOutputs`) → resume.
- 워크플로 Retry에도 파라미터 바꾸기.
- 노드 상세 추가: **Containers**(init·main·sidecar의 이미지, 명령, 인자, 작업 폴더, env 이름, 자원 요청·제한, 마운트), host node, memoization(적중·키·캐시), 예상 걸린 시간, 아티팩트(입·출력, 저장소 키).
- 아티팩트: 미리보기(글 1MB·이미지 5MB까지, JSON은 들여쓰기) `GET /artifact-files/{ns}/{workflows|archived-workflows}/{id}/{nodeId}/{inputs|outputs}/{name}`(서버 소스대로 복수형), [내려받기]는 저장 창 → 파일(`argowf_save_artifact`).
- 로그: 직전 컨테이너, 최근 N초부터, 시각 표시, [파일로 저장](`argowf_save_text`). Pod가 지워졌고 노드에 `main-logs` 아티팩트가 있으면(archiveLogs) 그것을 읽어 보인다.
- 개요 추가: 전역 출력 파라미터, 어디서 왔나(Cron·템플릿·다시 제출·이벤트·부모 Workflow 레이블), 동기화(mutex·semaphore 잡은 것·기다리는 것).
- 링크: info의 links(scope workflow → 상세 머리, pod·pod-logs → 노드 상세, workflow-list → 목록 머리, chat). `${metadata.namespace}`, `${metadata.name}`, `${status.startedAt}`, `${status.finishedAt}`, `${workflow.metadata.name}`, `${metadata.labels.<k>}` 등 Argo와 같은 자리 바꿈.
- 공유: [Argo UI에서 열기]·[링크 복사](`<server>/workflows/<ns>/<name>`).

### 만들기·고치기 (YAML 편집기)
- 편집기: 고정폭 글 상자(탭 → 두 칸, 줄 번호, 찾기는 브라우저 기본), [검사](`argowf_lint`), [만들기]·[저장]. YAML은 백엔드가 JSON으로 바꿔 보낸다(프론트에 YAML 파서를 넣지 않는다).
- Workflow: [새 Workflow](예제: hello-world, steps, dag, 파라미터), 상세의 [YAML로 고쳐 다시 제출](새 Workflow로 만든다).
- WorkflowTemplate·ClusterWorkflowTemplate·CronWorkflow: 만들기·고치기(`resourceVersion` 포함, 충돌이면 서버 메시지)·삭제.
- 템플릿 실행 폼: entrypoint 고르기, 레이블, generateName, ServiceAccount, 서버에서 검사만(dry run).

### Argo Events와 Event Bindings
- **Event Bindings**(`/api/v1/workflow-event-bindings/{ns}`): 이름, 선택자, 실행할 템플릿, 파라미터.
- **Event Sources**·**Sensors**(`/api/v1/event-sources/{ns}`, `/api/v1/sensors/{ns}`): 목록·상세·YAML·로그(`/api/v1/stream/event-sources/{ns}/logs`, `/api/v1/stream/sensors/{ns}/logs`)·만들기·고치기·삭제. Argo Events가 없으면(404·CRD 없음) "이 클러스터에 Argo Events가 없어요".
- **Event Flow**: Event Source → (이벤트) → Sensor 의존성 → 트리거 → 만든 Workflow를 열(column)로 잇는 그림.

### 그 밖의 화면
- **Reports**: 레이블 하나(보통 cron·template 레이블)를 고르면 그 Workflow들(살아 있는 것 + 보관함)의 실행마다 걸린 시간·CPU·메모리(resourcesDuration) 막대 차트와 성공/실패 색.
- **Plugins**: context 연결이면 `workflows.argoproj.io/configmap-type=ExecutorPlugin` ConfigMap 목록(이름, 설명, 이미지). 토큰 연결이면 Argo UI처럼 확인 명령과 문서 링크.
- **Widgets**: Workflow·Cron에서 [상태 배지 주소 복사]·[그래프 위젯 주소 복사](`<server>/widgets/workflow-status-badges/<ns>?label=…`, `<server>/widgets/workflow-graphs/<ns>?label=…`).
- **API Docs·Help**: 메뉴에서 브라우저로 연다(`<server>/apidocs`, Argo 문서).

### 왼쪽 메뉴
Workflows · CronWorkflows · 템플릿 · 클러스터 템플릿은 템플릿 안 · 보관함 · Reports · Event Flow · Event Sources · Sensors · Event Bindings · 점검 · User Info · Plugins · (링크) API Docs · Help.
