# 비용 관리: 설계

## 목표
- 사이드바 **💰 비용**을 누르면 `💰 비용` 탭에서 지금 프로필 계정의 비용을 본다. 이번 달 누적, 월말 예상, 지난 기간 대비, 서비스·리전·사용 유형·태그별 분해, 일별 추이.
- 리소스 상세 패널에 **월 비용**을 보여준다. 기본은 정가 추정(Price List API)이고, 리소스 단위 데이터를 켠 계정이면 **실제 청구액(최근 14일)**을 불러올 수 있다.
- 읽기 전용. 비용·예산·이상 감지 설정을 바꾸는 API는 부르지 않는다.
- Cost Explorer API는 요청마다 돈이 든다($0.01/요청). 앱이 몇 번 불렀는지 화면에 보이고, 같은 조회는 캐시로 다시 부르지 않는다.

## 범위 밖
- Organizations 관리 계정의 연결 계정별 분해와 여러 프로필 합산. 단일 계정만 본다. 관리 계정으로 열면 숫자는 조직 전체 합계가 나온다. 관리 계정인지 알려면 권한(`organizations:DescribeOrganization`)과 호출이 더 필요하므로 따로 확인하지 않고, 머리말에 "조직 관리 계정이면 조직 전체 합계예요"를 늘 적는다.
- 예산, 이상 감지, 약정(Savings Plans·RI), 최적화 권고, 낭비 리소스 점검, 정리 작업. 아래 **나중 단계 (메모)**에 남긴다.
- 시간 단위 조회(추가 요금이 붙는 opt-in 기능).
- 원화 환산. 응답의 통화 단위(보통 USD)를 그대로 쓴다.

## 단계
릴리스는 모든 단계가 끝난 뒤 한 번 낸다. 각 단계는 설계의 해당 절을 범위로 계획 → 구현 → 리뷰를 따로 거친다.

| 단계 | 범위 |
|---|---|
| C0 | 실제 계정으로 확인하는 짧은 조사: 리소스 단위 조회의 `SERVICE` 필터 요구, 서비스별 `RESOURCE_ID` 형식, opt-in이 꺼진 계정의 오류 모양, Price List 필터 값. 결과를 이 문서의 표에 반영한다. |
| C1 | 백엔드 기반: Cost Explorer·Price List 클라이언트(us-east-1), 디스크 캐시, 요청 계수기, 오류 분류, 대시보드 명령 |
| C2 | `💰 비용` 탭 화면 |
| C3 | 상세 패널 정가 추정 |
| C4 | 상세 패널 실제 청구액(최근 14일) |

## 공통

### 클라이언트
- Cost Explorer와 리소스 단위 조회는 `us-east-1` 엔드포인트만 있다. 선택한 리전과 상관없이 `AwsContext::config(profile, "us-east-1")`로 만든다.
- Price List API는 `us-east-1`로 부른다(`ap-south-1`, `eu-central-1`도 있지만 쓰지 않는다).
- SSO 만료는 기존 `AppError::SsoExpired` 흐름을 그대로 탄다.

### 요청 비용과 캐시
- 캐시 파일: 앱 데이터 디렉터리의 `cost-cache.json`. 키는 `(계정 ID, 명령, 정규화한 요청)`, 값은 응답과 받은 시각.
- 유효 시간
  - Cost Explorer 응답: 6시간. AWS는 하루 최소 한 번 데이터를 갱신한다.
  - 리소스 단위 실제 청구액: 6시간.
  - Price List 응답: 7일. 무료지만 느리고 가격은 자주 바뀌지 않는다.
- 탭의 **새로고침**(⌘R)은 지금 화면의 Cost Explorer 조회만 캐시를 건너뛴다. 화면에는 "N시간 전 데이터"를 적는다.
- 요청 계수기: Cost Explorer로 실제 나간 요청(페이지마다 1건)을 `(계정, 연월)`별로 `cost-cache.json`에 센다. 탭 아래에 "이번 달 앱이 보낸 Cost Explorer 요청 N건 · 약 $X"를 보여준다. 캐시로 답한 조회는 세지 않는다.
- 캐시 파일이 깨졌거나 읽지 못하면 비우고 새로 쓴다. 비용 숫자 말고는 비밀이 없지만, 계정 ID가 들어 있으므로 다른 파일과 같은 디렉터리 권한을 쓴다.

