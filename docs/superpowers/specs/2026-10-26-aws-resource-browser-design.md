# Magic Mirror — AWS 리소스 브라우저 설계

- 작성일: 2026-10-26
- 상태: 승인됨 (구현 계획 작성 전)
- 목업: `.superpowers/brainstorm/96031-1792994350/content/layout.html` (로컬 전용, git 미포함)

## 1. 목적

AWS 콘솔에 접속하거나 복잡한 CLI 호출 없이, 데스크탑 앱에서 서비스별 리소스를 빠르게 **조회**한다.
Forklift 스타일의 3단(사이드바 · 목록 · 상세) 레이아웃을 사용하고, 사용자가 자주 쓰는 서비스만 켜서 본다.

## 2. 범위

### 포함

- `~/.aws/config` 프로필(SSO 포함) 중 하나와 리전 하나를 선택해 조회
- 16개 서비스의 리소스 목록/상세 조회 (서비스별 개별 API 사용)
- 서비스 활성화 설정: 체크한 서비스만 사이드바에 표시·조회
- 즐겨찾기: 리소스 타입을 사이드바 상단에 고정
- S3 버킷 → prefix → 객체 탐색 (조회 전용)
- ID/ARN 복사, AWS 콘솔에서 열기, 원본 데이터 보기(SDK 응답의 Debug 출력)
- 목록 정렬 및 이름/ID 텍스트 필터

### 제외 (YAGNI)

- 리소스 생성/수정/삭제, 시작/중지 등 모든 변경 작업
- S3 업로드/다운로드
- 여러 프로필 또는 여러 리전 동시 조회
- 리소스 간 관계 그래프, 비용 정보
- Secrets Manager 시크릿 **값** 조회 (메타데이터만 표시)

## 3. 기술 스택

- **Tauri 2** (Rust 백엔드 + 웹 프론트엔드), macOS 우선
- **Rust**: `aws-config`, 서비스별 `aws-sdk-*` 크레이트, `tokio`, `serde`
- **프론트엔드**: React + TypeScript + Vite, TanStack Query(서버 상태/캐시)
- **테스트**: Rust `cargo test`, 프론트엔드 Vitest + Testing Library

## 4. 화면

목업과 동일한 3단 구조.

```
┌──────────────────────────────────────────────────────────────┐
│ [프로필 ▾]  [리전 ▾]                  🔍 필터(⌘F)   ⟳(⌘R)   ⚙  │
├──────────────┬───────────────────────────────┬───────────────┤
│ 즐겨찾기      │ 경로: EC2 › Instances   N개    │ 상세 패널      │
│ 서비스 트리    │ 정렬 가능한 표                  │ 필드/태그/ARN  │
│  (켜진 것만)   │                               │ [콘솔] [JSON]  │
├──────────────┴───────────────────────────────┴───────────────┤
│ 상태바: 프로필 · 계정 ID · 리전 · 마지막 새로고침                   │
└──────────────────────────────────────────────────────────────┘
```

- **사이드바**: 즐겨찾기 섹션 + 활성화된 서비스 트리. 서비스를 펼치면 리소스 타입과 개수가 표시된다. 리소스 타입에서 우클릭하면 즐겨찾기를 추가/제거한다.
- **목록**: 리소스 타입별 칼럼 정의(§6)에 따라 표를 그린다. 칼럼 헤더 클릭으로 정렬, ⌘F 필터는 이름/ID 부분일치.
- **S3**: Buckets 목록에서 행을 더블클릭하면 해당 버킷의 prefix로 들어간다. 경로(breadcrumb)를 클릭하면 상위로 이동한다.
- **상세 패널**: 선택한 리소스의 필드, 태그, ARN(복사), "AWS 콘솔에서 열기", "원본 데이터 보기"(모달).
- **서비스 설정(⚙)**: 16개 서비스 체크박스 시트. 변경 즉시 사이드바에 반영되고 저장된다.
- **키보드**: ↑↓ 행 이동, ⌘C 선택 리소스 ID 복사, ⌘F 필터, ⌘R 새로고침.

## 5. 아키텍처

### 5.1 Rust 백엔드 (`src-tauri/src/`)

```
aws/
  context.rs     프로필 목록 파싱, (profile, region) → SdkConfig 생성·캐시, STS로 계정 ID 조회
adapters/
  mod.rs         ResourceAdapter trait, 레지스트리(서비스 ID → 어댑터)
  ec2.rs s3.rs lambda.rs rds.rs ecs.rs eks.rs vpc.rs iam.rs dynamodb.rs
  logs.rs cloudfront.rs sqs.rs sns.rs ecr.rs route53.rs secretsmanager.rs
model.rs         ResourceType, Resource, ListResult, ServiceInfo; error.rs: AppError
commands.rs      Tauri 커맨드
settings.rs      settings.json 읽기/쓰기
```

