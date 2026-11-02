# 비용 관리 C2(`💰 비용` 탭) Implementation Plan

**Goal:** 사이드바 **💰 비용**이 프로필마다 하나인 `💰 비용` 탭을 연다. 탭은 C1 명령(`cost_overview`, `cost_breakdown`, `cost_tag_keys`, `cost_usage`)으로 요약 카드, 일별(월별) 추이 막대, 분해 표, 요청 계수기를 그린다. 읽기 전용이고 백엔드는 바꾸지 않는다.

**Spec (source of truth):** `docs/superpowers/specs/2026-10-30-cost-management-design.md`의 **공통**, **A. 비용 대시보드 탭**, **계약**. 계약의 TS 타입은 C1 계획의 **Contract**와 `src-tauri/src/cost/model.rs`를 그대로 옮긴다.

**Architecture (frontend only, `src/cost/`):**
- `types.ts`: `model.rs`의 거울.
- `text.ts`: 화면 문구 상수. 테스트는 이 상수와 비교한다.
- `api.ts`: `costApi.overview/breakdown/tagKeys/usage` (`invoke` 래퍼, 인자 이름은 명령과 같다).
- `queries.ts`: `costKeys`, `useCostOverview`, `useCostBreakdown`, `useCostTagKeys`, `useCostUsage`, `refreshCost`.
- `format.ts`: 금액·증감·비율·데이터 나이·날짜 범위 문구(순수).
- `drill.ts`: 분해 표 내려가기 규칙(순수).
- `CostTab.tsx`(머리말·조작·상태), `SummaryCards.tsx`, `DailyChart.tsx`(SVG), `BreakdownTable.tsx`.
- `App.tsx`·`Sidebar.tsx`·`styles.css` 연결.

**Tech Stack:** React 18 + TS, TanStack Query 5, Vitest. 새 의존성 없음.

## Decisions
1. **필터는 화면 전체에 건다.** 분해 표에서 내려가면 그 필터가 요약 카드·추이·분해 표에 모두 걸린다(`cost_overview`가 `filters`를 받고 `groupBy`만 무시하는 계약과 같다). 내려갈 때 드는 요청: 개요 3건(이번 달) + 분해 2건.
2. **개요 쿼리 키에는 `groupBy`를 넣지 않는다.** 분해 기준만 바꾸면 개요는 다시 부르지 않는다.
3. **새로고침(⌘R, 탭의 [새로고침])은 비용 탭이 보이는 탭일 때만 비용 조회를 새로 한다.** 다른 탭에서 ⌘R을 눌러 돈이 나가지 않게 한다. 순서:
   1. 지금 화면의 개요를 `refresh=true`로 다시 부르고 끝날 때까지 기다린다.
   2. 서비스별 분해는 개요와 같은 요청이므로 `refresh=false`(방금 쓴 캐시), 다른 기준의 분해와 태그 키는 `refresh=true`.
   3. 보이지 않는 쿼리는 낡음 표시만 한다(다시 보면 백엔드 캐시로 답해 돈이 들지 않는다).
4. **태그 키는 분해 기준에서 `태그`를 고를 때만 부른다**(요청 1건, 6시간 캐시).
5. **계수기**는 응답의 `requests > 0`이거나 태그 키를 받으면 다시 읽는다(`cost_usage`는 AWS를 부르지 않는다).
6. **금액 표시**: 계산은 백엔드 소수 문자열을 그대로 쓰고, 프론트는 표시·정렬·막대 높이에만 `Number`로 바꾼다.
7. **음수(크레딧을 빼지 않을 때)**: 막대는 양수 부분만 쌓고, 툴팁은 실제 값을 보여 준다.
8. **탭 제목**은 `💰 비용`, 머리말에 프로필·계정 ID를 적는다.
9. **내려가기 규칙**: 서비스 → 사용 유형, 리전 → 서비스, 태그 값 → 서비스, 사용 유형 → 없음(행을 누를 수 없다). 같은 차원 필터가 이미 걸린 기준으로는 내려가지 않는다(AND로 빈 결과가 된다).