### 오류
| 상황 | 표시 |
|---|---|
| `AccessDenied` | 필요한 권한(아래 **권한**)과 "관리 계정이 멤버 계정의 Cost Explorer 접근을 막았을 수 있어요" |
| Cost Explorer를 한 번도 켜지 않은 계정 | "Billing 콘솔에서 Cost Explorer를 처음 열면 켜져요(최대 24시간)" |
| `LimitExceededException` | 기존 `Throttled`와 같다 |
| `DataUnavailableException` | "이 기간의 비용 데이터가 아직 없어요" |
| 리소스 단위 데이터가 꺼짐 | "Cost Explorer 설정에서 리소스 단위 데이터를 켜면 볼 수 있어요" (C0에서 오류 모양 확인) |

### 읽기 전용 보장
- 백엔드 `src-tauri/src/cost/`만 Cost Explorer와 Price List를 부른다.
- 위생 테스트(`cost/hygiene.rs`): 소스에서 Cost Explorer 클라이언트 호출이 허용 목록(`get_cost_and_usage`, `get_cost_forecast`, `get_cost_and_usage_with_resources`, `list_cost_allocation_tags`)과 Price List `get_products`뿐인지 확인한다. `create_`, `update_`, `delete_`, `start_`, `provide_` 같은 호출이 있으면 실패한다.

## A. 비용 대시보드 탭

### 대상과 탭
- 사이드바의 `서비스` 묶음 위에 **💰 비용** 줄을 둔다. 누르면 `💰 비용` 탭이 열린다.
- 탭은 프로필마다 하나(IAM 탭과 같다). 프로필을 바꾸면 닫힌다. 리전과는 상관없다.
- 머리말: 프로필, 계정 ID, 데이터 시각, 새로고침, "조직 관리 계정이면 조직 전체 합계예요".

### 기간과 지표
- 기간: **이번 달**(기본), **지난달**, **최근 30일**, **최근 6개월**(월별).
- 비교 기간은 자동으로 정한다.
  - 이번 달 1일~어제 ↔ 지난달 1일~같은 날. 지난달이 더 짧으면 지난달 말일까지.
  - 지난달 ↔ 그 전달 전체.
  - 최근 30일 ↔ 그 앞 30일.
  - 최근 6개월은 비교 없이 월별 막대만.
- 지표: **청구액**(`UnblendedCost`, 기본), **상각 비용**(`AmortizedCost`, 약정 선결제를 나눠 반영).
- **크레딧·환불 빼기** 토글(기본 켬): `RECORD_TYPE`이 `Credit`, `Refund`인 줄을 필터로 뺀다.
- 날짜는 UTC다. Cost Explorer의 `End`는 포함하지 않는다. 이번 달 1일에는 "이번 달 데이터가 아직 없어요"와 지난달 버튼을 보여준다.

### 화면
1. **요약 카드**
   - 이번 기간 합계. `Estimated`가 참인 날이 있으면 "추정 포함" 표시.
   - 월말 예상(이번 달에서만): `GetCostForecast`, 오늘~다음 달 1일, 80% 예측 구간. 데이터가 모자라 실패하면 "예상하기엔 데이터가 부족해요".
   - 비교 기간 대비 증감액과 증감률.
2. **일별 추이**: 막대그래프. 비용 상위 5개 서비스와 "기타"를 쌓는다. 차트 라이브러리를 들이지 않고 SVG 컴포넌트로 그린다. 막대에 마우스를 올리면 그날 서비스별 금액이 보인다.
3. **분해 표**
   - 묶는 기준: **서비스**(기본), **리전**, **사용 유형**, **태그**.
   - 태그는 `ListCostAllocationTags(Status=Active)`로 고른다. 활성 태그가 없으면 "Billing 콘솔에서 비용 할당 태그를 켜야 해요".
   - 열: 항목, 이번 기간, 비교 기간, 증감액, 증감률, 비중. 기본 정렬은 이번 기간 내림차순이고 열 머리를 누르면 바꾼다.
   - 행을 누르면 그 항목으로 필터를 걸고 다음 기준으로 내려간다: 서비스 → 사용 유형, 리전 → 서비스, 태그 값 → 서비스. 위에 이동 경로(breadcrumb)를 보여 주고 눌러서 올라간다.
   - 0.005 미만인 행은 "작은 항목 N개"로 접는다.
