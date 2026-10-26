# IAM 작업 공간 — 설계

날짜: 2026-10-26 · 상태: 승인됨 (레이아웃 A안, 직접 변경 포함)

## 목표
콘솔에서 IAM을 다룰 때 불편한 일을 한 탭에서 끝낸다.
1. 사용자·역할이 **실제로 무엇을 할 수 있는지** 정책을 합쳐 서비스별로 보여준다.
2. **누가 이 작업을 할 수 있는지** 역검색한다.
3. **보안 점검**: 오래된 키, MFA 없음, 안 쓰는 주체, 위험 권한, 외부에 열린 신뢰를 찾는다.
4. **권한 줄이기**: 안 쓰는 서비스 권한을 찾아 뗄 정책과 줄인 정책 초안을 제안한다.
5. **직접 변경**: 미리보기·경고·확인·기록·되돌리기를 거쳐 안전하게 바꾼다.

## 범위 밖
사용자·역할·그룹 생성/삭제, 신뢰 정책 수정, 액세스 키 생성(비밀 키를 다루지 않는다), 비밀번호·MFA 설정, 역할 신뢰 관계 그래프, 두 주체 권한 비교, 조직 SCP·리소스 기반 정책·세션 정책 평가.

## 화면
- 탭 하나: id `iam`, 제목 `🔐 IAM · <계정ID>`, 닫기 가능. 프로필을 바꾸면 닫힌다. 리전과 무관(IAM은 글로벌).
- 여는 곳: 사이드바 IAM 서비스 아래 첫 항목 "🔐 IAM 관리", 리소스 탭 IAM의 Users/Roles/Policies 목록에서 더블클릭(Enter) → 해당 대상으로 연다. 이미 열려 있으면 그 탭에서 대상으로 이동한다.
- 레이아웃: 왼쪽 메뉴 | 가운데 본문 | (선택 시) 오른쪽 상세.
  - 메뉴: 🛡 점검(건수) · 👤 사용자 · 👥 그룹 · 🎭 역할 · 📜 정책 · 🔎 누가 할 수 있나 · 🕘 변경 기록
  - 목록 화면에서 항목을 열면 본문이 상세로 바뀌고, 뒤로/앞으로(마우스 3·4번 버튼 네이티브 이벤트 `mouse-nav`, ⌘[ / ⌘])로 오간다.
- 사용자·역할 상세: 이름·ARN·배지 + 하위 탭
  - **권한**: 서비스 × 접근 수준(목록·읽기·쓰기·권한 관리·태그) 표. 칸 = 허용/조건부/거부 수. 칸을 누르면 오른쪽에 실제 작업 목록, 대상 리소스, 근거(정책·그룹·문장 Sid·조건 여부). 위험 작업 표시.
  - **정책**: 직접/그룹 상속/인라인/권한 경계 목록 + [붙이기] [떼기] [인라인 추가] [편집] [삭제]
  - **그룹**(사용자): [그룹에 추가] [빼기] / 그룹 상세에서는 구성원 목록
  - **액세스 키**(사용자): 상태·나이·마지막 사용 + [비활성화]/[활성화] [삭제]
  - **신뢰**(역할): 누가 이 역할을 맡을 수 있는지(서비스·계정·연동·누구나) + 경고
  - **안 쓰는 권한**: 서비스별 마지막 사용 시각, 통째로 안 쓰는 정책 [떼기], 줄인 정책 초안 [복사] [인라인 정책으로 저장]
- 정책 상세: 문장을 읽기 쉽게 푼 표(효과·서비스별 작업·대상·조건) + JSON + 버전 + 붙어 있는 대상 + (편집 가능하면) [편집]
- 누가 할 수 있나: 작업 입력(자동 완성) + 대상 ARN(선택) → 결과 표(주체·결과·근거) + [AWS로 확인](정책 시뮬레이터)
- 점검: 카드(건수·심각도) → 대상 목록 + CLI 명령 복사 + 빠른 조치(변경 미리보기로 연결)
- 변경 기록: 시각·요약·성공/실패 + [되돌리기]
- 모든 화면 위에 한 줄 안내: "조직 SCP와 리소스 기반 정책은 반영하지 않아요"