## Exact strings (`src/cost/text.ts`)
- 사이드바·탭: `💰 비용`
- 기간: `이번 달`, `지난달`, `최근 30일`, `최근 6개월`. 지표: `청구액`, `상각 비용`. 토글: `크레딧·환불 빼기`.
- 머리말: `조직 관리 계정이면 조직 전체 합계예요`, 데이터 나이 `방금 받은 데이터`, `N분 전 데이터`, `N시간 전 데이터`.
- 카드: `합계`, `추정 포함`, `월말 예상`, `80% 구간 A ~ B`, `예상하기엔 데이터가 부족해요`(백엔드 문구 그대로), `비교 기간 대비`, `비교 기간 금액이 0이에요`.
- 빈 상태: `이번 달 데이터가 아직 없어요`, 버튼 `지난달 보기`.
- 분해: 기준 `서비스`, `리전`, `사용 유형`, `태그`. 열 `항목`, `이번 기간`, `비교 기간`, `증감액`, `증감률`, `비중`. 작은 항목 `작은 항목 N개`. 경로 루트 `전체`. 활성 태그 없음 `Billing 콘솔에서 비용 할당 태그를 켜야 해요`.
- 권한 안내(AccessDenied): `필요한 권한: ce:GetCostAndUsage, ce:GetCostForecast, ce:ListCostAllocationTags`, `관리 계정이 멤버 계정의 Cost Explorer 접근을 막았을 수 있어요`.
- 계수기: `이번 달 앱이 보낸 Cost Explorer 요청 N건 · 약 $X`.

## Tasks
### C2.1 데이터 계층
- `types.ts`, `text.ts`, `api.ts`, `queries.ts`, `format.ts`, `drill.ts`.
- 테스트: `format.test.ts`(금액·음수·통화 단위 이상값, 증감 부호, 데이터 나이 경계, 범위 끝 하루 빼기), `drill.test.ts`(다음 기준, 태그 값 추출 `team$a$b` → `a$b`, 빈 값 → 빈 문자열 필터, 같은 차원 차단, 경로 올라가기), `queries.test.tsx`(새로고침 순서와 `refresh` 인자).

### C2.2 화면
- `CostTab`: 머리말, 조작(기간·지표·크레딧), 오류(`ErrorState` + 권한 안내), 요약 카드, 추이, 분해, 계수기.
- `DailyChart`: 상위 5개 + 기타를 쌓은 SVG 막대. 막대에 마우스를 올리면 그날 서비스별 금액 툴팁. 범례.
- `BreakdownTable`: 정렬(기본 이번 기간 내림차순, 머리 누르면 바꿈), 작은 항목 줄은 맨 아래 고정, 비교 없는 기간은 비교 열을 숨긴다, 행을 누르면 내려간다, 이동 경로.
- 테스트 `CostTab.test.tsx`: 기간·지표·크레딧 전환이 쿼리 인자를 바꾼다, 내려가기·올라가기, 정렬, 1일 빈 상태와 지난달 버튼, 권한 오류 문구, 활성 태그 없음, 계수기, 툴팁.

### C2.3 연결
- `Sidebar`: `서비스` 묶음 위에 `💰 비용` 줄(`onOpenCost`).
- `App`: `costTab` 상태(하나), 탭 목록·닫기·프로필 전환 시 닫기, ⌘R이 비용 탭에서 `refreshCost`.
- 테스트 `App.test.tsx`: 사이드바로 열기, 프로필 바꾸면 닫힘, 비용 탭에서 ⌘R이 `refresh=true`로 개요를 부른다.

### C2.4 문서·데모
- README Requirements에 비용 권한, Features에 비용 탭. `docs/manual-test-checklist.md`에 비용 절(권한 없음, Cost Explorer 꺼짐, SSO 만료, 캐시 재사용, 계수기).
- `scripts/screenshots`에 비용 목업과 `cost.png`.

## Verification
- `npx tsc --noEmit`, `npx vitest run`.
- 데모 페이지(`scripts/screenshots/demo.html`)에서 탭을 열어 카드·추이·툴팁·내려가기를 눈으로 확인한다.