**ResourceAdapter trait**

```rust
#[async_trait]
pub trait ResourceAdapter: Send + Sync {
    fn service_id(&self) -> &'static str;          // "ec2"
    fn display_name(&self) -> &'static str;        // "EC2"
    fn is_global(&self) -> bool;                   // 리전 무관 여부
    fn resource_types(&self) -> Vec<ResourceType>; // 타입 ID, 표시명, 칼럼 정의
    async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError>;
}
```

목록 응답 하나에 상세 패널용 정보까지 모두 담는다(별도 `get` 호출 없음). 목록 API만으로 칼럼을 채울 수 없는 서비스(DynamoDB, SQS, SNS, EKS, ECS)는 어댑터 안에서 항목별 describe 호출을 동시성 8로 수행한다.

**데이터 모델**

- `ResourceType { id, name, columns: Vec<Column { key, label, kind } > }` — `kind`: `text | mono | state | datetime | bytes`
- `Resource { id, name, arn: Option<String>, values: Map<String, String>, tags: Map<String, String>, fields: Vec<Field { label, value }>, raw: String, console_url: Option<String> }` — `values`는 표 칼럼, `fields`는 상세 패널 전용 추가 정보, `raw`는 SDK 응답 타입의 `{:#?}` 출력(SDK 타입은 serde 직렬화를 지원하지 않음)
- `ListResult { items: Vec<Resource>, truncated: bool }`
- `AppError` (직렬화되어 프론트로 전달): `SsoExpired`, `AccessDenied { action }`, `Throttled`, `Network { message }`, `Other { message }`

SDK 응답 → 모델 변환은 어댑터 안의 **순수 함수**(`fn instance(&aws_sdk_ec2::types::Instance, ..) -> Resource` 등)로 분리해 단위 테스트한다.

**Tauri 커맨드**

| 커맨드 | 입력 | 출력 |
|---|---|---|
| `list_profiles` | — | 프로필 이름 목록, 각 프로필의 기본 리전 |
| `get_account` | profile | 계정 ID (STS GetCallerIdentity) |
| `list_services` | — | 전체 16개 서비스의 ID/이름/리소스 타입/칼럼 |
| `list_resources` | profile, region, service, type | `ListResult` |
| `list_s3_objects` | profile, bucket, prefix, continuation_token | 폴더/객체 목록 + 다음 토큰 |
| `sso_login` | profile | `aws sso login --profile <p>` 실행 완료까지 대기 |
| `get_settings` / `save_settings` | — / Settings | Settings |

### 5.2 프론트엔드 (`src/`)

```
api/          Tauri invoke 래퍼 + 타입 (Rust 모델과 1:1)
components/   Toolbar, Sidebar, ResourceTable, DetailPanel, S3Browser, ServiceSettings, JsonModal, ErrorState
hooks/        useResources, useS3Objects, useSettings (TanStack Query)
App.tsx       레이아웃 + 선택 상태(profile, region, service, type, selectedId, s3Path)
```

## 6. 서비스별 리소스 타입

| 서비스 | 리소스 타입 | 주요 칼럼 | 비고 |
|---|---|---|---|
| EC2 | Instances | Name, Instance ID, State, Type, Private IP, AZ | |
| | Security Groups | Name, Group ID, VPC, Description | |
| | Volumes | Name, Volume ID, State, Size, Type, Attached To | |
| S3 | Buckets | Bucket name, Region, Created | 전역, 객체 탐색 지원 |
| Lambda | Functions | Function name, Runtime, Memory, Last modified | |
| RDS | DB Instances | Identifier, Engine, Class, Status, Endpoint | |
| | DB Clusters | Identifier, Engine, Status, Endpoint | |
| ECS | Clusters | Name, Status, Services, Running tasks | |
| | Services | Name, Cluster, Status, Desired/Running | 모든 클러스터 순회 |
| | Tasks | Task ID, Cluster, Status, Task definition | 모든 클러스터 순회 |
| EKS | Clusters | Name, Version, Status, Endpoint | |
| | Node Groups | Name, Cluster, Status, Instance types, Size | 모든 클러스터 순회 |
| VPC | VPCs | Name, VPC ID, CIDR, Default | EC2 API 사용 |
| | Subnets | Name, Subnet ID, VPC, CIDR, AZ | EC2 API 사용 |
| IAM | Users | Name, User ID, Created, Last used | 전역 |
| | Roles | Name, Role ID, Created, Description | 전역 |
| | Policies | Name, Policy ID, Attachments, Updated | 전역, 고객 관리형만 |
| DynamoDB | Tables | Name, Status, Items, Size, Billing mode | |
| CloudWatch Logs | Log Groups | Name, Retention, Stored bytes, Created | |
| CloudFront | Distributions | ID, Domain, Aliases, Status, Enabled | 전역 |
| SQS | Queues | Name, Type(Standard/FIFO), Messages, URL | |
| SNS | Topics | Name, ARN, Subscriptions | |
| ECR | Repositories | Name, URI, Created, Scan on push | |
| Route53 | Hosted Zones | Name, Zone ID, Private, Record count | 전역 |
| Secrets Manager | Secrets | Name, Description, Last changed, Rotation | 값 조회 금지 |