4. **요청 계수기**(탭 아래 줄).

### 조회 횟수
- 화면 하나를 그리는 데 드는 요청:
  - 일별·서비스별 1건(페이지가 넘으면 더)
  - 비교 기간 1건
  - 예상 1건
  - 분해 기준을 바꾸면 기준마다 이번·비교 기간 2건
- 같은 기간·지표·필터는 6시간 동안 캐시로 답한다. 일별 추이와 서비스별 분해는 한 응답(`DAILY` + `GroupBy SERVICE`)을 같이 쓴다.

## E. 리소스별 월 비용

### 상세 패널
- `DetailPanel`의 키·값 목록 아래에 **비용** 절을 둔다.
  - **정가 추정**: "약 $X/월". 아래에 계산식 한 줄(예: `t3.medium Linux $0.052/h × 730h`)과 "온디맨드 정가 · 할인·약정·트래픽 빠짐".
  - **실제 청구액 보기** 버튼: 누르면 최근 14일 일별 청구액 작은 막대, 14일 합계, 30일 환산. "요청 1건($0.01)"을 버튼 옆에 적는다. 캐시가 있으면 바로 보여주고 "N시간 전"을 적는다.
- 추정이 안 되는 종류는 "사용량에 따라 달라서 정가로 추정하지 않아요" 문구와 실제 청구액 버튼만 보여준다.
- 실제 청구액 버튼은 Cost Explorer 리소스 단위 대상인 종류에서만 보인다(C0 결과로 확정).

### 정가 추정 대상
어댑터가 SDK에서 받은 값으로 `Resource.cost`를 채운다. 프론트는 원본 JSON을 다시 파싱하지 않는다.

| 리소스 | 입력 | 계산 |
|---|---|---|
| EC2 인스턴스 | 인스턴스 타입, `PlatformDetails`(OS·라이선스), 테넌시, 상태 | 시간당 정가 × 730. `stopped`면 $0과 "중지됨 · 연결된 EBS는 따로 과금". 스팟 인스턴스는 추정하지 않음 |
| EBS 볼륨 | 타입, 크기, IOPS, 처리량 | GB-월 × 크기. gp3는 3,000 IOPS·125 MiB/s 넘는 만큼, io1·io2는 프로비저닝 IOPS(io2는 구간별) |
| RDS 인스턴스 | 클래스, 엔진, Multi-AZ, 라이선스, 스토리지 타입·크기·IOPS | 인스턴스 시간당 × 730 + 스토리지. Aurora 인스턴스는 인스턴스만 계산하고 "Aurora 스토리지·I/O는 사용량이라 빠짐". Aurora Serverless는 추정하지 않음 |
| EKS 클러스터 | 버전 지원 상태 | 클러스터 시간당 × 730(표준·연장 지원 단가 구분) |
| EKS 노드그룹 | 인스턴스 타입, desired 수, 용량 유형 | EC2 시간당 × desired × 730. `SPOT`이면 추정하지 않음. 타입이 여럿이면 첫 타입으로 계산하고 그렇다고 적음 |
| Secrets Manager 시크릿 | (없음) | 시크릿당 월 정가 |

- 그 밖의 종류(Lambda, S3, DynamoDB, SQS, SNS, CloudFront, 로그 그룹, ECR, ECS 등)는 추정하지 않는다.
- Price List 조회: `GetProducts(ServiceCode, Filters=[TERM_MATCH regionCode, …])`, 온디맨드 `USD` 단가를 읽는다. 결과가 0개나 여러 개면 추정하지 않고 "정가를 찾지 못했어요"를 보여준다. 엉뚱한 값을 고르지 않는다. 필터 값은 C0에서 확정한다.
- 같은 `(서비스, 리전, 필터)`는 메모리와 디스크에 7일 캐시한다. 목록 화면에서는 부르지 않고, 상세 패널을 열 때만 부른다.