## 권한 계산 규칙
- 데이터: `iam:GetAccountAuthorizationDetails`(User/Group/Role/LocalManagedPolicy, 끝까지 페이지). AWS 관리형 정책은 통째로 받지 않고, 사용자·그룹·역할에 붙어 있거나 권한 경계로 쓰이는데 목록에 없는 관리형 정책만 `GetPolicy`+`GetPolicyVersion`으로 기본 버전 문서를 읽는다(10개씩 동시에, 자격 증명 보고서를 기다리는 동안. SSO 만료·요청 제한은 오류, 그 밖의 실패는 경고). 정책 문서는 URL 인코딩돼 있으니 디코드 후 JSON 파싱.
- 정책 문장 정규화: `Action`/`NotAction`/`Resource`/`NotResource`는 문자열 또는 배열. `Condition` 유무 기록. `Statement`가 객체 하나일 수도 있다.
- 작업 매칭: 대소문자 무시 glob(`*`, `?`). 서비스 접두어 포함(`s3:Get*`, `*`).
- 리소스 매칭: 대소문자 구분 glob(`*`, `?`). `${...}` 정책 변수는 `*`로 바꿔 먼저 맞춰 본다. 그래도 안 맞으면 안 맞는 것이고, 맞으면 값에 따라 달라지니 조건부.
- 카탈로그: AWS Service Reference(https://servicereference.us-east-1.amazonaws.com/)에서 만든 스냅숏을 앱에 넣는다(`src-tauri/src/iam/catalog.json`, `scripts/update-iam-catalog.mjs`로 갱신). 작업별 접근 수준: IsPermissionManagement → permissions, IsTaggingOnly → tagging, IsWrite → write, IsList → list, 그 외 read.
- 주체의 정책 출처: 사용자 = 사용자 인라인 + 사용자 관리형 + 소속 그룹 인라인·관리형, 역할 = 역할 인라인 + 관리형, 그룹 = 그룹 인라인 + 관리형. 권한 경계는 별도.
- 작업별 판정. Allow가 하나도 매칭되지 않는 작업은 Deny만 있어도 표와 "누가 할 수 있나"에서 제외한다(원래 허용되지 않으므로). 권한 경계 정책의 Deny도 Deny로 본다.
  - 대상 리소스를 지정했을 때(누가 할 수 있나): 문장의 Resource/NotResource가 그 ARN에 매칭될 때만 적용한다. 조건 없는 Deny → `denied`. 경계가 조건 없이 허용하지 않으면, 아예 허용하지 않을 때 `boundary`, 조건부로만 허용할 때 `conditional`. 조건 있는 Deny가 맞거나 조건 있는 Allow만 있으면 `conditional`. 그 외 `allowed`.
  - 대상 리소스를 지정하지 않았을 때(권한 표): 신원 정책 Allow의 리소스 패턴 하나하나를 조각으로 보고 차례로 따진다.
    1. 조건 없는 Deny가 통째로 덮는 조각을 지운다. NotResource Deny는 제외 목록과 겹치지 않는 조각을 덮는다. 남는 것이 없으면 `denied`.
    2. 권한 경계가 있으면 남은 조각을 경계 Allow의 조각과 하나씩 겹친다. 한쪽이 `*`면 다른 쪽이 남고, 한쪽이 다른 쪽을 포함하면 좁은 쪽이 남는다. 일부만 겹치면 신원 쪽 패턴으로 근사한다. 경계가 이 작업을 허용하지 않거나 겹치는 것이 없으면 `boundary`.
    3. 겹친 조각에 조건 없는 Deny를 다시 적용한다. 남는 것이 없으면 `denied`.
    4. 남은 조각 가운데 연 문장(신원 Allow, 경계 Allow)이 모두 조건 없고 조건 있는 Deny도 덮지 않는 것이 있으면 `allowed`, 없으면 `conditional`.
  - 허용 리소스(`resources`)는 남은 조각의 라벨이다. NotResource 조각은 `* (제외: …)`로 적는다. 일부 리소스에만 걸린 Deny는 근거에 함께 보여준다.
- 카탈로그에 없는 작업 이름은 `unknownActions`로 따로 보여준다. 정책을 해석하지 못한 주체는 "누가 할 수 있나" 결과에서 빠지고, 안내(`notes`)에 이름을 적는다.
- 관리자급(`adminLike`): 조건 없는 Allow 문장이 `Action:"*"`(또는 `"*:*"`)와 `Resource:"*"`를 갖거나(경계·Deny 적용 후에도 유지될 때), 아래 `full_scope` 작업이 카탈로그 전체의 90% 이상.
  - `full_scope`는 판정 결과에 함께 나온다. 조건 없는 (신원 Allow, 경계 Allow) 문장 쌍으로 모든 리소스(NotResource 목록만 뺀 나머지 포함)에서 허용됐다는 뜻이다.
  - 리소스를 좁혀 허용했거나(`Resource:"arn:aws:s3:::b/*"` 위의 `Action:"*"` 등) 조건이 맞아야 모든 리소스에 열리는 작업은 세지 않는다.
  - "모든 리소스에 대한 권한 관리" 위험 표시도 같은 `full_scope`를 쓴다.
- 권한 상승 위험(`privesc`): 아래 작업 중 하나라도 `Resource:"*"`로 조건 없이 허용: iam:CreatePolicyVersion, iam:SetDefaultPolicyVersion, iam:PassRole, iam:CreateAccessKey, iam:CreateLoginProfile, iam:UpdateLoginProfile, iam:AttachUserPolicy, iam:AttachGroupPolicy, iam:AttachRolePolicy, iam:PutUserPolicy, iam:PutGroupPolicy, iam:PutRolePolicy, iam:AddUserToGroup, iam:UpdateAssumeRolePolicy, iam:PutUserPermissionsBoundary, iam:PutRolePermissionsBoundary, iam:DeleteUserPermissionsBoundary, iam:DeleteRolePermissionsBoundary, sts:AssumeRole.
- 신뢰 정책 해석: Allow + `sts:AssumeRole*`/`sts:TagSession` 문장의 Principal. `*`/`{"AWS":"*"}` → 누구나(조건 없으면 위험), 다른 계정 ID/ARN → 외부 계정(`sts:ExternalId` 조건 없으면 경고), `Service` → 서비스, `Federated` → 연동(OIDC/SAML 공급자 이름).

## 보안 점검 규칙 (기준 90일 = `STALE_DAYS`)
자격 증명 보고서: `GenerateCredentialReport` → 완료될 때까지 폴링(최대 20초) → `GetCredentialReport`(CSV).
| kind | 조건 | 심각도 | 빠른 조치 |
|---|---|---|---|
| rootAccessKey | 루트에 활성 액세스 키 | danger | 없음(CLI 불가, 콘솔 안내) |
| rootNoMfa | 루트 MFA 없음 | danger | 없음 |
| consoleNoMfa | 비밀번호 사용 + MFA 없음 | danger | 없음(CLI 안내) |
| oldAccessKey | 활성 키의 마지막 교체가 90일 초과 | warn | 키 비활성화 |
| unusedAccessKey | 활성 키가 90일 넘게 안 쓰임(또는 만든 지 90일 넘었는데 한 번도 안 씀) | warn | 키 비활성화 |
| inactiveUser | 비밀번호·키 모두 90일 넘게 안 쓰임(만든 지 90일 이상) | info | 없음 |
| inactiveRole | 역할 마지막 사용 90일 초과 또는 기록 없음(서비스 연결·SSO 역할 제외, 만든 지 90일 이상) | info | 없음 |
| adminPrincipal | adminLike 사용자·역할 | warn | 없음 |
| privescPrincipal | privesc 사용자·역할(adminLike 제외) | warn | 없음 |
| externalTrust | 누구나 또는 외부 계정에 열린 신뢰 | danger(누구나, 조건 없음)/warn | 없음 |
| unattachedPolicy | 붙은 곳 없는 고객 관리형 정책 | info | 없음 |
각 항목에 복사용 CLI 명령(예: `aws iam update-access-key --user-name alice --access-key-id AKIA… --status Inactive`).

## 권한 줄이기
- `GenerateServiceLastAccessedDetails(Granularity=ACTION_LEVEL)` → 폴링(최대 30초) → `GetServiceLastAccessedDetails`. 추적 기간 400일.
- "안 씀": 추적 기간 동안 한 번도 쓰지 않았거나, 마지막 사용이 `completedAt`보다 90일(`STALE_DAYS`) 넘게 전. 허용된 서비스 목록에 이 기준으로 표시한다.
- 통째로 안 쓰는 정책: 그 정책이 허용하는 서비스가 전부 안 쓰이면 [떼기]를 제안한다. 그룹에서 상속한 정책은 그룹에서 떼야 한다고 안내한다. 만든 지 90일이 안 됐거나, 만든 날짜나 사용 기록 시각을 모르는 주체에는 제안하지 않고 안내만 한다.
- 줄인 정책 초안: 지금보다 넓게 허용하지 않는다.
  - 조건 없는 Allow 문장에서 지금 `allowed`인 작업만 가져온다. 조건부로만 허용된 작업은 빼고, 뺀 것을 안내(`draftNotes`)에 적는다.
  - 작업 단위 기록이 있는 서비스에서는 기록됐는데 최근 90일 안에 안 쓴 작업을 뺀다. 기록되지 않는 작업(데이터 플레인 등)은 남긴다. 기록이 없는 서비스는 지금 허용된 작업을 그대로 남긴다.
  - Resource는 원래 허용 패턴을 유지한다. 와일드카드(`s3:*` 등)는 원래 문장이 그 범위를 덮을 때만 쓴다.
  - 초안에 남긴 작업을 막을 수 있는 Deny 문장은 원문 그대로 옮긴다. 초안이 와일드카드로 연 서비스에서 카탈로그에 없는 작업을 막을 수 있는 Deny도 옮긴다.
  - 다음 경우에는 초안을 만들지 않는다.
    - Deny 원문을 찾지 못했다.
    - 읽지 못한 신원 정책이 있다.
    - 버전이 2012-10-17이 아닌 문서의 Deny가 Resource·NotResource·Condition에 `${…}`를 쓴다. 지금은 글자 그대로 비교하지만 초안에서는 변수로 풀려 덜 막을 수 있기 때문이다.
  - 버전이 2012-10-17이 아닌 문서에서 `${…}` 리소스를 쓰는 Allow 문장은 넣지 않는다. 초안에서는 변수로 풀려 더 넓어지기 때문이다.
  - 초안이 그 주체 종류의 인라인 정책 한도나 관리형 정책 한도(6,144자)를 넘으면 안내한다.

## 직접 변경
변경 종류(`IamChange`): attachPolicy, detachPolicy, addToGroup, removeFromGroup, setAccessKeyStatus, deleteAccessKey, putInlinePolicy, deleteInlinePolicy, updateManagedPolicy(CreatePolicyVersion SetAsDefault=true, 버전이 5개면 가장 오래된 비기본 버전을 먼저 삭제).
- 모든 변경은 `iam_preview` → 사용자 확인 → `iam_apply`. 백엔드가 apply 때 미리보기를 다시 계산해 막힘이면 거부, 확인 문구가 필요하면 일치해야 진행.
  - 미리보기와 적용은 같은 방법으로 최신 스냅숏(60초가 넘었거나 쓰기 뒤 10초 안이면 다시 읽음)과 키 상태 등을 읽는다. 미리보기가 본 계획(계정, 요약, 호출과 모든 인자, 막힘·확인 문구, 확인 문구, 되돌릴 수 있는지)을 (프로필, 변경)마다 10분 동안 최대 50개 기억하고, 적용 때 다시 계산한 계획이 다르거나 미리보기가 없으면 "미리보기 뒤에 IAM이 바뀌었어요. 미리보기를 다시 받아 주세요."로 거부. 미리보기 하나로는 한 번만 적용.
- 미리보기: 호출할 API와 인자, 영향받는 주체별 권한 증감(서비스·접근 수준 단위), 경고.
  - 되돌릴 수 있는지(`reversible`): 역변경이 없거나, 적용하면 앱의 자격 증명이 역변경의 API를 쓸 수 없게 되거나 조건 없이 쓰던 그 API가 조건부가 되면 false(확인 경고에 그 API를 적는다). 기록에는 역변경이 그대로 남아서 권한이 있는 다른 자격 증명으로는 되돌릴 수 있다.
- 경고 규칙:
  - block: 대상이 서비스 연결 역할(path `/aws-service-role/`), Identity Center 역할(path `/aws-reserved/sso.amazonaws.com/` 또는 이름 `AWSReservedSSO_*`), AWS 관리형 정책 편집, 잘못된 JSON, 정책 문서 6,144자(관리형)/2,048자(사용자 인라인)/5,120자(그룹 인라인)/10,240자(역할 인라인) 초과
  - confirm(대상 이름 입력): 앱이 지금 쓰는 자격 증명의 주체(호출자 사용자/역할, 또는 호출자가 속한 그룹)에 대한 권한 축소(허용 → 조건부도 포함), 변경 결과 영향받는 주체가 새로 adminLike/privesc가 됨, deleteAccessKey, deleteInlinePolicy, 앱이 쓰는 액세스 키를 끄거나 지움(되돌릴 수 없음, 확인 문구는 키 ID), 버전을 지워야 하는 관리형 편집인데 Access Analyzer로 문서를 검사하지 못함, 문서를 읽지 못한 정책(신원 정책·권한 경계, 또는 스냅숏에 없는 소속 그룹)이 영향받는 주체에게 새로 적용되거나 더는 적용되지 않음(그 정책이 주던 권한을 몰라 증감을 다 계산하지 못함. 붙일 정책을 그 자리에서 읽다가 SSO 만료·요청 제한이 나면 미리보기도 오류)
  - block 추가: 버전을 지워야 하는 관리형 편집에서 Access Analyzer가 ERROR를 냄(적용 때도 다시 검사해 거부)
  - warn: 태그 `aws:cloudformation:stack-name`이 있는 대상(스택이 되돌릴 수 있음), 버전 5개라 가장 오래된 버전 삭제, 영향받는 주체가 5명 이상, 다른 사용자·역할의 일부 권한이 조건부로 바뀜, 문서를 읽지 못해 계산에서 뺀 정책이 그대로 남음, 붙일 정책을 읽지 못한 이유(빠진 권한 등)
- 변경 기록: 앱 데이터 폴더 `iam-changes.jsonl`(한 줄 = 한 변경). 되돌리기용 역변경 저장: attach↔detach, add↔remove, 키 상태 반대, 인라인 put/delete는 이전 문서로 복원(없었으면 delete), 관리형 편집은 이전 기본 버전 문서로 다시 편집. deleteAccessKey는 되돌릴 수 없음.
- 적용 후 스냅숏 캐시 무효화. IAM 반영 지연을 고려해 화면은 3초 뒤 강제 새로고침.
- IAM 쓰기 API 호출은 `src-tauri/src/iam/write.rs`에만 둔다. 리소스 브라우저 어댑터는 읽기 전용 유지.

## 필요한 권한
읽기: iam:GetAccountAuthorizationDetails, iam:GetPolicy, iam:GetPolicyVersion, iam:ListPolicies, iam:GenerateCredentialReport, iam:GetCredentialReport, iam:GenerateServiceLastAccessedDetails, iam:GetServiceLastAccessedDetails, iam:ListAccessKeys, iam:GetAccessKeyLastUsed, iam:SimulatePrincipalPolicy, sts:GetCallerIdentity, access-analyzer:ValidatePolicy(선택). 선택 권한이 없으면 그 기능만 경고와 함께 비활성.
쓰기: 사용하는 변경의 API 권한.

## 계약 (Tauri 명령 · JSON, serde camelCase)
```ts
// 읽기
iam_overview(profile: string, force: boolean): IamOverview
iam_principal(profile: string, arn: string): PrincipalView
iam_principal_actions(profile: string, arn: string, prefix: string, level: AccessLevel): ActionGrant[]
iam_policy(profile: string, policyId: string): PolicyView      // policyId = 관리형 ARN 또는 "inline:<ownerArn>:<name>"
iam_actions(): string[]                                         // "s3:GetObject" … 카탈로그 전체, 정렬
iam_who_can(profile: string, action: string, resource: string | null): WhoCanResult
iam_simulate(profile: string, principalArns: string[], action: string, resource: string | null): SimulateResult[]
iam_findings(profile: string): Findings
iam_access_keys(profile: string, userName: string): AccessKeyInfo[]
iam_last_accessed(profile: string, arn: string): LastAccessed
iam_list_policies(profile: string, query: string): PolicyRef[]  // 붙이기 선택용(고객 관리형 + AWS 관리형, 이름 부분 일치, 최대 100)
iam_validate_policy(profile: string, document: string): ValidationResult
// 쓰기
iam_preview(profile: string, change: IamChange): ChangePreview
iam_apply(profile: string, change: IamChange, confirmText: string | null, undoOf: string | null): ApplyResult
iam_change_log(): ChangeLogEntry[]                              // 최신순
iam_undo_change(entryId: string): IamChange                     // 역변경을 돌려줌(미리보기 후 apply(undoOf=entryId))

type PrincipalKind = "user" | "group" | "role";
type AccessLevel = "list" | "read" | "write" | "permissions" | "tagging";
type Level = "danger" | "warn" | "info";
type BadgeKind = "admin" | "privesc" | "noMfa" | "oldKey" | "unusedKey" | "inactive" | "externalTrust"
  | "cfn" | "sso" | "serviceLinked" | "boundary" | "unattached" | "awsManaged";
interface Badge { kind: BadgeKind; label: string; level: Level }

interface IamOverview {
  accountId: string;
  caller: { arn: string; principalArn: string | null };   // principalArn: 호출자 IAM 사용자/역할 ARN(SSO 역할 포함), 알 수 없으면 null
  fetchedAt: string;
  users: PrincipalSummary[]; groups: PrincipalSummary[]; roles: PrincipalSummary[];
  policies: PolicySummary[];                                // 고객 관리형 전체 + 붙어 있는 AWS 관리형
  findingCount: number;
  warnings: string[];
}
interface PrincipalSummary {
  arn: string; name: string; kind: PrincipalKind; path: string; createdAt: string | null;
  lastUsed: string | null; policyCount: number; memberCount: number | null;   // memberCount: 그룹만
  badges: Badge[];
}
interface PolicySummary {
  id: string; arn: string; name: string; scope: "aws" | "local"; attachmentCount: number;
  defaultVersionId: string | null; updatedAt: string | null; badges: Badge[];
}
interface PrincipalView {
  summary: PrincipalSummary;
  policies: AttachedPolicy[];
  groups: string[];                 // 사용자: 소속 그룹 이름, 그룹: 구성원 사용자 이름, 역할: []
  trust: TrustEntry[];              // 역할만
  services: ServicePermissions[];   // 허용/조건부/거부가 하나라도 있는 서비스, 이름순
  adminLike: boolean;
  unknownActions: string[];
  tags: Record<string, string>;
  notes: string[];
}
interface AttachedPolicy {
  id: string; name: string; kind: "managed" | "inline" | "boundary"; scope: "aws" | "local" | null;
  via: string | null;               // 그룹에서 상속되면 그룹 이름
  badges: Badge[]; detachable: boolean;
}
interface ServicePermissions { prefix: string; name: string; levels: Record<AccessLevel, LevelCell>; danger: boolean }
interface LevelCell { total: number; allowed: number; conditional: number; denied: number }   // denied = denied + boundary
interface ActionGrant {
  action: string; status: "allowed" | "conditional" | "denied" | "boundary";
  resources: string[]; sources: GrantSource[]; danger: string | null;
}
interface GrantSource {
  policyId: string; policyName: string; via: string | null; effect: "Allow" | "Deny";
  sid: string | null; statementIndex: number; conditional: boolean; boundary: boolean;
}
interface TrustEntry {
  kind: "service" | "account" | "federated" | "anyone" | "principal"; value: string;
  actions: string[]; conditional: boolean; external: boolean; warning: string | null;
}
interface PolicyView {
  id: string; name: string; scope: "aws" | "local" | "inline"; arn: string | null;
  document: string; statements: StatementView[];
  versions: { id: string; isDefault: boolean; createdAt: string | null }[];
  attachedTo: { arn: string; name: string; kind: PrincipalKind }[];
  editable: boolean; badges: Badge[];
}
interface StatementView {
  sid: string | null; effect: "Allow" | "Deny";
  notAction: boolean; actionPatterns: string[];
  services: { prefix: string; name: string; levels: AccessLevel[]; count: number }[];
  notResource: boolean; resources: string[];
  conditions: string[];              // "aws:SourceIp · IpAddress · 10.0.0.0/8"
}
interface WhoCanResult { action: string; resource: string | null; hits: WhoCanHit[]; notes: string[] }
interface WhoCanHit { principal: PrincipalSummary; status: "allowed" | "conditional" | "denied" | "boundary"; sources: GrantSource[] }
interface SimulateResult { principalArn: string; decision: "allowed" | "explicitDeny" | "implicitDeny"; matchedStatements: string[]; missingContext: string[] }
type FindingKind = "rootAccessKey" | "rootNoMfa" | "consoleNoMfa" | "oldAccessKey" | "unusedAccessKey" | "inactiveUser"
  | "inactiveRole" | "adminPrincipal" | "privescPrincipal" | "externalTrust" | "unattachedPolicy";
interface Findings { generatedAt: string | null; groups: FindingGroup[]; warnings: string[] }   // groups: 위 표 순서, 빈 그룹도 포함(items: [])
interface FindingGroup { kind: FindingKind; title: string; level: Level; items: FindingItem[] }
interface FindingItem { targetArn: string; targetName: string; detail: string; cli: string | null; fix: IamChange | null }
interface AccessKeyInfo {
  id: string; status: "Active" | "Inactive"; createdAt: string | null; ageDays: number | null;
  lastUsedAt: string | null; lastUsedService: string | null; lastUsedRegion: string | null;
  lastUsedUnknown?: boolean;        // 마지막 사용을 읽지 못함(권한 없음 등). true면 lastUsed*가 null이어도 "사용 기록 없음"이 아니다
}
interface LastAccessed {
  completedAt: string | null; trackingDays: number;
  services: { prefix: string; name: string; lastUsed: string | null; actions: { action: string; lastUsed: string | null }[] | null }[];
  unusedPolicies: { policyId: string; name: string; via: string | null; reason: string }[];
  draft: string | null; draftNotes: string[];
}
interface PolicyRef { arn: string; name: string; scope: "aws" | "local"; description: string | null; badges: Badge[] }
interface ValidationResult {
  syntaxError: string | null; analyzerAvailable: boolean;
  findings: { level: "error" | "securityWarning" | "warning" | "suggestion"; code: string; message: string }[];
}
type IamChange =
  | { op: "attachPolicy"; target: string; policyArn: string }          // target = 사용자/그룹/역할 ARN
  | { op: "detachPolicy"; target: string; policyArn: string }
  | { op: "addToGroup"; userName: string; groupName: string }
  | { op: "removeFromGroup"; userName: string; groupName: string }
  | { op: "setAccessKeyStatus"; userName: string; accessKeyId: string; status: "Active" | "Inactive" }
  | { op: "deleteAccessKey"; userName: string; accessKeyId: string }
  | { op: "putInlinePolicy"; target: string; name: string; document: string }
  | { op: "deleteInlinePolicy"; target: string; name: string }
  | { op: "updateManagedPolicy"; policyArn: string; document: string };
// serde: #[serde(tag = "op", rename_all = "camelCase")] + 필드 camelCase
interface ChangePreview {
  change: IamChange; summary: string;
  calls: { api: string; params: Record<string, string> }[];
  impacts: Impact[];                // 최대 30명(앱이 쓰는 주체는 늘 포함)
  impactsOmitted?: number;          // impacts에 넣지 못한 주체 수. 0이면 보내지 않음(없으면 0)
  warnings: { level: "block" | "confirm" | "warn"; message: string }[];
  confirmText: string | null;       // confirm 경고가 있으면 입력해야 할 문자열(대상 이름)
  reversible: boolean;
}
interface Impact {
  principal: PrincipalSummary;
  gained: PermDelta[]; lost: PermDelta[];   // 방향마다 작업이 많은 (prefix, level) 줄 최대 20개, 순서는 prefix·level
  restricted?: PermDelta[];                 // 조건 없이 허용되다가 조건부가 된 작업. 비면 보내지 않음(없으면 [])
  gainedOmitted?: number; lostOmitted?: number; restrictedOmitted?: number;   // 한도로 뺀 줄 수. 0이면 보내지 않음(없으면 0)
}
interface PermDelta { prefix: string; level: AccessLevel; count: number; sample: string[] }   // sample 최대 5개
interface ApplyResult { logId: string; summary: string }        // 실패하면 AppError(기록은 남김)
interface ChangeLogEntry {
  id: string; at: string; profile: string; accountId: string; callerArn: string;
  change: IamChange; summary: string; calls: string[]; ok: boolean; error: string | null;   // calls: 실제로 성공한 호출(실패하면 그 앞까지)
  inverse: IamChange | null; undoOf: string | null; undone: boolean;
}
```

## 구조
- Rust `src-tauri/src/iam/`: `catalog.rs`(+`catalog.json`), `policy.rs`(문서 파싱·매칭), `eval.rs`(주체 권한·누가 할 수 있나·위험 판정·신뢰 해석), `findings.rs`(자격 증명 보고서 CSV·점검 규칙), `lastused.rs`(권한 줄이기), `change.rs`(미리보기·경고·역변경, 순수), `write.rs`(유일한 IAM 쓰기 호출), `log.rs`(변경 기록), `fetch.rs`(AWS 읽기), `mod.rs`(스냅숏 타입·캐시) + `src-tauri/src/iam_commands.rs`.
- 프론트 `src/iam/`: `types.ts`, `api.ts`, `queries.ts`, `IamTab.tsx`(메뉴·기록), 화면별 컴포넌트, `ChangePreviewDialog.tsx`, 편집기.
- 공통 패턴 재사용: `ErrorState`, `ConfirmDialog` 스타일, `DetailPanel`, 탭 `hidden`+`active`, `onMouseNav`.

## 테스트
- Rust 순수 함수: 문서 디코드·정규화, 작업/리소스 glob, NotAction/NotResource, Deny 우선, 경계 교집합, 조건부 처리, 정책 변수, adminLike/privesc, 신뢰 해석, 자격 증명 보고서 파싱과 점검 규칙(고정 날짜), 권한 줄이기 초안, 경고 규칙, 역변경, 변경 기록 왕복, 영향 계산.
- 프론트: 메뉴·목록·상세·권한 표·드릴다운·누가 할 수 있나·점검 카드·미리보기(이름 입력)·변경 기록·되돌리기·탭 열기/재사용/프로필 변경 시 닫힘.
- 실제 변경은 테스트 계정에서 수동 확인(체크리스트).