전역 서비스는 리전 선택과 무관하게 동일한 결과를 보여주며, 캐시 키에서 리전을 제외한다.
"주요 칼럼"에 없는 정보는 상세 패널(`fields`, `raw`)에 표시한다.

## 7. 데이터 흐름

1. 앱 시작 → `get_settings`, `list_profiles`, `list_services`. 마지막 프로필/리전을 복원(없으면 첫 프로필과 그 기본 리전).
2. 리소스 타입 선택 → `list_resources`. 백엔드는 페이지네이션을 따라가며 최대 **1,000개**까지 모으고, 초과 시 "1,000개까지만 표시" 안내를 함께 반환한다.
3. 프론트는 TanStack Query 캐시(키: profile, region|global, service, type)를 사용. `staleTime`은 무한대로 두고 ⌘R 또는 프로필/리전 변경 시에만 다시 조회한다.
4. 사이드바에서 서비스를 펼치면 그 서비스의 모든 타입에 대해 `list_resources`를 병렬 실행해 개수를 채운다(같은 캐시 공유 → 클릭 시 즉시 표시). 앱 시작 시 일괄 조회는 하지 않는다.
5. 행 선택 → 목록 응답에 이미 들어 있는 정보로 상세 패널을 즉시 표시.
6. S3 prefix 진입 → `list_s3_objects`(delimiter `/`, 1,000개 단위). 버킷 리전은 Buckets 목록의 Region 값(`GetBucketLocation`)을 사용해 해당 리전 클라이언트로 호출한다. 다음 토큰이 있으면 표 하단 "더 보기".
7. 설정 변경 → `save_settings`. 위치: Tauri app data dir의 `settings.json`
   ```json
   { "enabledServices": ["ec2","s3"], "favorites": [{"service":"ec2","type":"instances"}],
     "lastProfile": "prod-sso", "lastRegion": "ap-northeast-2" }
   ```
   첫 실행 기본값: 16개 서비스 전부 활성화, 즐겨찾기 없음.

## 8. 오류 처리

| 상황 | 감지 | 표시 |
|---|---|---|
| SSO 토큰 만료/미로그인 | 자격 증명 로딩 실패(SSO 토큰 관련) | 목록 영역에 "SSO 세션이 만료됐어요" + [로그인] → `sso_login` 후 해당 쿼리 재시도 |
| 권한 없음 | `AccessDenied*`/`UnauthorizedOperation` 오류 코드 | 해당 타입 목록에만 "권한 없음 (ec2:DescribeInstances)" — 다른 타입은 정상 동작, 사이드바 개수는 `—` |
| Throttling | SDK 기본 재시도 이후에도 실패 | 오류 메시지 + [다시 시도] |
| 네트워크/기타 | 그 외 | 메시지 원문 + [다시 시도] |
| 프로필 없음 | `list_profiles` 결과 비어 있음 | 전체 화면 안내: `aws configure sso` 실행 방법 |

오류는 리소스 타입 단위로 격리되며, 하나의 실패가 다른 목록이나 앱 전체를 막지 않는다.

## 9. 테스트

- **Rust 단위 테스트**: 각 어댑터의 SDK 타입 → `Resource` 변환 함수를 SDK 빌더로 만든 고정 입력으로 검증(이름 태그 없음, 선택 필드 누락 등 경계 포함). 오류 분류(`AppError` 매핑), 설정 파일 읽기/쓰기(파일 없음 → 기본값), 프로필 파싱 테스트. 실제 AWS 호출 없음.
- **프론트엔드 테스트 (Vitest + Testing Library)**: `api` 계층을 mock하여 사이드바 서비스 필터링/즐겨찾기, 표 정렬·필터, S3 경로 이동과 breadcrumb, 오류 상태 렌더링을 검증.
- **수동 체크리스트**: 실제 SSO 프로필로 16개 서비스의 모든 리소스 타입 목록·상세 확인, 리전 전환, SSO 만료 후 로그인 흐름, 권한 없는 타입 표시.

## 10. 확장 지점

새 서비스 추가 = `adapters/`에 파일 하나 추가 + 레지스트리 등록. 프론트엔드는 `list_services` 결과로 사이드바·칼럼을 그리므로 수정이 필요 없다.