### 실제 청구액 조회
- `GetCostAndUsageWithResources`, `Granularity=DAILY`, 기간 = 14일 전~오늘.
- 필터: `RESOURCE_ID = <리소스 ID>`. API 문서상 `SERVICE` 필터가 필요할 수 있으므로 `Resource.cost`에 Cost Explorer 서비스 이름도 둔다. 두 값의 형식은 C0에서 확정한다(EC2는 `i-…`, 다른 서비스는 ARN일 수 있음).
- 지표는 대시보드에서 고른 지표를 따르고, 탭이 없으면 `UnblendedCost`.

## 권한
- 대시보드: `ce:GetCostAndUsage`, `ce:GetCostForecast`, `ce:ListCostAllocationTags`
- 실제 청구액: `ce:GetCostAndUsageWithResources`와 Cost Explorer 설정의 리소스 단위 데이터(일 단위) 켜기. 켠 뒤 최대 48시간 걸리고, 3개월 동안 아무도 안 보면 AWS가 끈다.
- 정가 추정: `pricing:GetProducts`
- README의 Requirements에 같은 목록을 넣는다.

## 계약 (Tauri 명령)
```ts
type CostPeriod = "thisMonth" | "lastMonth" | "last30Days" | "last6Months";
type CostMetric = "UnblendedCost" | "AmortizedCost";
type CostGroupBy = { kind: "service" | "region" | "usageType" } | { kind: "tag"; key: string };
type CostFilter = { dimension: "SERVICE" | "REGION" | "USAGE_TYPE"; value: string } | { tag: string; value: string };
type CostQuery = { period: CostPeriod; metric: CostMetric; excludeCredits: boolean; filters: CostFilter[]; groupBy: CostGroupBy };

cost_overview(profile, query: CostQuery, refresh: boolean): CostOverview
  // 요약, 일별 상위 5개+기타, 예상(이번 달만), 데이터 시각
cost_breakdown(profile, query: CostQuery, refresh: boolean): CostBreakdown
  // 행: key, current, previous, delta, share. 작은 항목 묶음 포함
cost_tag_keys(profile): string[]
cost_usage(profile): { yearMonth: string; requests: number }   // 요청 계수기
cost_estimate(profile, region, subject: CostSubject): CostEstimate | { unsupported: string }
cost_resource_actual(profile, target: { ceService: string; resourceId: string }, metric: CostMetric, refresh: boolean): CostDaily
```
- `Resource`에 `cost: { subject: CostSubject | null; actual: { ceService: string; resourceId: string } | null } | null`를 더한다. 비용과 상관없는 종류는 `null`.
- `CostSubject`는 위 표의 리소스별 입력을 담은 태그 유니온(`ec2Instance`, `ebsVolume`, `rdsInstance`, `eksCluster`, `eksNodegroup`, `secret`)이다.
- 금액은 문자열 소수(Cost Explorer `Amount` 그대로)로 받아 백엔드에서 `rust_decimal`로 더하고, 응답은 소수 문자열과 단위로 돌려준다. 부동소수 누적 오차를 피한다.

## 구조
- 의존성: `aws-sdk-costexplorer`, `aws-sdk-pricing`, `rust_decimal`. 프론트는 새 의존성 없음.
- 백엔드 `src-tauri/src/cost/`
  - `client.rs`: us-east-1 클라이언트, 요청 계수, 페이지 순회.
  - `cache.rs`: `cost-cache.json` 읽기·쓰기, 유효 시간, 계수기.
  - `period.rs`: 기간·비교 기간 계산(순수 함수, 오늘 날짜를 인자로).
  - `overview.rs`, `breakdown.rs`: 요청 만들기와 응답 가공(순수 함수).
  - `estimate.rs`: `CostSubject` → Price List 필터, 단가 파싱, 금액 계산.
  - `actual.rs`: 리소스 단위 조회.
  - `hygiene.rs`: 읽기 전용 위생 테스트.
