# 비용 관리 C1(백엔드 기반) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The backend for the `💰 비용` tab. Four Tauri commands (`cost_overview`, `cost_breakdown`, `cost_tag_keys`, `cost_usage`) read AWS Cost Explorer for the profile's account. Every Cost Explorer page the app sends is counted per account and month. Answers are kept in an on-disk cache for 6 hours so the same view does not cost money twice.

**Architecture:**
- `src-tauri/src/cost/` (new):
  - `period.rs`: civil dates and the period → range rules (pure).
  - `model.rs`: the command contract types (serde).
  - `expr.rs`: our own request type `CeRequest`. It is the cache key, and it builds the SDK `Expression`s.
  - `table.rs`: `CeTable`, our serializable copy of a Cost Explorer answer, plus decimal helpers.
  - `client.rs`: the only code that calls Cost Explorer. It pages, counts and maps errors.
  - `cache.rs`: `cost-cache.json` (entries, TTL, request counter).
  - `overview.rs`, `breakdown.rs`: turn `CeTable`s into the contract shapes (pure).
  - `mock_aws.rs` (test only): a recording JSON-protocol HTTP client.
  - `hygiene.rs` (test only).
  - live tests: `#[ignore]` module `live_tests` inside `cost_commands.rs` (they drive the private `overview_with`/`breakdown_with`).
- `src-tauri/src/cost_commands.rs` (new): `CostState` and the commands.
- `src-tauri/src/lib.rs`: `mod cost; mod cost_commands;`, `app.manage(CostState)`, register the commands.