- `src-tauri/src/cost_commands.rs`: Tauri 명령.
- 어댑터(`ec2.rs`, `rds.rs`, `eks.rs`, `secretsmanager.rs`)는 `Resource.cost`만 채운다.
- 프론트 `src/cost/`: `CostTab.tsx`, `SummaryCards.tsx`, `DailyChart.tsx`(SVG), `BreakdownTable.tsx`, `ResourceCost.tsx`(상세 패널 절), `api.ts`, `queries.ts`.

## 테스트
- 단위(Rust)
  - 기간 계산: 1일, 말일, 2월, 31일 → 30일 달, 연말 넘김, UTC 경계
  - 요청 만들기: 필터 조합, 크레딧 빼기, 태그 기준
  - 응답 가공: 상위 5 + 기타, 작은 항목 묶음, `Estimated` 전파, 비교 기간에만 있는 항목, 소수 덧셈
  - 캐시: 키 정규화, 유효 시간, 새로고침, 깨진 파일 복구, 계수기 월 넘김
  - 오류 분류
  - 정가 추정: Price List JSON 픽스처로 단가 파싱, 0개·여러 개 결과, gp3 추가분, io2 구간, 중지된 인스턴스, 스팟 노드그룹
- 프론트(Vitest): 기간·지표 전환, 분해 표 내려가기·올라가기, 정렬, 빈 상태와 오류 문구, 계수기, 상세 패널 비용 절(추정·미지원·실제 청구액 버튼·캐시 표시).
- 실제 계정 대조: `scripts/cost-live-test.sh <profile>`이 `#[ignore]` 테스트를 돌린다. 대시보드 한 화면, 정가 추정 종류마다 1건, 실제 청구액 1건. 돌리기 전에 Cost Explorer 요청 수(약 10건 ≈ $0.10)를 출력한다.
- `docs/manual-test-checklist.md`에 비용 절을 더한다: 권한 없음, Cost Explorer 꺼짐, 리소스 단위 꺼짐, SSO 만료, 캐시 재사용, 계수기.

## 나중 단계 (메모)
1차(A, E)에서 뺀 후보. 순서는 우선순위가 아니다.

- **B. 이상 비용 감지**: `ce:GetAnomalies`, `GetAnomalyMonitors`. 이상 목록, 원인(서비스·사용 유형·리전), 대시보드 일별 추이에 표시.
- **C. 예산 현황**: `budgets:ViewBudget`(`DescribeBudgets`). 예산 대비 실적·예측, 초과 위험 배지.
- **D. 낭비 리소스 점검**: IAM 보안 점검과 같은 형식. 기존 어댑터를 쓰고 Cost Explorer는 거의 안 부른다. 연결 안 된 EBS, 연결 안 된 EIP·공인 IPv4, 트래픽 적은 NAT Gateway·로드밸런서, 오래된 스냅샷, 중지된 인스턴스의 EBS, 보존 기간 무기한 로그 그룹, S3 미완료 멀티파트 업로드, 수명 주기 정책 없는 ECR, gp2 볼륨, 구세대 인스턴스 타입. 금액은 E의 정가 추정을 재사용한다. NAT Gateway·ELB·EIP 어댑터가 먼저 필요하다.
- **F. 약정 현황**: `ce:GetSavingsPlansUtilization`, `GetSavingsPlansCoverage`, `GetReservationCoverage`, `GetReservationUtilization`. 사용률, 커버리지, 만료 임박.
- **G. 최적화 권고**: Cost Optimization Hub, Compute Optimizer(둘 다 opt-in). 크기 조정, gp2→gp3, Graviton 전환과 예상 절감액.
- **H. 정리 작업(쓰기)**: D에서 찾은 항목을 앱에서 처리. 스냅샷 뒤 볼륨 삭제, EIP 해제, 로그 보존 기간 설정, S3·ECR 수명 주기 규칙. IAM 쓰기처럼 미리보기(API 호출·예상 절감액) → 위험하면 이름 입력 → 변경 기록 → 되돌리기. 쓰기는 한 파일에만 둔다.
- **I. 지도·쿠버네티스 연동**: VPC 다이어그램에 NAT·LB 비용, EKS 네임스페이스별 요청량 기준 비용 추정.
- **Organizations 연결 계정별 분해, 여러 프로필 합산**: 이번에는 단일 계정만.