**Tech Stack:**
- New crates: `aws-sdk-costexplorer` 1 and `rust_decimal` 1, added with `cargo add`.
- Existing: `aws-smithy-*`, `serde_json`, `tokio`, `tempfile` (dev).
- No date crate. `period.rs` does civil-date math itself (Howard Hinnant's `days_from_civil` / `civil_from_days`).

**Spec (source of truth):** `docs/superpowers/specs/2026-10-30-cost-management-design.md`. Read the sections **C0 결과**, **공통**, **A. 비용 대시보드 탭** and **계약** before starting.

## Global Constraints
- UI copy is Korean 해요체. Code identifiers, comments in new files may follow the repo (Korean comments are the norm), commit messages are English, `type(cost): …`.
- **Read-only.** No Cost Explorer call other than `GetCostAndUsage`, `GetCostForecast`, `ListCostAllocationTags`. `aws_sdk_costexplorer` is used only under `src-tauri/src/cost/`. `hygiene.rs` enforces both.
- **Client region.** Cost Explorer clients are built from `state.ctx.config(profile, GLOBAL_REGION)` (`us-east-1`), never the selected region.
- **Amounts.** Amounts stay decimal strings end to end. Sums use `rust_decimal::Decimal`, never `f64`. Only `deltaPct` and `share` (display percentages) are `f64`.
- **Dates.** Dates are UTC `YYYY-MM-DD`. Ranges are `[start, end)`, as in Cost Explorer. Pure functions take `today: Ymd` and never read the clock.
- Errors use the existing `AppError` variants only (no new variant; the frontend's `errorMessage` stays as is).
- Tests:
  - Rust: `cargo test` and `cargo clippy --all-targets -- -D warnings` are clean.
  - No test talks to AWS, except `#[ignore]` live tests.
  - Unit tests for SDK calls go through `cost/mock_aws.rs` and assert on what was actually sent.
- Only `src-tauri/` and `scripts/` change in C1. The frontend (C2) is planned separately.
- Branch: `final-lee/cost-dashboard` (worktree `~/orca/workspaces/magic-mirror/cost-dashboard`).

## Contract (Rust ⇄ JSON; C2 types mirror this exactly)
```rust
// model.rs — all structs #[serde(rename_all = "camelCase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
pub enum CostPeriod { ThisMonth, LastMonth, Last30Days, Last6Months }
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CostMetric { UnblendedCost, AmortizedCost }               // JSON "UnblendedCost" | "AmortizedCost"
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)] #[serde(tag = "kind", rename_all = "camelCase")]
pub enum CostGroupBy { Service, Region, UsageType, Tag { key: String } }
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)] #[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CostDimension { Service, Region, UsageType }               // JSON "SERVICE" | "REGION" | "USAGE_TYPE"
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)] #[serde(untagged)]
pub enum CostFilter { Dimension { dimension: CostDimension, value: String }, Tag { tag: String, value: String } }
pub struct CostQuery { pub period: CostPeriod, pub metric: CostMetric, pub exclude_credits: bool, pub filters: Vec<CostFilter>, pub group_by: CostGroupBy }

pub struct DateRange { pub start: String, pub end: String }        // [start, end)
pub struct Forecast { pub mean: String, pub low: String, pub high: String }
pub struct Bucket { pub start: String, pub total: String, pub values: Vec<String> /* aligned with series */, pub other: String }
pub struct CostOverview {
    pub account_id: String,
    pub unit: String,                       // "USD" (from the answer; "USD" when there is no line at all)
    pub range: Option<DateRange>,           // None = nothing to show yet (1st of the month for thisMonth)
    pub compare_range: Option<DateRange>,   // None for last6Months
    pub granularity: Granularity,           // "daily" | "monthly"
    pub total: String,
    pub compare_total: Option<String>,
    pub delta: Option<String>,
    pub delta_pct: Option<f64>,             // None when compare_total is zero or absent
    pub estimated: bool,                    // any bucket of the current range estimated
    pub forecast: Option<Forecast>,         // thisMonth only; mean is the whole-month estimate (spec C0 결과)
    pub forecast_note: Option<String>,      // why forecast is None, if it was attempted
    pub series: Vec<String>,                // top 5 services of the range, by amount desc, then name
    pub buckets: Vec<Bucket>,               // one per day (daily) or per month (monthly), in date order
    pub fetched_at: String,                 // ISO, the oldest answer used
    pub requests: u32,                      // Cost Explorer pages actually sent for this call (0 = all cached)
}
#[serde(rename_all = "camelCase")] pub enum Granularity { Daily, Monthly }
pub struct BreakdownRow { pub key: String, pub label: String, pub current: String, pub previous: Option<String>, pub delta: Option<String>, pub delta_pct: Option<f64>, pub share: f64 }
pub struct SmallRows { pub count: u32, pub current: String, pub previous: Option<String> }
pub struct CostBreakdown { pub unit: String, pub rows: Vec<BreakdownRow>, pub small: Option<SmallRows>, pub total: String, pub fetched_at: String, pub requests: u32 }
pub struct CostUsage { pub year_month: String, pub requests: u32 }
```
Commands (all `async`, `State<AppState>` + `State<CostState>`):
```rust
cost_overview(profile: String, query: CostQuery, refresh: bool) -> Result<CostOverview, AppError>   // ignores query.group_by
cost_breakdown(profile: String, query: CostQuery, refresh: bool) -> Result<CostBreakdown, AppError>
cost_tag_keys(profile: String, refresh: bool) -> Result<Vec<String>, AppError>                  // active cost allocation tags, sorted
cost_usage(profile: String) -> Result<CostUsage, AppError>                                      // this UTC month, no AWS call except account id
```

## Behavior rules (from the spec, made exact)
**Periods** (`today` = UTC date; `first(m)` = 1st of a month):

| period | current range | compare range | granularity |
|---|---|---|---|
| thisMonth | `[first(today), today)`; None if `today.day == 1` | `[first(prev), min(first(prev) + (today.day − 1) days, first(today)))` | daily |
| lastMonth | `[first(prev), first(today))` | `[first(prev2), first(prev))` | daily |
| last30Days | `[today − 30, today)` | `[today − 60, today − 30)` | daily |
| last6Months | `[first(today) − 5 months, today)`; on day 1 this ends at `first(today)` and has 5 months | None | monthly |

- Forecast is fetched only for thisMonth, over `[today, first(next))`, `MONTHLY`, `PredictionIntervalLevel = 80`, with the same filter.
  - When the forecast fails with `DataUnavailableException` or a `ValidationException` whose message mentions `historical data`: `forecast = None`, `forecast_note = "예상하기엔 데이터가 부족해요"`.
  - Any other forecast error: `forecast = None`, `forecast_note = error.to_string()`. The overview itself still succeeds.

**Requests** (each one is a `CeRequest`, cached and counted by `client.rs`):
- `cost_overview`
  - current: `GetCostAndUsage(range, DAILY|MONTHLY, [metric], filter, GroupBy DIMENSION SERVICE)`.
  - compare: `GetCostAndUsage(compare_range, MONTHLY, [metric], filter, GroupBy DIMENSION SERVICE)`. Its group sum is `compare_total`.
  - forecast (thisMonth only).
- `cost_breakdown` with `group_by = Service`: the **same two `CeRequest`s** as the overview. They are cache hits after the overview, so the first screen costs 3 requests.
- `cost_breakdown` with other `group_by`: current `GetCostAndUsage(range, MONTHLY, …, GroupBy <dim or TAG key>)` and compare (the same with `compare_range`). Per-key amounts are summed over all periods.
- `cost_tag_keys`: `ListCostAllocationTags(Status=Active)` (user-defined and AWS-generated alike), paged; returns sorted unique `TagKey`s.
  - It is cached under its own `CeRequest` variant.
  - It is a CE call, so it is counted ([INFERENCE] billed like other CE API calls).

**Filter expression:**
- Parts:
  - `exclude_credits` adds `Not(Dimensions RECORD_TYPE ∈ ["Credit", "Refund"])`.
  - Each `CostFilter::Dimension` adds `Dimensions <dim> = [value]`.
  - Each `CostFilter::Tag` adds `Tags key = [value]`, or `Tags key MatchOptions [ABSENT]` when `value` is empty.
- Combination: 0 parts → no filter; 1 part → that part; ≥2 → `And(parts)`. Cost Explorer rejects a one-element `And`.

**Aggregation:**
- With `GroupBy`, `Total` is empty (spec C0), so every total is the sum of groups.
- Group keys:
  - Dimension keys are taken as is.
  - Tag keys come back as `"<key>$<value>"`. `key` keeps the raw string. `label` is the value, or `"(태그 없음)"` when the value is empty.
- `series`: the top 5 keys by amount over the whole current range.
- `other` in each bucket: the bucket total minus the series values.
- `estimated`: any current bucket has `Estimated: true`.
- Breakdown rows:
  - Every key in current ∪ previous.
  - `previous`/`delta` are None when there is no compare range.
  - `delta_pct` is None when previous is zero.
  - `share` = current / total current × 100, and 0 when the total is 0.
  - Sort: current desc, then key.
  - A row with |current| < 0.005 **and** |previous or 0| < 0.005 goes into `small` (count and sums). `small` is None when no row qualifies.
- `unit`: the first `Unit` seen in the answer, else `"USD"`.
- Decimal output: `Decimal::normalize().to_string()` (e.g. `"0.53168163"`, `"0"`).

**Cache (`cost-cache.json`):**
```json
{ "version": 1,
  "entries": { "<accountId>|<CeRequest canonical JSON>": { "fetchedAt": 1793350000, "table": { …CeTable… } } },
  "requests": { "<accountId>|2026-10": 5 } }
```
- `CeRequest` is serialized with `serde_json::to_string`. Field order is fixed by the struct, and filters keep their given order, so the same query gives the same key.
- TTL is 6 hours (`CE_TTL_SECS = 21_600`). `refresh = true` skips the read but still writes the new answer.
- On every write, drop entries older than 7 days and `requests` keys older than the previous month. Writes go to a temp file and `rename`.
- A missing, unreadable or wrong-version file is treated as empty. It is not an error, and the next write replaces it.
- The counter counts each page sent, including pages of a failed paging run and pages that came back with an error response, so it matches what AWS bills. [INFERENCE] AWS may not bill rejected calls; the app over-counts rather than under-counts.

**Errors (`client.rs::from_ce`):**
- Look at the code and message first, then fall back to `crate::error::from_sdk`.
  - `LimitExceededException` → `AppError::Throttled`.
  - `DataUnavailableException` → `AppError::Other { message: "이 기간의 비용 데이터가 아직 없어요" }`.
  - Message contains `not enabled for cost explorer` (case-insensitive) → `AppError::Other { message: "Billing 콘솔에서 Cost Explorer를 처음 열면 켜져요(최대 24시간)" }`. [INFERENCE] The exact AWS wording for a never-enabled account was not observed in C0. Keep the match narrow and covered by one test with that wording.
  - Everything else goes through `from_sdk` (`AccessDeniedException` → `AccessDenied { action: "ce:GetCostAndUsage" }` etc.).

**Account id:** `CostState` memoizes `profile → account id` (from `state.ctx.account_id`) for the life of the app.

---

### Task C1.1: Dates, periods and contract types

**Files:** Create `src-tauri/src/cost/mod.rs`, `src-tauri/src/cost/period.rs`, `src-tauri/src/cost/model.rs`. Modify `src-tauri/src/lib.rs` (`mod cost;` only).

**Produces:**
```rust
// period.rs
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)] pub struct Ymd { pub y: i32, pub m: u32, pub d: u32 }
impl Ymd {
    pub fn from_unix(secs: i64) -> Ymd;              // UTC
    pub fn parse(s: &str) -> Option<Ymd>;            // "YYYY-MM-DD"
    pub fn to_string(&self) -> String;               // impl Display instead: "2026-10-30"
    pub fn add_days(self, n: i64) -> Ymd;
    pub fn first_of_month(self) -> Ymd;
    pub fn add_months(self, n: i32) -> Ymd;          // only used on first-of-month values; day stays 1
    pub fn year_month(self) -> String;               // "2026-10"
}
pub struct Ranges { pub current: Option<(Ymd, Ymd)>, pub compare: Option<(Ymd, Ymd)>, pub forecast: Option<(Ymd, Ymd)>, pub granularity: Granularity }
pub fn ranges(period: CostPeriod, today: Ymd) -> Ranges;
```
- [ ] **Step 1: tests first.**
  - `Ymd`:
    - round-trip with `from_unix` at 0, 1970-01-01, 2000-02-29 and 2026-12-31T23:59:59Z
    - `add_days` across month and year ends and leap days
    - `add_months(-5)` from 2026-03-01 → 2025-10-01
    - `parse` rejects `"2026-13-01"`, `"2026-02-30"`, `"26-1-1"`, `""`.
  - `ranges`, with exact expected dates for every row of the period table:
    - today = 2026-10-30, 2026-10-01 (thisMonth current None; last6Months ends 2026-10-01 with start 2026-05-01), 2026-03-31 (thisMonth compare capped at 2026-03-01 because February is shorter), 2026-01-15 (lastMonth crosses the year).
    - The forecast range is only present for thisMonth: 2026-10-30 → `[2026-10-30, 2026-11-01)`.
  - `model.rs`: one JSON shape test per enum (`CostPeriod::Last30Days` → `"last30Days"`, `CostMetric` → `"UnblendedCost"`, `CostGroupBy::Tag` → `{"kind":"tag","key":"team"}`, `CostDimension::UsageType` → `"USAGE_TYPE"`, both `CostFilter` forms round-trip). One `CostOverview` key-set test, like `iam/overview.rs`'s keys test.
- [ ] **Step 2: implement.** `Granularity` lives in `model.rs`; `period.rs` imports it.
- [ ] **Step 3:** `cargo test cost::` and clippy.
- [ ] **Step 4: commit** `feat(cost): civil dates, period ranges and the cost command contract`.

---

### Task C1.2: Requests, answers, the recording client and the Cost Explorer client

**Files:** Create `src-tauri/src/cost/expr.rs`, `src-tauri/src/cost/table.rs`, `src-tauri/src/cost/mock_aws.rs` (`#[cfg(test)]`), `src-tauri/src/cost/client.rs`. Modify `src-tauri/Cargo.toml` via `cargo add aws-sdk-costexplorer rust_decimal`.

**Produces:**
```rust
// expr.rs
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)] #[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum CeRequest {
    Usage { start: String, end: String, granularity: Granularity, metric: CostMetric, exclude_credits: bool, filters: Vec<CostFilter>, group: Option<CostGroupBy> },
    Forecast { start: String, end: String, metric: CostMetric, exclude_credits: bool, filters: Vec<CostFilter> },
    TagKeys,
}
pub fn filter_expression(exclude_credits: bool, filters: &[CostFilter]) -> Option<aws_sdk_costexplorer::types::Expression>;
pub fn group_definition(g: &CostGroupBy) -> aws_sdk_costexplorer::types::GroupDefinition;

// table.rs
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
pub struct CeTable { pub unit: Option<String>, pub periods: Vec<CePeriod>, pub forecast: Option<Forecast>, pub tag_keys: Vec<String> }
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
pub struct CePeriod { pub start: String, pub estimated: bool, pub groups: Vec<(String, String)> /* key, amount */, pub total: Option<String> }
pub fn dec(s: &str) -> Decimal;          // unparsable → 0 (Cost Explorer always sends numbers; keep it total-safe)
pub fn out(d: Decimal) -> String;        // normalize().to_string()

// client.rs
pub async fn fetch(client: &aws_sdk_costexplorer::Client, req: &CeRequest) -> (Result<CeTable, AppError>, u32 /* pages sent */);
pub fn from_ce<E, R>(err: SdkError<E, R>, action: &str) -> AppError;
```
- `fetch` pages `NextPageToken` for `Usage` and `NextToken` for `TagKeys`. It concatenates periods with the same `start` by appending their groups, keeps the first `unit`, and returns how many requests it actually sent even on error.
- `group` maps `Some(Service|Region|UsageType)` → `GroupBy DIMENSION SERVICE|REGION|USAGE_TYPE` and `Tag{key}` → `GroupBy TAG key`.
- `mock_aws.rs` mirrors `iam/mock_aws.rs` but for the AWS JSON 1.1 protocol:
  - `Sent { target: String /* x-amz-target, e.g. "AWSInsightsIndexService.GetCostAndUsage" */, body: serde_json::Value }`.
  - Responder → `(status, json string)`.
  - `error_json(code, message)` → `{"__type": code, "message": message}`.
  - `client()` builds `aws_sdk_costexplorer::Client` with test credentials, region `us-east-1` and retries disabled.
- [ ] **Step 1: tests first.**
  - `filter_expression`:
    - None for no parts.
    - A lone part is not wrapped in `And`.
    - Credits + SERVICE + empty-value tag gives `And[Not(RECORD_TYPE ∈ Credit,Refund), SERVICE = X, Tags team ABSENT]`. Assert on the JSON the mock client actually sent, not on SDK structs.
  - `CeRequest`: equal queries serialize to equal strings, and filter order matters (documented).
  - `fetch` against the mock:
    - two pages (first answer has `NextPageToken`, second sends it back) are merged and `pages == 2`
    - the sent body has `TimePeriod`, `Granularity`, `Metrics`, `GroupBy` and `Filter` as built
    - forecast sends `Metric: "UNBLENDED_COST"`/`"AMORTIZED_COST"` and `PredictionIntervalLevel: 80`, and parses `Total` plus the first `ForecastResultsByTime` bounds
    - `TagKeys` pages `NextToken` and returns sorted unique keys
    - an error answer still reports `pages == 1`.
  - Use the C0 answer shape for the fixtures: `Total: {}` with groups; amounts like `"0.53168163"`.
  - `from_ce`: `LimitExceededException` → Throttled; `DataUnavailableException` → the Korean message; `AccessDeniedException` with `"User not enabled for cost explorer access"` → the enable message; plain `AccessDeniedException` → `AccessDenied { action }`.
- [ ] **Step 2: implement.**
- [ ] **Step 3:** `cargo test cost::` and clippy.
- [ ] **Step 4: commit** `feat(cost): Cost Explorer requests, paging client and recording test client`.

---

### Task C1.3: Disk cache and request counter

**Files:** Create `src-tauri/src/cost/cache.rs`.

**Produces:**
```rust
pub const CE_TTL_SECS: i64 = 21_600;
pub const KEEP_SECS: i64 = 7 * 86_400;
pub struct CostCache { path: PathBuf, file: CacheFile /* serde struct of the JSON above */ }
impl CostCache {
    pub fn load(path: PathBuf) -> CostCache;                                        // never fails
    pub fn get(&self, account: &str, req: &CeRequest, now: i64) -> Option<(CeTable, i64 /* fetchedAt */)>;  // within TTL
    pub fn put(&mut self, account: &str, req: &CeRequest, table: &CeTable, now: i64);   // in memory
    pub fn count(&mut self, account: &str, year_month: &str, pages: u32);
    pub fn requests(&self, account: &str, year_month: &str) -> u32;
    pub fn save(&mut self, now: i64) -> io::Result<()>;                             // prune + temp file + rename
}
```
- [ ] **Step 1: tests first** (in a `tempfile::tempdir()`):
  - put/get round-trip, including after `save` + `load`
  - expiry exactly at `fetchedAt + CE_TTL_SECS` (expired) and one second before (fresh)
  - a different account or a different request is a miss
  - `save` prunes entries older than `KEEP_SECS` and counter months older than the previous month
  - a garbage file and a `"version": 2` file load as empty, and the next `save` overwrites them
  - the counter adds across calls and survives `save`/`load`
  - `save` creates the parent directory.
- [ ] **Step 2: implement.**
- [ ] **Step 3:** `cargo test cost::` and clippy.
- [ ] **Step 4: commit** `feat(cost): on-disk answer cache and Cost Explorer request counter`.

---

### Task C1.4: Overview and breakdown shaping

**Files:** Create `src-tauri/src/cost/overview.rs`, `src-tauri/src/cost/breakdown.rs`.

**Produces:**
```rust
// overview.rs
pub struct OverviewParts<'a> { pub current: Option<&'a CeTable>, pub compare: Option<&'a CeTable>, pub forecast: Result<Option<Forecast>, String> /* Err = note */ }
pub fn shape_overview(ranges: &Ranges, parts: OverviewParts) -> CostOverview;   // account_id, fetched_at, requests filled by the command
// breakdown.rs
pub fn shape_breakdown(group: &CostGroupBy, current: &CeTable, compare: Option<&CeTable>) -> CostBreakdown;  // fetched_at, requests filled by the command
```
- [ ] **Step 1: tests first.**
  - Use a fixture built from the C0 service names: `Amazon Relational Database Service`, `EC2 - Other`, `Tax`, `Claude Sonnet 5 (Amazon Bedrock Edition)`, … (≥ 7 services over 3 days).
  - `series` is the top 5 in order, with ties broken by name. `other` = total − series for each bucket. Bucket totals sum to `total`.
  - `estimated` is true when any day is estimated.
  - `delta`/`delta_pct` with a zero compare → `delta_pct` None.
  - `range` None → empty buckets, `total "0"`, no compare.
  - Forecast `Err(note)` → `forecast` None with the note.
  - Breakdown:
    - keys present only in previous show `current "0"`
    - `share` sums to ~100
    - small rows fold into `small` with count and sums, and `small` is None when nothing is small
    - tag keys `"team$"` and `"team$api"` get labels `"(태그 없음)"` and `"api"`
    - last6Months (no compare) has `previous`, `delta` and `delta_pct` None
    - sort order.
  - Decimal: `0.1 + 0.2` sums print `"0.3"`.
- [ ] **Step 2: implement.**
- [ ] **Step 3:** `cargo test cost::` and clippy.
- [ ] **Step 4: commit** `feat(cost): overview and breakdown shaping`.

---

### Task C1.5: Commands, state, hygiene and live test

**Files:**
- Create `src-tauri/src/cost_commands.rs` (with `#[cfg(test)] mod live_tests`), `src-tauri/src/cost/hygiene.rs`, `scripts/cost-live-test.sh`.
- Modify `src-tauri/src/lib.rs`:
  - `mod cost_commands;`
  - `app.manage(cost_commands::CostState::new(dir.join("cost-cache.json")))`
  - register the 4 commands after the IAM ones.

**Produces:**
```rust
pub struct CostState { cache: tokio::sync::Mutex<Option<CostCache>> /* loaded on first use */, path: PathBuf, accounts: std::sync::Mutex<HashMap<String, String>> }
impl CostState { pub fn new(path: PathBuf) -> CostState; }
/// The one path every command uses: cache hit (unless refresh) → else fetch, count pages, put, save.
async fn answer(ce: &aws_sdk_costexplorer::Client, cache: &mut CostCache, account: &str, req: &CeRequest, refresh: bool, now: i64) -> (Result<(CeTable, i64), AppError>, u32);
```
- `cost_overview`:
  1. Compute `ranges(query.period, Ymd::from_unix(now))` and the `CeRequest`s from the rules above.
  2. Answer current, then compare, then forecast. Forecast errors become the note, per the rules.
  3. `shape_overview`, then fill `account_id`, `fetched_at` = ISO of the oldest `fetchedAt` used (`crate::iam::clock::iso`) and `requests` = the sum of pages.
  4. When `range` is None, no CE call is made and `fetched_at` = now.
- `cost_breakdown`: the same, with `shape_breakdown`.
- `cost_tag_keys`: `CeRequest::TagKeys`.
- `cost_usage`: `CostUsage { year_month: today.year_month(), requests: cache.requests(account, …) }`.
- The cache mutex is held for one command's whole answer sequence. This serializes cost commands, so two tabs cannot pay twice for the same request.
- SSO: `state.ctx.config` errors propagate unchanged (`SsoExpired` reaches the frontend's existing flow).
- [ ] **Step 1: tests first.**
  - Unit tests in `cost_commands.rs` call `answer` and a small `overview_with(client, cache, account, query, refresh, now)` helper that the command wraps, with a mock client and a tempdir cache:
    - The first thisMonth overview sends exactly 3 requests (current, compare, forecast) and reports `requests == 3`.
    - A second identical overview sends 0 and reports `requests == 0` with the first `fetched_at`.
    - `refresh = true` sends again.
    - A service breakdown right after the overview sends 0. A region breakdown sends 2.
    - On the 1st of the month the overview sends only the forecast.
    - A forecast `DataUnavailableException` still returns an overview with the note.
    - A current-range `AccessDeniedException` fails the command with `AccessDenied { action: "ce:GetCostAndUsage" }`, and those pages are still counted in `cost_usage`.
  - `hygiene.rs`, mirroring `iam/write.rs`'s `mod hygiene`:
    - (a) No source file outside `src/cost/` mentions `aws_sdk_costexplorer`.
    - (b) No source file mentions any Cost Explorer mutating fluent call:
      - `create_anomaly_monitor`, `create_anomaly_subscription`, `create_cost_category_definition`
      - `delete_anomaly_monitor`, `delete_anomaly_subscription`, `delete_cost_category_definition`
      - `update_anomaly_monitor`, `update_anomaly_subscription`, `update_cost_allocation_tags_status`, `update_cost_category_definition`
      - `provide_anomaly_feedback`, `start_cost_allocation_tag_backfill`, `start_savings_plans_purchase_recommendation_generation`, `start_commitment_purchase_analysis`
      - `tag_resource`, `untag_resource`
      - The hygiene file itself is excluded.
    - (c) In `src/cost/client.rs` the only `.get_`/`.list_` fluent calls are `get_cost_and_usage`, `get_cost_forecast` and `list_cost_allocation_tags`.
- [ ] **Step 2: implement**, then register.
- [ ] **Step 3: live test.**
  - `cost_commands::live_tests` holds `#[ignore]` tests reading `MM_COST_PROFILE`. They run one thisMonth overview (≈ 3 requests) with a cache in a tempdir, check that `total` equals the sum of bucket totals and `unit == "USD"`, then run it again and a service breakdown, asserting `requests == 0` for both.
  - `scripts/cost-live-test.sh <profile>` prints "Cost Explorer 요청 약 3건(≈ $0.03)이 들어요" and runs `cargo test --lib cost_commands::live_tests -- --ignored --nocapture` with `MM_COST_PROFILE` set.
  - The hygiene SDK scope is `src/cost/` plus `src/cost_commands.rs`, which only builds the client and passes it on.
- [ ] **Step 4:** `cargo test`, `cargo clippy --all-targets -- -D warnings`, then `scripts/cost-live-test.sh personal` once. Record its output in the task report.
- [ ] **Step 5: commit** `feat(cost): cost overview, breakdown, tag key and usage commands`.

---

## After C1
- C2 (frontend tab) gets its own plan. It mirrors **Contract** above as `src/cost/types.ts`.
- README requirements, manual checklist and screenshots land with C2.
