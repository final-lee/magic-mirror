# EKS 쿠버네티스 K2(개요·워크로드) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The `☸️ <cluster>` tab gains four views: 개요 (cluster, nodes, node groups, add-ons, upgrade checks), 워크로드 (a kind tree with live lists, problem flags, filters, and an object detail with ownership navigation, containers, conditions, events, YAML, and per-key Secret values), 이벤트 (live, Warning filter), and the K1 내 권한. Nothing is written to the cluster.

**Architecture:**
- **Backend:** a new `src-tauri/src/k8s/read.rs` module tree (spec "구조" `read/`):
  - `read.rs`: `api_for` (dynamic `Api` for a kind), `bounded` (30 s limit + failure mapping), `list_all` (paged list with a page cap);
  - `read/values.rs`: per-kind row values and problem flags (pure); `rows.rs` uses it;
  - `read/kinds.rs`: API discovery (aggregated, falls back to per-group) → listable kinds;
  - `read/secret.rs`: Secret masking, key sizes, value decoding, `secret_value`;
  - `read/yaml.rs`: the view YAML (no `managedFields`, Secret masked, kubectl key order) via `serde-saphyr` (already in `Cargo.lock` through `kube-client`);
  - `read/detail.rs`: object detail (owners, children, containers, conditions, events, YAML);
  - `read/quantity.rs`, `read/nodes.rs`, `read/removed.rs`: overview pure parts;
  - `read/eks.rs`: overview EKS calls (DescribeCluster, node groups, Fargate, add-ons, Upgrade Insights);
  - `read/overview.rs`: overview assembly with per-section gaps.
  - `watch.rs` restarts the watcher with a fresh list after a non-fatal error (fixes K1 leftover M1).
  - `k8s_commands.rs` gains `k8s_kinds`, `k8s_get`, `k8s_secret_value`, `k8s_overview`.
- **Frontend:** `src/k8s/` gains a nav (`K8sNav`), `OverviewView`, `WorkloadsView` (= `KindTree` + `ObjectList` + `ObjectDetail` with a back stack), `SecretKeys`, `EventsView`, and pure helpers `kinds.ts`, `selector.ts`, `columns.ts`, `format.ts`. Lists and events use the K1 watch registry; detail, kinds, and overview use React Query keyed by target **and context**. Secret values never enter React Query.

**Tech Stack:** Tauri 2, Rust 1.96 (tokio, `kube` 4.2 + `kube-runtime`, `k8s-openapi` 0.28 with `v1_33`, `serde-saphyr` 0.0.29, `base64` 0.22, aws-sdk-eks), React 18 + TS, TanStack Query, Vitest; Docker + kind for the live tests.

## Decisions (confirm with the controller)
1. **No `k8s_list`, no `k8s_events`.** The K1 watch already lists with paging (`reset` is the full list) and keeps it live; a second list path would duplicate the paging, the time limits, and the Secret stripping. Lists, the events screen, and the "문제 있는 것만" filter use the watch. Name and label-selector filters run in the frontend over the watched rows (`selector.ts`). Related events inside an object detail come from `k8s_get`. The spec's contract lists both commands; leaving them out removes nothing that exists, and they can still be added later.
2. **`K8sRow` gains `problems`** (additive). Problem codes: `crashLoopBackOff`, `imagePullBackOff`, `pending`, `oomKilled`, `notReady`.
3. **`k8s_secret_value` returns `{ text, encoding }`** instead of a bare string, so binary values come back as base64 with `encoding: "base64"`.
4. **K1 leftover M1 (watch error banner can linger):** fixed in the backend. After a non-fatal watch error, `watch::run` flushes pending changes, waits (1 s doubling to 30 s), and starts a fresh watcher, which lists again. The new list's `reset` is the recovery signal the frontend already handles (it clears the error). No contract change; no `recovered` message. Side effect: a re-watch that hangs in the exec plugin is now a re-list, which the K1 stall timer already covers (closes the K1R note "stall can't catch an exec hang on re-watch").
5. **Overview errors are per section** (`gaps`), never a failed command, except "먼저 연결해 주세요" and the AWS config/SSO error that happens before any call. `k8s_overview` passes `profile: target.profile` at the top level (not the exec profile), because the only error it throws comes from the app's AWS profile; k8s-side SSO expiry shows inside a gap with the exec profile.
6. **Removed APIs** are found from `metadata.managedFields[].apiVersion` and the `last-applied-configuration` annotation of objects listed through a still-served version, not by listing the old version (listing an old version returns every object of that kind regardless of how it was written). The table (`read/removed.rs`) holds the removals from 1.25 to 1.32; PodSecurityPolicy (1.25) is left out because it has no replacement to list through and EKS 1.24 is out of support.
7. **CRDs** are told apart from built-in kinds by a fixed list of built-in API groups (`kinds::BUILTIN_GROUPS`), not by listing `CustomResourceDefinition`s (many identities may not list CRDs).
8. **Default view is 개요.** Existing `K8sTab` tests that assert on 내 권한 click the nav item first (Task K2-F8).
9. **In-app links in K2:** Pod → node detail, overview node → node detail, ServiceAccount IRSA role → IAM workspace (`openIam(arn)`). The spec's ServiceAccount → 접근 link waits for K4, where the access view is built.

## Global Constraints
- Spec: `docs/superpowers/specs/2026-10-30-eks-kubernetes-design.md` (sections "개요", "워크로드", "Secret 값", the K2 parts of "계약", "구조" `read/`, "테스트", and the K2 row of "단계"). Branch: `feat/eks-k8s` (K1 is on it). No release at the end of K2: the release happens after KR.
- **No writes (unchanged from K1):** Under `src-tauri/src/k8s/` and `src-tauri/src/k8s_commands.rs`, only `k8s/review.rs` may call `Api::create`, and only for `SelfSubjectReview` and `SelfSubjectRulesReview`. Nothing calls `patch`, `replace`, `delete`, `delete_collection`, `create_subresource`, `patch_subresource`, `replace_subresource`, `evict`, `exec`, `attach`, `portforward`, or `.method(`, and nothing builds a raw `POST`/`PUT`/`PATCH`/`DELETE` request. K2 reads use only `get`, `list`, `watch`, and discovery GETs. The `k8s/hygiene.rs` allow list does not change in K2. EKS calls in K2 are `Describe*`/`List*` only.
- **Test layout (K1 rule):** every file under `src-tauri/src/k8s/` and `k8s_commands.rs` ends with zero or more pairs of `#[cfg(test)]` (column 0) and `mod name;` (next line, column 0); only blank lines and `//` comments may follow. Tests live in `<module>/tests.rs` (for example `k8s/read/values.rs` → `k8s/read/values/tests.rs`); no inline `mod tests { … }`, no other `#[cfg(test)]` anywhere. `hygiene.rs`, `live_tests.rs`, and `tests.rs` files are test-only and not scanned; `k8s/hygiene.rs` enforces this. Modules use the `name.rs` + `name/` layout like K1 (no `mod.rs` under `read/`).
- **Secrets:**
  - Bearer tokens, client keys, and exec credential output never go into logs, errors, settings, or command results (K1).
  - Secret values leave the backend only through `k8s_secret_value`. `Row` values for a Secret carry only `type` and the key count; `k8s_get` masks `data` and `stringData` values and the `kubectl.kubernetes.io/last-applied-configuration` annotation of a Secret as `••••` before building anything from the object (annotations, YAML); `secretKeys` carries key names and byte sizes only. No error message contains a Secret value (missing key and bad base64 errors name the key at most). `SecretValue` has a hand-written `Debug` that prints no value.
  - The frontend keeps a revealed value only in the `SecretKeys` component's state: never in React Query, never in the watch registry, never in `localStorage`/settings. It drops all revealed values when the component unmounts, when the target/namespace/name changes, and ignores a response that arrives after such a change.
- **TLS, identity:** unchanged from K1 (`kube` with `rustls-tls` + `aws-lc-rs`, `default-features = false`; connect only through the kubeconfig context's own auth).
- **Every request has a time limit:** every kube request (get, list, discovery) goes through `read::bounded` (`REQUEST_TIMEOUT` = 30 s → `Failure::Unreachable` message on timeout); every EKS call goes through `eks::call` (30 s → `AppError::Network { message: eks_timeout(action) }`). Paged lists stop at a page cap.
- **Query keys** for anything read through a session include the kubeconfig context: `["k8s", targetKey, <kind>, context, ...]`. Everything per target stays under `k8sKeys.root(target)` so `closeK8s`/`refreshK8s` remove it. Reconnect uses `refreshK8s` (K1). Watches resubscribe through `useK8sWatch`'s `sessionEpoch` (K1). Watch errors surface through the channel (K1).
- **UI copy:** Korean 해요체. Code identifiers and commit messages are in English. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Exact strings.** Rust constants live where noted; TS constants live in `src/k8s/text.ts`; tests compare to these constants, not to retyped literals. All K1 strings stay as they are.
  - Rust `read/secret.rs`: mask `MASK` = "••••"; `key_missing(key)` = `이 Secret에 ${key} 키가 없어요`; `SECRET_UNREADABLE` = "Secret 값을 해석하지 못했어요".
  - Rust `read/yaml.rs`: `YAML_FAILED` = "YAML로 바꾸지 못했어요".
  - Rust `read/eks.rs`: `eks_timeout(action)` = `EKS API가 30초 안에 답하지 않았어요(${action})`.
  - TS nav: "개요", "워크로드", "이벤트" (K1 "내 권한" stays).
  - TS kind tree categories: "워크로드", "네트워크", "설정", "저장소", "클러스터", "사용자 정의 리소스"; tree label "리소스 종류".
  - TS list: filter placeholder "이름 또는 레이블 셀렉터(app=web,tier!=db)"; toggle "문제 있는 것만"; empty "항목이 없어요"; no match "조건에 맞는 항목이 없어요"; bad selector "레이블 셀렉터를 해석하지 못했어요"; loading "불러오는 중…".
  - TS common column headers: "이름", "네임스페이스", "이상", "나이".
  - TS per-kind column headers (key → label): ready "준비", status "상태", restarts "재시작", node "노드", ip "IP", upToDate "최신", available "사용 가능", desired "원하는 수", current "현재", completions "완료", schedule "일정", suspend "일시정지", active "실행 중", lastSchedule "마지막 실행", type "타입", clusterIp "클러스터 IP", externalIp "외부 주소", ports "포트", class "클래스", hosts "호스트", address "주소", podSelector "Pod 셀렉터", policyTypes "정책 종류", endpoints "엔드포인트", keys "키", roleArn "IAM 역할", volume "볼륨", capacity "용량", accessModes "접근 모드", storageClass "스토리지 클래스", reclaimPolicy "회수 정책", claim "클레임", provisioner "프로비저너", volumeBindingMode "바인딩 모드", default "기본", version "kubelet", instanceType "인스턴스 타입", zone "AZ", group "노드그룹".
  - TS problem labels: crashLoopBackOff "CrashLoopBackOff", imagePullBackOff "ImagePullBackOff", pending "Pending", oomKilled "OOMKilled", notReady "준비 안 됨".
  - TS detail: tabs "요약", "YAML"; sections "소유자", "소유한 리소스", "컨테이너", "상태 조건", "이벤트", "레이블", "어노테이션", "Secret 키"; buttons "← 뒤로", "닫기", `노드 ${name} 보기`, "IAM에서 열기"; created label "만든 시각"; children truncated "처음 500개만 보여줘요"; no events "최근 이벤트가 없어요"; container headers "이름", "이미지", "상태", "재시작", "마지막 종료"; init marker "init"; condition headers "종류", "상태", "이유", "메시지"; YAML note for Secrets "Secret 값은 ••••로 가렸어요"; detail aria label "상세".
  - TS Secret: headers "키", "크기", "값"; size `${n}바이트`; buttons "값 보기", "숨기기"; base64 note "텍스트가 아니라서 base64로 보여줘요"; no permission (button title) "이 네임스페이스의 secrets get 권한이 없어요".
  - TS events view: toggle "Warning만 보기"; headers "시각", "종류", "이유", "대상", "메시지", "횟수"; empty "이벤트가 없어요".
  - TS overview sections: "클러스터", "노드", "노드그룹", "Fargate 프로필", "Karpenter NodePool", "애드온", "업그레이드 점검"; refresh button "새로 고침".
  - TS overview cluster labels: "버전", "플랫폼 버전", "상태", "엔드포인트", "퍼블릭", "프라이빗", "허용 CIDR", "컨트롤 플레인 로깅", "Secret 암호화", "OIDC 공급자", "인증 모드"; values "켜짐", "꺼짐", "없음".
  - TS overview node headers: "이름", "상태", "인스턴스 타입", "AZ", "노드그룹", "kubelet", "CPU 요청", "메모리 요청", "CPU 사용", "메모리 사용"; group kinds managed "관리형", fargate "Fargate", karpenter "Karpenter", self "자체 관리"; cordon "스케줄 중지"; no metrics "metrics-server가 없어 사용량은 보여주지 않아요"; partial requests "Pod가 많아 요청량은 처음 10,000개 Pod로만 계산했어요".
  - TS overview node group headers: "이름", "상태", "버전", "인스턴스 타입", "용량 타입", "크기(최소/원하는/최대)".
  - TS overview add-on headers: "애드온", "현재 버전", "최신 버전", "상태", "문제"; up to date "최신이에요".
  - TS overview upgrade: subsections "Upgrade Insights", "제거되는 API", "버전 차이"; insight headers "점검", "상태", "이유"; no insights "Upgrade Insights 결과가 없어요"; removed title `${version}에서 제거되는 API를 쓰는 리소스`; removed headers "종류", "이름", "지금 API", "바꿀 API"; no removed `${version}에서 제거되는 API를 쓰는 리소스가 없어요`; skew `컨트롤 플레인보다 ${n} 마이너 버전 낮아요`; no skew "모든 노드가 컨트롤 플레인과 같은 버전이에요".
  - TS overview gap: `이 부분을 읽지 못했어요: ${section label}`; section labels cluster "클러스터", nodes "노드", metrics "사용량", nodegroups "노드그룹", fargate "Fargate 프로필", nodePools "Karpenter NodePool", addons "애드온", insights "Upgrade Insights", removedApis "제거되는 API".
- **Limits:** K1 limits stand (connect 10 s; exec plugin and every request 30 s; watch batches 100 ms or 500 rows; watch page 500; linger 30 s). K2 adds: watch restart wait 1 s doubling to 30 s, back to 1 s after a full list; detail children list one page of 500; detail events one page of 100; overview pod and node lists at most 20 pages of 500; removed-API scan one page of 500 per table entry; EKS list calls at most 20 pages.

## Contract (Tauri commands)
Rust types are `#[serde(rename_all = "camelCase")]`. TS mirrors live in `src/k8s/types.ts`. K1 types and commands are unchanged except the added `K8sRow.problems`.

```ts
type K8sProblem = "crashLoopBackOff" | "imagePullBackOff" | "pending" | "oomKilled" | "notReady";
interface K8sRow {
  uid: string; name: string; namespace: string | null; resourceVersion: string;
  createdAt: string | null; labels: Record<string, string>; values: Record<string, string>;
  problems: K8sProblem[];                 // K2: sorted, no duplicates
}
interface K8sKind extends K8sKindRef { verbs: string[]; custom: boolean }   // custom: group not in BUILTIN_GROUPS
interface K8sLink {                       // owner or child; plural is resolved by the frontend from kinds
  group: string; version: string; kind: string; name: string; namespace: string | null; uid: string;
  controller: boolean;                    // ownerReference.controller (children: false)
  problems: K8sProblem[];                 // children only (owners: [])
}
interface K8sTermination { reason: string | null; exitCode: number; finishedAt: string | null }
interface K8sContainer {
  name: string; image: string; init: boolean;
  state: "running" | "waiting" | "terminated" | "unknown" | "template";   // template: from a workload's pod template
  ready: boolean; restarts: number; reason: string | null; message: string | null;
  lastTermination: K8sTermination | null;
}
interface K8sCondition { type: string; status: string; reason: string | null; message: string | null; lastTransition: string | null }
interface K8sEvent { type: string; reason: string; message: string; count: number; lastSeen: string | null; source: string | null; object: string } // object: "Kind/name"
interface K8sSecretKey { key: string; size: number }   // size in bytes of the decoded value
interface K8sObjectView {
  kind: K8sKindRef; row: K8sRow; annotations: Record<string, string>;   // Secret: last-applied masked
  owners: K8sLink[]; children: K8sLink[]; childrenTruncated: boolean; childrenError: AppError | null;
  containers: K8sContainer[]; conditions: K8sCondition[];
  events: K8sEvent[]; eventsError: AppError | null;     // newest first, at most 100
  yaml: string;                                          // no managedFields; Secret values ••••
  secretKeys: K8sSecretKey[] | null;                     // Secrets only
}
interface K8sSecretValue { text: string; encoding: "utf8" | "base64" }

type K8sOverviewSection = "cluster" | "nodes" | "metrics" | "nodegroups" | "fargate" | "nodePools" | "addons" | "insights" | "removedApis";
interface K8sGap { section: K8sOverviewSection; error: AppError }
interface K8sClusterView {
  version: string; platformVersion: string | null; status: string | null;
  endpointPublic: boolean; endpointPrivate: boolean; publicCidrs: string[];
  logging: string[];                 // enabled control-plane log types
  secretsEncrypted: boolean; oidcIssuer: string | null; authenticationMode: string | null;
}
interface K8sResources { cpuMilli: number; memoryBytes: number; pods: number }
type K8sGroupKind = "managed" | "fargate" | "karpenter" | "self";
interface K8sNodeView {
  name: string; ready: boolean; unschedulable: boolean; pressures: string[];
  instanceType: string | null; zone: string | null; groupKind: K8sGroupKind; group: string | null;
  kubeletVersion: string; allocatable: K8sResources; requested: K8sResources;
  usage: { cpuMilli: number; memoryBytes: number } | null;
}
interface K8sNodegroupView { name: string; status: string | null; version: string | null; instanceTypes: string[]; capacityType: string | null; min: number | null; max: number | null; desired: number | null }
interface K8sAddonView { name: string; version: string | null; latest: string | null; status: string | null; issues: string[] }
interface K8sInsightView { name: string; category: string | null; status: string | null; reason: string | null; description: string | null; kubernetesVersion: string | null }
interface K8sRemovedUse { kind: string; apiVersion: string; replacement: string; removedIn: string; namespace: string | null; name: string }
interface K8sSkew { node: string; kubeletVersion: string; minorsBehind: number }
interface K8sOverview {
  cluster: K8sClusterView | null;
  nodes: K8sNodeView[] | null; requestsPartial: boolean; metrics: boolean;   // metrics: usage came from metrics-server
  nodegroups: K8sNodegroupView[] | null; fargateProfiles: string[] | null;
  nodePools: string[] | null;                 // null: no Karpenter NodePool kind (or a gap)
  addons: K8sAddonView[] | null; insights: K8sInsightView[] | null;
  removedApis: K8sRemovedUse[] | null; nextVersion: string | null;
  skew: K8sSkew[]; gaps: K8sGap[];
}

k8s_kinds(target): K8sKind[]                                                            // discovery; list+watch kinds only
k8s_get(target, kind: K8sKindRef, namespace: string | null, name: string): K8sObjectView
k8s_secret_value(target, namespace: string, name: string, key: string): K8sSecretValue
k8s_overview(target): K8sOverview
```
- `k8s_kinds`, `k8s_get`, `k8s_secret_value` pass a top-level `profile` equal to the exec profile (K1 rule). `k8s_overview` passes `profile: target.profile` (Decision 5).
- Fields are only ever added in later phases.

## File map
- Modify `src-tauri/Cargo.toml` (dev `tokio` `test-util`; `serde-saphyr = "0.0.29"`, `base64 = "0.22"`, both already in `Cargo.lock`), `src-tauri/src/lib.rs` (register commands), `src-tauri/src/k8s/mod.rs`, `src-tauri/src/k8s/rows.rs`, `src-tauri/src/k8s/watch.rs`, `src-tauri/src/k8s_commands.rs`, `src-tauri/src/k8s/live_tests.rs`, `scripts/k8s-live-test.sh`.
- Create `src-tauri/src/k8s/read.rs` and `src-tauri/src/k8s/read/{values,kinds,secret,yaml,detail,quantity,nodes,removed,eks,overview}.rs`, each with `<name>/tests.rs`, plus `src-tauri/src/k8s/read/tests.rs`.
- Modify `src/k8s/{types.ts,text.ts,api.ts,queries.ts,targets.ts,useK8sWatch.ts,K8sTab.tsx}`, `src/App.tsx`, `src/styles.css`, and the tests `src/k8s/{api.test.ts,queries.test.tsx,K8sTab.test.tsx}`.
- Create `src/k8s/{kinds.ts,selector.ts,columns.ts,format.ts,KindTree.tsx,ObjectList.tsx,SecretKeys.tsx,ObjectDetail.tsx,WorkloadsView.tsx,EventsView.tsx,OverviewView.tsx,K8sNav.tsx}` with tests next to them.

## Tracks
- Backend K2-B1 → K2-B10 run in order (they share `read.rs`, `rows.rs`, `k8s_commands.rs`, `lib.rs`). Each stages only `src-tauri/` and `scripts/` paths.
- Frontend K2-F1 → K2-F8 run in order, in parallel with the backend, against the Contract above (tests mock `k8sApi`). Each stages only `src/` paths.
- K2R reviews the whole phase after both tracks.

---

### Task K2-B1: Watch restarts with a fresh list after an error (K1 M1), `read::api_for`

The K1 watch reports a non-fatal error and lets `kube`'s watcher retry the watch without a new list. A quiet resource then sends nothing after it recovers, so the frontend's error banner stays. After this task, every non-fatal error ends with either a new `reset` (recovered) or another `error`.

**Files:**
- Modify: `src-tauri/Cargo.toml` (dev-dependency `tokio` gains `test-util`)
- Create: `src-tauri/src/k8s/read.rs`, `src-tauri/src/k8s/read/tests.rs`
- Modify: `src-tauri/src/k8s/mod.rs`, `src-tauri/src/k8s/watch.rs`, `src-tauri/src/k8s/watch/tests.rs`

**Interfaces:**
- Consumes (K1): `watch::{Batcher, Stall, WatchMessage, watch_failure, is_fatal, rows_of, FLUSH_EVERY, PAGE_SIZE}`, `rows::KindRef`, `failure::{describe, Endpoint, Failure}`.
- Produces:
  - `pub fn read::api_for(client: kube::Client, kind: &KindRef, namespace: Option<&str>) -> kube::Api<DynamicObject>`
  - `pub const watch::RETRY_FIRST: Duration` (1 s), `pub const watch::RETRY_MAX: Duration` (30 s)
  - `#[derive(Debug)] pub struct watch::Retry` with `Default`, `fn next_delay(&mut self) -> Duration`, `fn reset(&mut self)`
  - `pub type watch::Events = futures::stream::BoxStream<'static, Result<Event<DynamicObject>, watcher::Error>>`
  - `pub async fn watch::run_with<O, F>(open: O, kind: KindRef, endpoint: Endpoint, send: F)` where `O: FnMut() -> Events + Send`, `F: FnMut(WatchMessage) -> bool + Send`
  - `watch::run` keeps its K1 signature.
  - Removed: `Stall::on_error` (each restart gets a new `Stall`).

- [ ] **Step 1: Allow paused time in tests**

In `src-tauri/Cargo.toml`, `[dev-dependencies]`:

```toml
# 테스트의 가짜 PostgreSQL 서버가 로컬 TCP를 연다. test-util: watch 재시작 시험이 멈춘 시계(start_paused)로 기다림을 건너뛴다
tokio = { version = "1", features = ["net", "test-util"] }
```

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/k8s/read/tests.rs`:

```rust
use kube::{Client, Config};

use super::*;
use crate::k8s::tls::install_crypto_provider;

fn client() -> Client {
    install_crypto_provider();
    Client::try_from(Config::new("http://127.0.0.1:9".parse().unwrap())).unwrap()
}

fn kind(group: &str, version: &str, kind: &str, plural: &str, namespaced: bool) -> KindRef {
    KindRef { group: group.into(), version: version.into(), kind: kind.into(), plural: plural.into(), namespaced }
}

#[tokio::test]
async fn api_for_builds_namespaced_and_cluster_urls() {
    let pods = kind("", "v1", "Pod", "pods", true);
    assert_eq!(api_for(client(), &pods, Some("web")).resource_url(), "/api/v1/namespaces/web/pods");
    assert_eq!(api_for(client(), &pods, None).resource_url(), "/api/v1/pods");
    // 빈 이름은 모든 네임스페이스로 본다
    assert_eq!(api_for(client(), &pods, Some("")).resource_url(), "/api/v1/pods");
    let deploys = kind("apps", "v1", "Deployment", "deployments", true);
    assert_eq!(api_for(client(), &deploys, Some("web")).resource_url(), "/apis/apps/v1/namespaces/web/deployments");
    // 클러스터 범위 종류는 네임스페이스를 무시한다
    let nodes = kind("", "v1", "Node", "nodes", false);
    assert_eq!(api_for(client(), &nodes, Some("web")).resource_url(), "/api/v1/nodes");
}
```

Append to `src-tauri/src/k8s/watch/tests.rs` (and delete the two K1 tests that call `Stall::on_error`: `stall_stops_at_init_done_and_an_error_after_it_does_not_rearm` and `stall_rearms_on_an_error_while_listing`):

```rust
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use futures::StreamExt;

#[test]
fn retry_doubles_to_the_cap_and_resets() {
    let mut r = Retry::default();
    let got: Vec<u64> = (0..7).map(|_| r.next_delay().as_secs()).collect();
    assert_eq!(got, [1, 2, 4, 8, 16, 30, 30]);
    r.reset();
    assert_eq!(r.next_delay(), RETRY_FIRST);
}

type Item = Result<Event<DynamicObject>, watcher::Error>;

/// 부를 때마다 다음 스트림을 내준다. 각 스트림은 주어진 항목 뒤에 열린 채로 멈춘다(조용한 watch).
fn opener(streams: Vec<Vec<Item>>) -> (impl FnMut() -> Events + Send, Arc<Mutex<usize>>) {
    let queue = Arc::new(Mutex::new(streams.into_iter().collect::<VecDeque<_>>()));
    let opened = Arc::new(Mutex::new(0));
    let count = opened.clone();
    let open = move || {
        *count.lock().unwrap() += 1;
        let items = queue.lock().unwrap().pop_front().unwrap_or_default();
        futures::stream::iter(items).chain(futures::stream::pending()).boxed()
    };
    (open, opened)
}

fn obj(name: &str, uid: &str) -> DynamicObject {
    ns(name, uid, "Active")
}

async fn collect(open: impl FnMut() -> Events + Send + 'static, wait: std::time::Duration) -> Vec<WatchMessage> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let task = tokio::spawn(run_with(open, namespaces(), Endpoint { public: true, private: false }, move |m| tx.send(m).is_ok()));
    tokio::time::sleep(wait).await;
    task.abort();
    let mut out = Vec::new();
    while let Ok(m) = rx.try_recv() {
        out.push(m);
    }
    out
}

#[tokio::test(start_paused = true)]
async fn a_non_fatal_error_after_the_list_restarts_with_a_fresh_list() {
    let (open, opened) = opener(vec![
        vec![Ok(Event::Init), Ok(Event::InitApply(obj("a", "1"))), Ok(Event::InitDone), Err(watcher::Error::NoResourceVersion)],
        vec![Ok(Event::Init), Ok(Event::InitApply(obj("a", "1"))), Ok(Event::InitApply(obj("b", "2"))), Ok(Event::InitDone)],
    ]);
    let got = collect(open, secs(5)).await;
    assert_eq!(*opened.lock().unwrap(), 2);
    let kinds: Vec<&str> = got
        .iter()
        .map(|m| match m {
            WatchMessage::Reset { .. } => "reset",
            WatchMessage::Changes { .. } => "changes",
            WatchMessage::Error { fatal: false, .. } => "error",
            WatchMessage::Error { fatal: true, .. } => "fatal",
        })
        .collect();
    assert_eq!(kinds, ["reset", "error", "reset"]);
    let Some(WatchMessage::Reset { rows }) = got.last() else { panic!() };
    assert_eq!(rows.len(), 2);
}

#[tokio::test(start_paused = true)]
async fn pending_changes_are_sent_before_the_error() {
    let (open, _) = opener(vec![vec![Ok(Event::Init), Ok(Event::InitDone), Ok(Event::Apply(obj("a", "1"))), Err(watcher::Error::NoResourceVersion)]]);
    let got = collect(open, secs(1)).await;
    assert!(matches!(got[1], WatchMessage::Changes { ref upserts, .. } if upserts.len() == 1), "{got:?}");
    assert!(matches!(got[2], WatchMessage::Error { fatal: false, .. }));
}

#[tokio::test(start_paused = true)]
async fn a_fatal_error_stops_without_reopening() {
    let (open, opened) = opener(vec![vec![Err(watcher::Error::WatchError(status(403)))]]);
    let got = collect(open, secs(120)).await;
    assert_eq!(*opened.lock().unwrap(), 1);
    assert_eq!(got.len(), 1);
    assert!(matches!(got[0], WatchMessage::Error { fatal: true, .. }));
}

#[tokio::test(start_paused = true)]
async fn repeated_errors_back_off_and_a_full_list_resets_the_wait() {
    let err = || vec![Err(watcher::Error::NoResourceVersion)];
    // 1초, 2초, 4초 기다린 뒤 네 번째 스트림이 목록을 끝낸다. 그 뒤 오류는 다시 1초만 기다린다.
    let (open, opened) = opener(vec![err(), err(), err(), vec![Ok(Event::Init), Ok(Event::InitDone), Err(watcher::Error::NoResourceVersion)], vec![]]);
    // 받는 쪽을 끝까지 쥐고 있어야 보내기가 실패하지 않는다
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let task = tokio::spawn(run_with(open, namespaces(), Endpoint { public: true, private: false }, move |m| tx.send(m).is_ok()));
    tokio::time::sleep(std::time::Duration::from_millis(6_500)).await; // 0 + 1 + 2 + 4 = 7초 전
    assert_eq!(*opened.lock().unwrap(), 3);
    tokio::time::sleep(secs(1)).await; // 7초: 네 번째가 열리고 목록 → 오류
    assert_eq!(*opened.lock().unwrap(), 4);
    tokio::time::sleep(std::time::Duration::from_millis(1_100)).await; // 1초 뒤 다섯 번째
    assert_eq!(*opened.lock().unwrap(), 5);
    task.abort();
}
```

Note: the K1 `Stall` tests `stall_fires_once_after_the_limit_and_progress_resets_it` stays unchanged.

- [ ] **Step 3: Run the tests to make sure they fail**

Run: `cd src-tauri && cargo test --lib k8s::read k8s::watch`
Expected: compile errors (`read` module, `Retry`, `run_with`, `Events` not found).

- [ ] **Step 4: Implement**

Create `src-tauri/src/k8s/read.rs`:

```rust
//! 읽기 화면의 조회. 목록 값, 상세, 소유 관계, 이벤트, discovery, Secret 가리기, 개요. GET·LIST·WATCH만 쓴다(`hygiene`이 지킨다).
use kube::api::{Api, ApiResource, DynamicObject, GroupVersionKind};
use kube::Client;

use super::rows::KindRef;

/// 종류와 네임스페이스로 동적 API를 만든다. 빈 이름이나 클러스터 범위 종류는 모든 네임스페이스로 본다(빈 경로를 만들지 않는다).
pub fn api_for(client: Client, kind: &KindRef, namespace: Option<&str>) -> Api<DynamicObject> {
    let gvk = GroupVersionKind::gvk(&kind.group, &kind.version, &kind.kind);
    let ar = ApiResource::from_gvk_with_plural(&gvk, &kind.plural);
    match (namespace.filter(|n| !n.is_empty()), kind.namespaced) {
        (Some(ns), true) => Api::namespaced_with(client, ns, &ar),
        _ => Api::all_with(client, &ar),
    }
}

#[cfg(test)]
mod tests;
```

In `src-tauri/src/k8s/mod.rs`, add `pub mod read;` after `pub mod path;` and update the module comment's second sentence to "K1·K2는 클러스터에 아무것도 쓰지 않는다(`hygiene`이 지킨다)."

In `src-tauri/src/k8s/watch.rs`:
- Change the module comment to:

```rust
//! 목록 watch. 처음 목록(Init…InitDone)은 한 번에 `Reset`으로, 그 뒤 변경은 100ms 또는 500줄마다 `Changes`로 묶어 보낸다.
//! 일시적인 오류가 나면 알리고, 기다렸다가 새 watcher로 처음 목록부터 다시 받는다. 새 목록의 `Reset`이 회복 소식이다.
```

- Replace the `use` block's watcher-related lines and add the new items:

```rust
use std::time::Duration;

use futures::stream::BoxStream;
use kube::api::DynamicObject;
use kube::runtime::watcher::{self, Event};
use tokio::time::Instant;

use super::connect::REQUEST_TIMEOUT;
use super::failure::{describe, failure_of, Endpoint, Failure};
use super::read::api_for;
use super::rows::{row_of, KindRef, Row};
use crate::error::AppError;
```

(`FLUSH_EVERY` becomes `Duration::from_millis(100)` with the `Duration` import.)

- Delete `Stall::on_error` and update the `Stall` doc comment's last sentence to: "watch가 오류로 끝나면 새 watcher와 함께 새 `Stall`이 처음부터 잰다."
- Add after `Stall`:

```rust
pub const RETRY_FIRST: Duration = Duration::from_secs(1);
pub const RETRY_MAX: Duration = Duration::from_secs(30);

/// 일시적인 오류 뒤 새 목록을 받기 전에 기다리는 시간: 1초에서 두 배씩 30초까지. 목록을 끝까지 받으면 1초로 돌아간다.
#[derive(Debug)]
pub struct Retry {
    next: Duration,
}

impl Default for Retry {
    fn default() -> Self {
        Retry { next: RETRY_FIRST }
    }
}

impl Retry {
    pub fn next_delay(&mut self) -> Duration {
        let d = self.next;
        self.next = (self.next * 2).min(RETRY_MAX);
        d
    }

    pub fn reset(&mut self) {
        self.next = RETRY_FIRST;
    }
}

pub type Events = BoxStream<'static, Result<Event<DynamicObject>, watcher::Error>>;

enum Outcome {
    Stop,
    Retry,
}
```

- Replace `run` with:

```rust
/// 보내기가 실패하면(프론트가 채널을 버림) 끝난다. 403·401은 치명적이라 알리고 끝낸다. 다른 오류는 알리고, 기다렸다가 처음 목록부터 다시 받는다.
pub async fn run<F>(client: kube::Client, kind: KindRef, namespace: Option<String>, endpoint: Endpoint, send: F)
where
    F: FnMut(WatchMessage) -> bool + Send,
{
    use futures::StreamExt;

    let api = api_for(client, &kind, namespace.as_deref());
    let config = watcher::Config::default().page_size(PAGE_SIZE);
    run_with(move || watcher::watcher(api.clone(), config.clone()).boxed(), kind, endpoint, send).await;
}

/// `open`은 부를 때마다 새 watcher(처음 목록부터)를 만든다. 시험은 가짜 스트림을 넘긴다.
pub async fn run_with<O, F>(mut open: O, kind: KindRef, endpoint: Endpoint, mut send: F)
where
    O: FnMut() -> Events + Send,
    F: FnMut(WatchMessage) -> bool + Send,
{
    let mut retry = Retry::default();
    loop {
        match once(open(), &kind, endpoint, &mut send, &mut retry).await {
            Outcome::Stop => return,
            Outcome::Retry => tokio::time::sleep(retry.next_delay()).await,
        }
    }
}

/// watcher 하나를 오류나 끝까지 돌린다
async fn once<F>(mut stream: Events, kind: &KindRef, endpoint: Endpoint, send: &mut F, retry: &mut Retry) -> Outcome
where
    F: FnMut(WatchMessage) -> bool + Send,
{
    use futures::StreamExt;

    let mut batch = Batcher::default();
    let mut tick = tokio::time::interval(FLUSH_EVERY);
    let mut stall = Stall::default();
    stall.start(Instant::now());
    loop {
        tokio::select! {
            next = stream.next() => match next {
                None => return Outcome::Stop,
                Some(Ok(ev)) => {
                    stall.on_event(&ev, Instant::now());
                    if matches!(ev, Event::InitDone) {
                        retry.reset();
                    }
                    if let Some(msg) = batch.on(rows_of(kind, ev)) {
                        if !send(msg) {
                            return Outcome::Stop;
                        }
                    }
                    if batch.full() {
                        if let Some(msg) = batch.take() {
                            if !send(msg) {
                                return Outcome::Stop;
                            }
                        }
                    }
                }
                Some(Err(e)) => {
                    let failure = watch_failure(&e, kind);
                    let fatal = is_fatal(&failure);
                    // 오류 전에 받은 변경을 먼저 보낸다(새 목록이 덮지만 그사이 화면이 낡지 않게)
                    if let Some(msg) = batch.take() {
                        if !send(msg) {
                            return Outcome::Stop;
                        }
                    }
                    if !send(WatchMessage::Error { error: describe(&failure, endpoint), fatal }) || fatal {
                        return Outcome::Stop;
                    }
                    return Outcome::Retry;
                }
            },
            _ = tick.tick() => {
                if stall.expired(Instant::now()) && !send(WatchMessage::Error { error: describe(&Failure::Unreachable, endpoint), fatal: false }) {
                    return Outcome::Stop;
                }
                if let Some(msg) = batch.take() {
                    if !send(msg) {
                        return Outcome::Stop;
                    }
                }
            }
        }
    }
}
```

Remove the now-unused `.default_backoff()` and `WatchStreamExt` import (the restart replaces the watcher's own backoff). Keep `watch_failure`, `is_fatal`, `rows_of` unchanged. `run`'s `send` passes to `run_with` by value.

- [ ] **Step 5: Run the tests to make sure they pass**

Run: `cd src-tauri && cargo test --lib k8s && cargo clippy --all-targets -- -D warnings`
Expected: all pass (the K1 hygiene test still passes: `read.rs` calls no write API), clippy clean.

- [ ] **Step 6: Run the live watch tests (needs Docker + kind)**

Run: `KIND_IMAGES="kindest/node:v1.33.1" scripts/k8s-live-test.sh`
Expected: the 12 K1 live tests pass. `watch_reports_a_list_that_stalls` still sees the stall error then a `Reset`.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/k8s/mod.rs src-tauri/src/k8s/read.rs src-tauri/src/k8s/read/tests.rs src-tauri/src/k8s/watch.rs src-tauri/src/k8s/watch/tests.rs
git commit -m "fix(k8s): restart a watch with a fresh list after a non-fatal error so the frontend sees recovery

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task K2-B2: Row values and problem flags for workload kinds

**Files:**
- Create: `src-tauri/src/k8s/read/values.rs`, `src-tauri/src/k8s/read/values/tests.rs`
- Modify: `src-tauri/src/k8s/read.rs` (add `pub mod values;`), `src-tauri/src/k8s/rows.rs`, `src-tauri/src/k8s/rows/tests.rs`

**Interfaces:**
- Consumes: `rows::{KindRef, Row}`.
- Produces:
  - `#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)] #[serde(rename_all = "camelCase")] pub enum values::Problem { CrashLoopBackOff, ImagePullBackOff, Pending, OomKilled, NotReady }` (JSON: `crashLoopBackOff`, `imagePullBackOff`, `pending`, `oomKilled`, `notReady`)
  - `#[derive(Debug, Default, PartialEq)] pub struct values::Values { pub values: BTreeMap<String, String>, pub problems: Vec<Problem> }`
  - `pub fn values::values_of(kind: &KindRef, obj: &DynamicObject) -> Values` (problems sorted, no duplicates)
  - helpers for later tasks: `pub fn text<'a>(d: &'a Value, path: &str) -> Option<&'a str>`, `pub fn int(d: &Value, path: &str) -> Option<i64>`, `pub fn list<'a>(d: &'a Value, path: &str) -> &'a [Value]`, `pub fn condition<'a>(d: &'a Value, ty: &str) -> Option<&'a str>`
  - `Row` gains `pub problems: Vec<Problem>` (serialized after `values`); `pub(crate) fn rows::rfc3339_secs(t: &Timestamp) -> String` (was private).
  - Value keys per kind (the frontend's column keys, Task K2-F2):
    - Pod: `ready` ("r/n"), `status`, `restarts`, `node`, `ip`
    - Deployment: `ready` ("r/n"), `upToDate`, `available`; StatefulSet: `ready` ("r/n")
    - DaemonSet: `desired`, `current`, `ready`, `upToDate`, `available`; ReplicaSet: `desired`, `current`, `ready`
    - Job: `completions` ("s/n"), `status` (`Complete`/`Failed`/`Running`); CronJob: `schedule`, `suspend` (`true`/`false`), `active`, `lastSchedule`
    - Namespace: `status` (K1, moved here)

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/k8s/read/values/tests.rs`:

```rust
use serde_json::json;

use super::*;

fn kind(group: &str, kind: &str) -> KindRef {
    KindRef { group: group.into(), version: "v1".into(), kind: kind.into(), plural: format!("{}s", kind.to_lowercase()), namespaced: true }
}

fn obj(v: serde_json::Value) -> DynamicObject {
    let mut v = v;
    v["metadata"]["name"] = json!("x");
    v["metadata"]["uid"] = json!("u");
    serde_json::from_value(v).unwrap()
}

fn get<'a>(v: &'a Values, k: &str) -> Option<&'a str> {
    v.values.get(k).map(String::as_str)
}

fn pod(status: serde_json::Value) -> Values {
    let o = obj(json!({
        "apiVersion": "v1", "kind": "Pod", "metadata": {},
        "spec": { "nodeName": "ip-10-0-1-2", "containers": [{ "name": "app", "image": "a" }, { "name": "side", "image": "b" }] },
        "status": status
    }));
    values_of(&kind("", "Pod"), &o)
}

fn running(name: &str, ready: bool, restarts: i64) -> serde_json::Value {
    json!({ "name": name, "ready": ready, "restartCount": restarts, "state": { "running": {} } })
}

#[test]
fn running_ready_pod() {
    let v = pod(json!({ "phase": "Running", "podIP": "10.0.1.9", "containerStatuses": [running("app", true, 1), running("side", true, 2)] }));
    assert_eq!(get(&v, "ready"), Some("2/2"));
    assert_eq!(get(&v, "restarts"), Some("3"));
    assert_eq!(get(&v, "status"), Some("Running"));
    assert_eq!(get(&v, "node"), Some("ip-10-0-1-2"));
    assert_eq!(get(&v, "ip"), Some("10.0.1.9"));
    assert!(v.problems.is_empty());
}

#[test]
fn crash_looping_pod_is_flagged_and_not_ready() {
    let v = pod(json!({ "phase": "Running", "containerStatuses": [
        { "name": "app", "ready": false, "restartCount": 7, "state": { "waiting": { "reason": "CrashLoopBackOff" } }, "lastState": { "terminated": { "reason": "Error", "exitCode": 1 } } },
        running("side", true, 0)
    ] }));
    assert_eq!(get(&v, "status"), Some("CrashLoopBackOff"));
    assert_eq!(get(&v, "ready"), Some("1/2"));
    assert_eq!(v.problems, [Problem::CrashLoopBackOff, Problem::NotReady]);
}

#[test]
fn image_pull_failure_while_pending() {
    for reason in ["ImagePullBackOff", "ErrImagePull"] {
        let v = pod(json!({ "phase": "Pending", "containerStatuses": [{ "name": "app", "ready": false, "restartCount": 0, "state": { "waiting": { "reason": reason } } }] }));
        assert_eq!(get(&v, "status"), Some(reason));
        assert_eq!(v.problems, [Problem::ImagePullBackOff, Problem::Pending]);
    }
}

#[test]
fn oom_killed_in_the_last_state_is_flagged() {
    let v = pod(json!({ "phase": "Running", "containerStatuses": [
        { "name": "app", "ready": true, "restartCount": 1, "state": { "running": {} }, "lastState": { "terminated": { "reason": "OOMKilled", "exitCode": 137 } } },
        running("side", true, 0)
    ] }));
    assert_eq!(v.problems, [Problem::OomKilled]);
}

#[test]
fn init_container_reason_comes_first_with_a_prefix() {
    let v = pod(json!({ "phase": "Pending",
        "initContainerStatuses": [{ "name": "init", "ready": false, "restartCount": 3, "state": { "waiting": { "reason": "CrashLoopBackOff" } } }],
        "containerStatuses": [{ "name": "app", "ready": false, "restartCount": 0, "state": { "waiting": { "reason": "PodInitializing" } } }] }));
    assert_eq!(get(&v, "status"), Some("Init:CrashLoopBackOff"));
    assert_eq!(v.problems, [Problem::CrashLoopBackOff, Problem::Pending]);
}

#[test]
fn finished_init_containers_are_skipped() {
    let v = pod(json!({ "phase": "Running",
        "initContainerStatuses": [{ "name": "init", "ready": true, "restartCount": 0, "state": { "terminated": { "reason": "Completed", "exitCode": 0 } } }],
        "containerStatuses": [running("app", true, 0), running("side", true, 0)] }));
    assert_eq!(get(&v, "status"), Some("Running"));
}

#[test]
fn deleting_pod_is_terminating() {
    let mut o = obj(json!({ "apiVersion": "v1", "kind": "Pod", "metadata": { "deletionTimestamp": "2026-10-30T01:00:00Z" }, "spec": { "containers": [] }, "status": { "phase": "Running" } }));
    o.metadata.namespace = Some("web".into());
    assert_eq!(values_of(&kind("", "Pod"), &o).values.get("status").map(String::as_str), Some("Terminating"));
}

#[test]
fn evicted_pod_shows_the_status_reason() {
    let v = pod(json!({ "phase": "Failed", "reason": "Evicted" }));
    assert_eq!(get(&v, "status"), Some("Evicted"));
}

#[test]
fn deployment_ready_counts_and_not_ready() {
    let d = |spec: serde_json::Value, status: serde_json::Value| values_of(&kind("apps", "Deployment"), &obj(json!({ "apiVersion": "apps/v1", "kind": "Deployment", "metadata": {}, "spec": spec, "status": status })));
    let v = d(json!({ "replicas": 3 }), json!({ "readyReplicas": 2, "updatedReplicas": 3, "availableReplicas": 2 }));
    assert_eq!((get(&v, "ready"), get(&v, "upToDate"), get(&v, "available")), (Some("2/3"), Some("3"), Some("2")));
    assert_eq!(v.problems, [Problem::NotReady]);
    // replicas가 없으면 1, 0으로 줄인 것은 문제가 아니다
    assert_eq!(get(&d(json!({}), json!({ "readyReplicas": 1 })), "ready"), Some("1/1"));
    assert!(d(json!({ "replicas": 0 }), json!({})).problems.is_empty());
}

#[test]
fn statefulset_daemonset_replicaset() {
    let ss = values_of(&kind("apps", "StatefulSet"), &obj(json!({ "apiVersion": "apps/v1", "kind": "StatefulSet", "metadata": {}, "spec": { "replicas": 2 }, "status": { "readyReplicas": 2 } })));
    assert_eq!(get(&ss, "ready"), Some("2/2"));
    assert!(ss.problems.is_empty());
    let ds = values_of(&kind("apps", "DaemonSet"), &obj(json!({ "apiVersion": "apps/v1", "kind": "DaemonSet", "metadata": {}, "status": {
        "desiredNumberScheduled": 3, "currentNumberScheduled": 3, "numberReady": 2, "updatedNumberScheduled": 3, "numberAvailable": 2 } })));
    assert_eq!(
        ["desired", "current", "ready", "upToDate", "available"].map(|k| get(&ds, k)),
        [Some("3"), Some("3"), Some("2"), Some("3"), Some("2")]
    );
    assert_eq!(ds.problems, [Problem::NotReady]);
    let rs = values_of(&kind("apps", "ReplicaSet"), &obj(json!({ "apiVersion": "apps/v1", "kind": "ReplicaSet", "metadata": {}, "spec": { "replicas": 2 }, "status": { "replicas": 2, "readyReplicas": 2 } })));
    assert_eq!(["desired", "current", "ready"].map(|k| get(&rs, k)), [Some("2"), Some("2"), Some("2")]);
}

#[test]
fn job_status_from_conditions() {
    let job = |status: serde_json::Value| values_of(&kind("batch", "Job"), &obj(json!({ "apiVersion": "batch/v1", "kind": "Job", "metadata": {}, "spec": { "completions": 2 }, "status": status })));
    let done = job(json!({ "succeeded": 2, "conditions": [{ "type": "Complete", "status": "True" }] }));
    assert_eq!((get(&done, "completions"), get(&done, "status")), (Some("2/2"), Some("Complete")));
    assert_eq!(get(&job(json!({ "failed": 1, "conditions": [{ "type": "Failed", "status": "True" }] })), "status"), Some("Failed"));
    assert_eq!(get(&job(json!({ "active": 1 })), "status"), Some("Running"));
    assert_eq!(get(&job(json!({})), "completions"), Some("0/2"));
}

#[test]
fn cronjob_values() {
    let v = values_of(&kind("batch", "CronJob"), &obj(json!({ "apiVersion": "batch/v1", "kind": "CronJob", "metadata": {},
        "spec": { "schedule": "*/5 * * * *", "suspend": true }, "status": { "active": [{ "name": "a" }], "lastScheduleTime": "2026-10-30T01:00:00Z" } })));
    assert_eq!(
        ["schedule", "suspend", "active", "lastSchedule"].map(|k| get(&v, k)),
        [Some("*/5 * * * *"), Some("true"), Some("1"), Some("2026-10-30T01:00:00Z")]
    );
    let plain = values_of(&kind("batch", "CronJob"), &obj(json!({ "apiVersion": "batch/v1", "kind": "CronJob", "metadata": {}, "spec": { "schedule": "@daily" } })));
    assert_eq!((get(&plain, "suspend"), get(&plain, "active")), (Some("false"), Some("0")));
}

#[test]
fn namespace_status() {
    let v = values_of(&kind("", "Namespace"), &obj(json!({ "apiVersion": "v1", "kind": "Namespace", "metadata": {}, "status": { "phase": "Terminating" } })));
    assert_eq!(get(&v, "status"), Some("Terminating"));
}

#[test]
fn problems_serialize_in_camel_case() {
    let all = [Problem::CrashLoopBackOff, Problem::ImagePullBackOff, Problem::Pending, Problem::OomKilled, Problem::NotReady];
    assert_eq!(serde_json::to_value(all).unwrap(), json!(["crashLoopBackOff", "imagePullBackOff", "pending", "oomKilled", "notReady"]));
}
```

In `src-tauri/src/k8s/rows/tests.rs`, change the expected JSON in `row_json_keys_match_the_ts_contract` to end with `"values": { "status": "Active" }, "problems": []`, and add:

```rust
#[test]
fn row_carries_problems_from_values() {
    let pod: DynamicObject = serde_json::from_value(serde_json::json!({
        "apiVersion": "v1", "kind": "Pod", "metadata": { "name": "p", "uid": "u", "resourceVersion": "1" },
        "spec": { "containers": [{ "name": "a", "image": "x" }] }, "status": { "phase": "Pending" }
    }))
    .unwrap();
    let kind = KindRef { group: "".into(), version: "v1".into(), kind: "Pod".into(), plural: "pods".into(), namespaced: true };
    assert_eq!(row_of(&kind, &pod).problems, [crate::k8s::read::values::Problem::Pending]);
}
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `cd src-tauri && cargo test --lib k8s::read::values k8s::rows`
Expected: compile errors (`values` module, `Row::problems`).

- [ ] **Step 3: Implement**

In `src-tauri/src/k8s/read.rs`, add `pub mod values;` above the `api_for` function (after the `use` lines).

Create `src-tauri/src/k8s/read/values.rs`:

```rust
//! 종류별 목록 값(`Row::values`)과 이상 표시(`Row::problems`). 값의 키는 프론트 `src/k8s/columns.ts`의 열 키와 같다.
//! Secret은 타입과 키 개수만 읽는다. 값은 어떤 경로로도 줄에 들어가지 않는다.
use std::collections::BTreeMap;

use kube::api::DynamicObject;
use serde::Serialize;
use serde_json::Value;

use crate::k8s::rows::KindRef;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Problem {
    CrashLoopBackOff,
    ImagePullBackOff,
    Pending,
    OomKilled,
    NotReady,
}

#[derive(Debug, Default, PartialEq)]
pub struct Values {
    pub values: BTreeMap<String, String>,
    pub problems: Vec<Problem>,
}

impl Values {
    fn put(&mut self, key: &str, value: impl Into<String>) {
        self.values.insert(key.into(), value.into());
    }

    fn put_some(&mut self, key: &str, value: Option<&str>) {
        if let Some(v) = value.filter(|v| !v.is_empty()) {
            self.put(key, v);
        }
    }

    fn flag(&mut self, p: Problem) {
        if !self.problems.contains(&p) {
            self.problems.push(p);
        }
    }
}

pub fn text<'a>(d: &'a Value, path: &str) -> Option<&'a str> {
    d.pointer(path).and_then(Value::as_str)
}

pub fn int(d: &Value, path: &str) -> Option<i64> {
    d.pointer(path).and_then(Value::as_i64)
}

pub fn list<'a>(d: &'a Value, path: &str) -> &'a [Value] {
    d.pointer(path).and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// `status.conditions`에서 `type`이 같은 조건의 `status`("True", "False", "Unknown")
pub fn condition<'a>(d: &'a Value, ty: &str) -> Option<&'a str> {
    list(d, "/status/conditions").iter().find(|c| c["type"] == ty).and_then(|c| c["status"].as_str())
}

pub fn values_of(kind: &KindRef, obj: &DynamicObject) -> Values {
    let d = &obj.data;
    let mut v = Values::default();
    match (kind.group.as_str(), kind.kind.as_str()) {
        ("", "Pod") => pod(obj, &mut v),
        ("apps", "Deployment") => {
            let desired = int(d, "/spec/replicas").unwrap_or(1);
            ready_of(d, desired, "/status/readyReplicas", &mut v);
            v.put("upToDate", int(d, "/status/updatedReplicas").unwrap_or(0).to_string());
            v.put("available", int(d, "/status/availableReplicas").unwrap_or(0).to_string());
        }
        ("apps", "StatefulSet") => ready_of(d, int(d, "/spec/replicas").unwrap_or(1), "/status/readyReplicas", &mut v),
        ("apps", "ReplicaSet") => {
            let desired = int(d, "/spec/replicas").unwrap_or(1);
            let ready = int(d, "/status/readyReplicas").unwrap_or(0);
            v.put("desired", desired.to_string());
            v.put("current", int(d, "/status/replicas").unwrap_or(0).to_string());
            v.put("ready", ready.to_string());
            if ready < desired {
                v.flag(Problem::NotReady);
            }
        }
        ("apps", "DaemonSet") => {
            let desired = int(d, "/status/desiredNumberScheduled").unwrap_or(0);
            let ready = int(d, "/status/numberReady").unwrap_or(0);
            v.put("desired", desired.to_string());
            v.put("current", int(d, "/status/currentNumberScheduled").unwrap_or(0).to_string());
            v.put("ready", ready.to_string());
            v.put("upToDate", int(d, "/status/updatedNumberScheduled").unwrap_or(0).to_string());
            v.put("available", int(d, "/status/numberAvailable").unwrap_or(0).to_string());
            if ready < desired {
                v.flag(Problem::NotReady);
            }
        }
        ("batch", "Job") => {
            let wanted = int(d, "/spec/completions").unwrap_or(1);
            v.put("completions", format!("{}/{wanted}", int(d, "/status/succeeded").unwrap_or(0)));
            let status = if condition(d, "Complete") == Some("True") {
                "Complete"
            } else if condition(d, "Failed") == Some("True") {
                "Failed"
            } else {
                "Running"
            };
            v.put("status", status);
        }
        ("batch", "CronJob") => {
            v.put_some("schedule", text(d, "/spec/schedule"));
            v.put("suspend", (d.pointer("/spec/suspend") == Some(&Value::Bool(true))).to_string());
            v.put("active", list(d, "/status/active").len().to_string());
            v.put_some("lastSchedule", text(d, "/status/lastScheduleTime"));
        }
        ("", "Namespace") => v.put_some("status", text(d, "/status/phase")),
        _ => {}
    }
    v.problems.sort();
    v
}

/// `ready`를 "준비/원하는 수"로 넣고 모자라면 표시한다
fn ready_of(d: &Value, desired: i64, path: &str, v: &mut Values) {
    let ready = int(d, path).unwrap_or(0);
    v.put("ready", format!("{ready}/{desired}"));
    if ready < desired {
        v.flag(Problem::NotReady);
    }
}

fn pod(obj: &DynamicObject, v: &mut Values) {
    let d = &obj.data;
    let statuses = list(d, "/status/containerStatuses");
    let inits = list(d, "/status/initContainerStatuses");
    let total = list(d, "/spec/containers").len();
    let ready = statuses.iter().filter(|s| s["ready"].as_bool() == Some(true)).count();
    let restarts: i64 = statuses.iter().filter_map(|s| s["restartCount"].as_i64()).sum();
    let phase = text(d, "/status/phase").unwrap_or("");
    v.put("ready", format!("{ready}/{total}"));
    v.put("restarts", restarts.to_string());
    v.put_some("node", text(d, "/spec/nodeName"));
    v.put_some("ip", text(d, "/status/podIP"));
    v.put("status", pod_status(obj, statuses, inits, phase));
    for s in statuses.iter().chain(inits) {
        match s.pointer("/state/waiting/reason").and_then(Value::as_str) {
            Some("CrashLoopBackOff") => v.flag(Problem::CrashLoopBackOff),
            Some("ImagePullBackOff" | "ErrImagePull") => v.flag(Problem::ImagePullBackOff),
            _ => {}
        }
        let oom = |p: &str| s.pointer(p).and_then(Value::as_str) == Some("OOMKilled");
        if oom("/state/terminated/reason") || oom("/lastState/terminated/reason") {
            v.flag(Problem::OomKilled);
        }
    }
    if phase == "Pending" {
        v.flag(Problem::Pending);
    }
    if phase == "Running" && ready < total {
        v.flag(Problem::NotReady);
    }
}

/// kubectl get pods의 STATUS를 줄인 규칙: 지우는 중 → 끝나지 않은 init 컨테이너의 이유(`Init:` 접두) → 컨테이너가 기다리거나 끝난 이유 → status.reason → phase
fn pod_status(obj: &DynamicObject, statuses: &[Value], inits: &[Value], phase: &str) -> String {
    if obj.metadata.deletion_timestamp.is_some() {
        return "Terminating".into();
    }
    // 클로저로 쓰면 돌려주는 참조의 수명을 추론하지 못해 함수로 둔다
    fn reason_of(s: &Value) -> Option<&str> {
        s.pointer("/state/waiting/reason").or_else(|| s.pointer("/state/terminated/reason")).and_then(Value::as_str).filter(|r| !r.is_empty())
    }
    fn unfinished(s: &&Value) -> bool {
        s.pointer("/state/terminated/exitCode").and_then(Value::as_i64) != Some(0)
    }
    if let Some(r) = inits.iter().filter(unfinished).find_map(reason_of) {
        return format!("Init:{r}");
    }
    if let Some(r) = statuses.iter().find_map(reason_of) {
        return r.into();
    }
    text(&obj.data, "/status/reason").filter(|r| !r.is_empty()).unwrap_or(phase).to_string()
}

#[cfg(test)]
mod tests;
```

In `src-tauri/src/k8s/rows.rs`:
- Change the module comment's last sentence to "종류별 값과 이상 표시는 `read::values`가 만든다."
- Add `use crate::k8s::read::values::{values_of, Problem, Values};`
- Add the field `pub problems: Vec<Problem>,` after `values` in `Row`.
- Make the timestamp helper `pub(crate) fn rfc3339_secs`.
- In `row_of`, delete the Namespace-only `values` block and build values with `let Values { values, problems } = values_of(kind, obj);`, then set `values, problems` in the `Row` literal.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `cd src-tauri && cargo test --lib k8s && cargo clippy --all-targets -- -D warnings`
Expected: all pass, clippy clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/k8s/read.rs src-tauri/src/k8s/read/values.rs src-tauri/src/k8s/read/values/tests.rs src-tauri/src/k8s/rows.rs src-tauri/src/k8s/rows/tests.rs
git commit -m "feat(k8s): per-kind row values and problem flags for workloads

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task K2-B3: Row values for network, config, storage, nodes, events, and custom kinds

**Files:**
- Modify: `src-tauri/src/k8s/read/values.rs`, `src-tauri/src/k8s/read/values/tests.rs`

**Interfaces:**
- Consumes: Task K2-B2 (`Values`, `Problem`, helpers), `rows::rfc3339_secs`.
- Produces:
  - Value keys:
    - Service: `type`, `clusterIp`, `externalIp`, `ports` (`80/TCP`, `80:30080/TCP`, joined by `,`)
    - Ingress (`networking.k8s.io`): `class`, `hosts` (`,`), `address` (`,`)
    - NetworkPolicy (`networking.k8s.io`): `podSelector` (`k=v,…`, empty selector → no key), `policyTypes` (`,`)
    - Endpoints: `endpoints` (first 3 `ip:port` joined by `, `, then ` +N` for the rest)
    - ConfigMap: `keys` (count of `data` + `binaryData`); Secret: `type`, `keys` (count of `data` + `stringData`) — never a value
    - ServiceAccount: `roleArn` (annotation `eks.amazonaws.com/role-arn`)
    - PersistentVolumeClaim: `status`, `volume`, `capacity`, `accessModes`, `storageClass` (problem `Pending` when phase is Pending)
    - PersistentVolume: `capacity`, `accessModes`, `reclaimPolicy`, `status`, `claim` (`ns/name`), `storageClass`
    - StorageClass (`storage.k8s.io`): `provisioner`, `reclaimPolicy`, `volumeBindingMode`, `default` (`true` only when the default-class annotation is `"true"`)
    - Node: `status` (`Ready`/`NotReady`/`Unknown`, plus `,SchedulingDisabled`), `version`, `instanceType`, `zone`, `groupKind`, `group` (problem `NotReady` when Ready is not True)
    - Event: `type`, `reason`, `object` (`Kind/name`), `message`, `count`, `lastSeen` (RFC 3339, seconds)
    - any other kind (CRDs included): `ready` = the `Ready` condition status when present (problem `NotReady` when `False`)
  - `pub const IRSA_ANNOTATION: &str = "eks.amazonaws.com/role-arn"`, `pub const INSTANCE_TYPE_LABEL: &str = "node.kubernetes.io/instance-type"`, `pub const ZONE_LABEL: &str = "topology.kubernetes.io/zone"`
  - `#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)] #[serde(rename_all = "camelCase")] pub enum GroupKind { Managed, Fargate, Karpenter, #[serde(rename = "self")] SelfManaged }` with `pub fn as_str(self) -> &'static str`
  - `pub fn node_group(labels: &BTreeMap<String, String>) -> (GroupKind, Option<String>)`
  - `pub fn labels_of(obj: &DynamicObject) -> BTreeMap<String, String>`
  - `pub fn event_count(d: &Value) -> i64`, `pub fn event_last_seen(obj: &DynamicObject) -> Option<String>`, `pub fn event_object(d: &Value) -> String`

- [ ] **Step 1: Write the failing tests**

Append to `src-tauri/src/k8s/read/values/tests.rs`:

```rust
fn of(group: &str, k: &str, body: serde_json::Value) -> Values {
    let mut body = body;
    body["kind"] = json!(k);
    body["apiVersion"] = json!(if group.is_empty() { "v1".to_string() } else { format!("{group}/v1") });
    if body.get("metadata").is_none() {
        body["metadata"] = json!({});
    }
    values_of(&kind(group, k), &obj(body))
}

#[test]
fn service_values() {
    let v = of("", "Service", json!({
        "spec": { "type": "LoadBalancer", "clusterIP": "172.20.0.10", "ports": [{ "port": 80, "protocol": "TCP", "nodePort": 30080 }, { "port": 443, "protocol": "TCP" }] },
        "status": { "loadBalancer": { "ingress": [{ "hostname": "k8s-web.elb.amazonaws.com" }] } }
    }));
    assert_eq!(
        ["type", "clusterIp", "externalIp", "ports"].map(|k| get(&v, k)),
        [Some("LoadBalancer"), Some("172.20.0.10"), Some("k8s-web.elb.amazonaws.com"), Some("80:30080/TCP,443/TCP")]
    );
}

#[test]
fn ingress_and_network_policy_values() {
    let ing = of("networking.k8s.io", "Ingress", json!({
        "spec": { "ingressClassName": "alb", "rules": [{ "host": "a.example.com" }, { "host": "b.example.com" }] },
        "status": { "loadBalancer": { "ingress": [{ "hostname": "alb.example" }] } }
    }));
    assert_eq!(["class", "hosts", "address"].map(|k| get(&ing, k)), [Some("alb"), Some("a.example.com,b.example.com"), Some("alb.example")]);
    let np = of("networking.k8s.io", "NetworkPolicy", json!({ "spec": { "podSelector": { "matchLabels": { "app": "web" } }, "policyTypes": ["Ingress", "Egress"] } }));
    assert_eq!((get(&np, "podSelector"), get(&np, "policyTypes")), (Some("app=web"), Some("Ingress,Egress")));
    let all = of("networking.k8s.io", "NetworkPolicy", json!({ "spec": { "podSelector": {} } }));
    assert_eq!(get(&all, "podSelector"), None);
}

#[test]
fn endpoints_show_three_then_a_count() {
    let addresses: Vec<_> = (1..=5).map(|i| json!({ "ip": format!("10.0.0.{i}") })).collect();
    let v = of("", "Endpoints", json!({ "subsets": [{ "addresses": addresses, "ports": [{ "port": 80 }] }] }));
    assert_eq!(get(&v, "endpoints"), Some("10.0.0.1:80, 10.0.0.2:80, 10.0.0.3:80 +2"));
}

#[test]
fn config_map_counts_keys() {
    let v = of("", "ConfigMap", json!({ "data": { "a": "1", "b": "2" }, "binaryData": { "c": "AA==" } }));
    assert_eq!(get(&v, "keys"), Some("3"));
}

#[test]
fn secret_row_has_type_and_key_count_and_no_value() {
    let o = obj(json!({ "apiVersion": "v1", "kind": "Secret", "metadata": {}, "type": "Opaque",
        "data": { "password": "aHVudGVyMg==" }, "stringData": { "token": "plain-secret" } }));
    let k = kind("", "Secret");
    let v = values_of(&k, &o);
    assert_eq!((get(&v, "type"), get(&v, "keys")), (Some("Opaque"), Some("2")));
    let row = serde_json::to_string(&crate::k8s::rows::row_of(&k, &o)).unwrap();
    for secret in ["aHVudGVyMg==", "hunter2", "plain-secret"] {
        assert!(!row.contains(secret), "row leaks {secret}: {row}");
    }
}

#[test]
fn service_account_role_arn() {
    let v = of("", "ServiceAccount", json!({ "metadata": { "annotations": { "eks.amazonaws.com/role-arn": "arn:aws:iam::1:role/web" } } }));
    assert_eq!(get(&v, "roleArn"), Some("arn:aws:iam::1:role/web"));
}

#[test]
fn storage_kinds() {
    let pvc = of("", "PersistentVolumeClaim", json!({
        "spec": { "volumeName": "pv-1", "accessModes": ["ReadWriteOnce"], "storageClassName": "gp3" },
        "status": { "phase": "Pending", "capacity": { "storage": "10Gi" } }
    }));
    assert_eq!(
        ["status", "volume", "capacity", "accessModes", "storageClass"].map(|k| get(&pvc, k)),
        [Some("Pending"), Some("pv-1"), Some("10Gi"), Some("ReadWriteOnce"), Some("gp3")]
    );
    assert_eq!(pvc.problems, [Problem::Pending]);
    let pv = of("", "PersistentVolume", json!({
        "spec": { "capacity": { "storage": "10Gi" }, "accessModes": ["ReadWriteOnce"], "persistentVolumeReclaimPolicy": "Delete",
            "claimRef": { "namespace": "web", "name": "data" }, "storageClassName": "gp3" },
        "status": { "phase": "Bound" }
    }));
    assert_eq!(
        ["capacity", "accessModes", "reclaimPolicy", "status", "claim", "storageClass"].map(|k| get(&pv, k)),
        [Some("10Gi"), Some("ReadWriteOnce"), Some("Delete"), Some("Bound"), Some("web/data"), Some("gp3")]
    );
    let sc = of("storage.k8s.io", "StorageClass", json!({
        "metadata": { "annotations": { "storageclass.kubernetes.io/is-default-class": "true" } },
        "provisioner": "ebs.csi.aws.com", "reclaimPolicy": "Delete", "volumeBindingMode": "WaitForFirstConsumer"
    }));
    assert_eq!(
        ["provisioner", "reclaimPolicy", "volumeBindingMode", "default"].map(|k| get(&sc, k)),
        [Some("ebs.csi.aws.com"), Some("Delete"), Some("WaitForFirstConsumer"), Some("true")]
    );
    let plain = of("storage.k8s.io", "StorageClass", json!({ "provisioner": "x" }));
    assert_eq!(get(&plain, "default"), None);
}

fn node(labels: serde_json::Value, unschedulable: bool, ready: &str) -> Values {
    of("", "Node", json!({
        "metadata": { "labels": labels },
        "spec": { "unschedulable": unschedulable },
        "status": { "conditions": [{ "type": "Ready", "status": ready }], "nodeInfo": { "kubeletVersion": "v1.33.4-eks-1" } }
    }))
}

#[test]
fn node_values_and_groups() {
    let v = node(json!({ "node.kubernetes.io/instance-type": "m6i.large", "topology.kubernetes.io/zone": "ap-northeast-2a", "eks.amazonaws.com/nodegroup": "ng-1" }), false, "True");
    assert_eq!(
        ["status", "version", "instanceType", "zone", "groupKind", "group"].map(|k| get(&v, k)),
        [Some("Ready"), Some("v1.33.4-eks-1"), Some("m6i.large"), Some("ap-northeast-2a"), Some("managed"), Some("ng-1")]
    );
    assert!(v.problems.is_empty());
    let cordoned = node(json!({}), true, "False");
    assert_eq!((get(&cordoned, "status"), get(&cordoned, "groupKind"), get(&cordoned, "group")), (Some("NotReady,SchedulingDisabled"), Some("self"), None));
    assert_eq!(cordoned.problems, [Problem::NotReady]);
    assert_eq!(get(&node(json!({}), false, "Unknown"), "status"), Some("Unknown"));
}

#[test]
fn node_group_kinds() {
    let l = |pairs: &[(&str, &str)]| pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<BTreeMap<_, _>>();
    assert_eq!(node_group(&l(&[("eks.amazonaws.com/compute-type", "fargate"), ("eks.amazonaws.com/fargate-profile", "fp")])), (GroupKind::Fargate, Some("fp".into())));
    assert_eq!(node_group(&l(&[("eks.amazonaws.com/nodegroup", "ng")])), (GroupKind::Managed, Some("ng".into())));
    assert_eq!(node_group(&l(&[("karpenter.sh/nodepool", "default")])), (GroupKind::Karpenter, Some("default".into())));
    assert_eq!(node_group(&l(&[])), (GroupKind::SelfManaged, None));
    assert_eq!(serde_json::to_value(GroupKind::SelfManaged).unwrap(), json!("self"));
    assert_eq!(GroupKind::SelfManaged.as_str(), "self");
}

#[test]
fn event_values_prefer_the_series_time() {
    let v = of("", "Event", json!({
        "metadata": { "creationTimestamp": "2026-10-30T00:00:00Z" },
        "type": "Warning", "reason": "BackOff", "message": "Back-off restarting failed container",
        "involvedObject": { "kind": "Pod", "name": "web-1" }, "count": 4,
        "lastTimestamp": "2026-10-30T01:00:00Z", "series": { "count": 9, "lastObservedTime": "2026-10-30T02:00:00.123456Z" }
    }));
    assert_eq!(
        ["type", "reason", "object", "message", "count", "lastSeen"].map(|k| get(&v, k)),
        [Some("Warning"), Some("BackOff"), Some("Pod/web-1"), Some("Back-off restarting failed container"), Some("9"), Some("2026-10-30T02:00:00Z")]
    );
    let old = of("", "Event", json!({ "metadata": { "creationTimestamp": "2026-10-30T00:00:00Z" }, "involvedObject": { "kind": "Node", "name": "n" } }));
    assert_eq!((get(&old, "count"), get(&old, "lastSeen")), (Some("1"), Some("2026-10-30T00:00:00Z")));
}

#[test]
fn custom_kinds_use_the_ready_condition() {
    let v = of("mm.example.com", "Widget", json!({ "status": { "conditions": [{ "type": "Ready", "status": "False" }] } }));
    assert_eq!(get(&v, "ready"), Some("False"));
    assert_eq!(v.problems, [Problem::NotReady]);
    assert!(of("mm.example.com", "Widget", json!({})).values.is_empty());
}
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `cd src-tauri && cargo test --lib k8s::read::values`
Expected: FAIL (new kinds return empty values; `node_group`, `GroupKind` not found).

- [ ] **Step 3: Implement**

In `src-tauri/src/k8s/read/values.rs`, add `use k8s_openapi::jiff::Timestamp;` and `use crate::k8s::rows::rfc3339_secs;`, then:

```rust
pub const IRSA_ANNOTATION: &str = "eks.amazonaws.com/role-arn";
pub const INSTANCE_TYPE_LABEL: &str = "node.kubernetes.io/instance-type";
pub const ZONE_LABEL: &str = "topology.kubernetes.io/zone";
const DEFAULT_CLASS_ANNOTATION: &str = "storageclass.kubernetes.io/is-default-class";
const ENDPOINTS_SHOWN: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GroupKind {
    Managed,
    Fargate,
    Karpenter,
    #[serde(rename = "self")]
    SelfManaged,
}

impl GroupKind {
    pub fn as_str(self) -> &'static str {
        match self {
            GroupKind::Managed => "managed",
            GroupKind::Fargate => "fargate",
            GroupKind::Karpenter => "karpenter",
            GroupKind::SelfManaged => "self",
        }
    }
}

/// 노드가 속한 묶음. Fargate → 관리형 노드그룹 → Karpenter(EKS Auto Mode 포함) → 자체 관리 순서로 레이블을 본다.
pub fn node_group(labels: &BTreeMap<String, String>) -> (GroupKind, Option<String>) {
    if labels.get("eks.amazonaws.com/compute-type").map(String::as_str) == Some("fargate") {
        return (GroupKind::Fargate, labels.get("eks.amazonaws.com/fargate-profile").cloned());
    }
    if let Some(n) = labels.get("eks.amazonaws.com/nodegroup") {
        return (GroupKind::Managed, Some(n.clone()));
    }
    if let Some(n) = labels.get("karpenter.sh/nodepool") {
        return (GroupKind::Karpenter, Some(n.clone()));
    }
    (GroupKind::SelfManaged, None)
}

pub fn labels_of(obj: &DynamicObject) -> BTreeMap<String, String> {
    obj.metadata.labels.clone().unwrap_or_default().into_iter().collect()
}

fn annotation<'a>(obj: &'a DynamicObject, key: &str) -> Option<&'a str> {
    obj.metadata.annotations.as_ref()?.get(key).map(String::as_str)
}

fn joined(items: impl Iterator<Item = String>) -> Option<String> {
    let all: Vec<String> = items.filter(|s| !s.is_empty()).collect();
    (!all.is_empty()).then(|| all.join(","))
}

fn strings(d: &Value, path: &str) -> Option<String> {
    joined(list(d, path).iter().filter_map(|v| v.as_str().map(str::to_string)))
}

fn object_keys(d: &Value, path: &str) -> usize {
    d.pointer(path).and_then(Value::as_object).map_or(0, |m| m.len())
}

/// 로드밸런서 주소(호스트 이름 또는 IP)
fn lb_addresses(d: &Value) -> Option<String> {
    joined(list(d, "/status/loadBalancer/ingress").iter().filter_map(|i| i["hostname"].as_str().or(i["ip"].as_str()).map(str::to_string)))
}

pub fn event_count(d: &Value) -> i64 {
    int(d, "/series/count").or_else(|| int(d, "/count")).unwrap_or(1)
}

/// 마지막으로 본 시각: series.lastObservedTime → lastTimestamp → eventTime → 만든 시각, 초 단위 RFC 3339
pub fn event_last_seen(obj: &DynamicObject) -> Option<String> {
    let d = &obj.data;
    ["/series/lastObservedTime", "/lastTimestamp", "/eventTime"]
        .iter()
        .find_map(|p| text(d, p).and_then(|s| s.parse::<Timestamp>().ok()))
        .map(|t| rfc3339_secs(&t))
        .or_else(|| obj.metadata.creation_timestamp.as_ref().map(|t| rfc3339_secs(&t.0)))
}

pub fn event_object(d: &Value) -> String {
    format!("{}/{}", text(d, "/involvedObject/kind").unwrap_or(""), text(d, "/involvedObject/name").unwrap_or(""))
}
```

Extend the `match` in `values_of` (before `("", "Namespace")`) and replace the final `_ => {}`:

```rust
        ("", "Service") => {
            v.put_some("type", text(d, "/spec/type"));
            v.put_some("clusterIp", text(d, "/spec/clusterIP"));
            let external = lb_addresses(d).or_else(|| strings(d, "/spec/externalIPs"));
            v.put_some("externalIp", external.as_deref());
            let ports = joined(list(d, "/spec/ports").iter().map(|p| {
                let proto = p["protocol"].as_str().unwrap_or("TCP");
                match p["nodePort"].as_i64() {
                    Some(n) => format!("{}:{n}/{proto}", p["port"]),
                    None => format!("{}/{proto}", p["port"]),
                }
            }));
            v.put_some("ports", ports.as_deref());
        }
        ("networking.k8s.io", "Ingress") => {
            v.put_some("class", text(d, "/spec/ingressClassName"));
            let hosts = joined(list(d, "/spec/rules").iter().filter_map(|r| r["host"].as_str().map(str::to_string)));
            v.put_some("hosts", hosts.as_deref());
            v.put_some("address", lb_addresses(d).as_deref());
        }
        ("networking.k8s.io", "NetworkPolicy") => {
            let selector = d.pointer("/spec/podSelector/matchLabels").and_then(Value::as_object).and_then(|m| joined(m.iter().map(|(k, v)| format!("{k}={}", v.as_str().unwrap_or("")))));
            v.put_some("podSelector", selector.as_deref());
            v.put_some("policyTypes", strings(d, "/spec/policyTypes").as_deref());
        }
        ("", "Endpoints") => {
            let all: Vec<String> = list(d, "/subsets")
                .iter()
                .flat_map(|s| {
                    let ports: Vec<i64> = s["ports"].as_array().map_or(vec![], |p| p.iter().filter_map(|p| p["port"].as_i64()).collect());
                    let ips: Vec<String> = s["addresses"].as_array().map_or(vec![], |a| a.iter().filter_map(|a| a["ip"].as_str().map(str::to_string)).collect());
                    ips.into_iter().flat_map(move |ip| ports.clone().into_iter().map(move |p| format!("{ip}:{p}")))
                })
                .collect();
            if !all.is_empty() {
                let mut shown = all.iter().take(ENDPOINTS_SHOWN).cloned().collect::<Vec<_>>().join(", ");
                if all.len() > ENDPOINTS_SHOWN {
                    shown.push_str(&format!(" +{}", all.len() - ENDPOINTS_SHOWN));
                }
                v.put("endpoints", shown);
            }
        }
        ("", "ConfigMap") => v.put("keys", (object_keys(d, "/data") + object_keys(d, "/binaryData")).to_string()),
        // 값은 읽지 않는다: 타입과 키 개수만
        ("", "Secret") => {
            v.put_some("type", text(d, "/type"));
            v.put("keys", (object_keys(d, "/data") + object_keys(d, "/stringData")).to_string());
        }
        ("", "ServiceAccount") => v.put_some("roleArn", annotation(obj, IRSA_ANNOTATION)),
        ("", "PersistentVolumeClaim") => {
            let phase = text(d, "/status/phase");
            v.put_some("status", phase);
            v.put_some("volume", text(d, "/spec/volumeName"));
            v.put_some("capacity", text(d, "/status/capacity/storage"));
            v.put_some("accessModes", strings(d, "/spec/accessModes").as_deref());
            v.put_some("storageClass", text(d, "/spec/storageClassName"));
            if phase == Some("Pending") {
                v.flag(Problem::Pending);
            }
        }
        ("", "PersistentVolume") => {
            v.put_some("capacity", text(d, "/spec/capacity/storage"));
            v.put_some("accessModes", strings(d, "/spec/accessModes").as_deref());
            v.put_some("reclaimPolicy", text(d, "/spec/persistentVolumeReclaimPolicy"));
            v.put_some("status", text(d, "/status/phase"));
            if let (Some(ns), Some(name)) = (text(d, "/spec/claimRef/namespace"), text(d, "/spec/claimRef/name")) {
                v.put("claim", format!("{ns}/{name}"));
            }
            v.put_some("storageClass", text(d, "/spec/storageClassName"));
        }
        ("storage.k8s.io", "StorageClass") => {
            v.put_some("provisioner", text(d, "/provisioner"));
            v.put_some("reclaimPolicy", text(d, "/reclaimPolicy"));
            v.put_some("volumeBindingMode", text(d, "/volumeBindingMode"));
            if annotation(obj, DEFAULT_CLASS_ANNOTATION) == Some("true") {
                v.put("default", "true");
            }
        }
        ("", "Node") => {
            let ready = condition(d, "Ready");
            let mut status = match ready {
                Some("True") => "Ready",
                Some("False") => "NotReady",
                _ => "Unknown",
            }
            .to_string();
            if d.pointer("/spec/unschedulable") == Some(&Value::Bool(true)) {
                status.push_str(",SchedulingDisabled");
            }
            if ready != Some("True") {
                v.flag(Problem::NotReady);
            }
            v.put("status", status);
            v.put_some("version", text(d, "/status/nodeInfo/kubeletVersion"));
            let labels = labels_of(obj);
            v.put_some("instanceType", labels.get(INSTANCE_TYPE_LABEL).map(String::as_str));
            v.put_some("zone", labels.get(ZONE_LABEL).map(String::as_str));
            let (kind, group) = node_group(&labels);
            v.put("groupKind", kind.as_str());
            v.put_some("group", group.as_deref());
        }
        ("", "Event") => {
            v.put_some("type", text(d, "/type"));
            v.put_some("reason", text(d, "/reason"));
            v.put("object", event_object(d));
            v.put_some("message", text(d, "/message"));
            v.put("count", event_count(d).to_string());
            if let Some(t) = event_last_seen(obj) {
                v.put("lastSeen", t);
            }
        }
        ("", "Namespace") => v.put_some("status", text(d, "/status/phase")),
        // 그 밖의 종류(CRD 포함): Ready 조건이 있으면 보여 준다
        _ => {
            if let Some(s) = condition(d, "Ready") {
                v.put("ready", s);
                if s == "False" {
                    v.flag(Problem::NotReady);
                }
            }
        }
```

(`p["port"]` formats a JSON number without quotes; if a port is missing the cell shows `null/TCP`, which never happens for a valid Service.)

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `cd src-tauri && cargo test --lib k8s && cargo clippy --all-targets -- -D warnings`
Expected: all pass, clippy clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/k8s/read/values.rs src-tauri/src/k8s/read/values/tests.rs
git commit -m "feat(k8s): row values for network, config, storage, node, event and custom kinds

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task K2-B4: `read::bounded`, API discovery, `k8s_kinds`

**Files:**
- Modify: `src-tauri/src/k8s/read.rs`, `src-tauri/src/k8s/read/tests.rs`, `src-tauri/src/k8s_commands.rs`, `src-tauri/src/lib.rs`
- Create: `src-tauri/src/k8s/read/kinds.rs`, `src-tauri/src/k8s/read/kinds/tests.rs`

**Interfaces:**
- Consumes: `connect::REQUEST_TIMEOUT`, `failure::{describe, failure_of, Endpoint, Failure}`, `rows::KindRef`, `K8sState::session`.
- Produces:
  - `pub async fn read::bounded<T>(fut: impl Future<Output = Result<T, kube::Error>>, verb: &str, resource: &str, endpoint: Endpoint) -> Result<T, AppError>` (30 s → the Unreachable message for the endpoint; errors through `failure_of(e, verb, resource)` + `describe`)
  - `#[derive(Debug, Clone, PartialEq, Serialize)] #[serde(rename_all = "camelCase")] pub struct kinds::Kind { #[serde(flatten)] pub kind: KindRef, pub verbs: Vec<String>, pub custom: bool }`
  - `pub const kinds::BUILTIN_GROUPS: &[&str]`
  - `pub fn kinds::kind_of(ar: &ApiResource, caps: &ApiCapabilities) -> Option<Kind>` (None unless it supports both `list` and `watch`)
  - `pub fn kinds::kinds_of(discovery: &Discovery) -> Vec<Kind>` (sorted by group, then kind)
  - `pub fn kinds::falls_back(f: &Failure) -> bool` (only `Failure::Other` falls back to per-group discovery)
  - `pub async fn kinds::discover(client: &Client, endpoint: Endpoint) -> Result<Discovery, AppError>`
  - Tauri command `k8s_kinds(target) -> Vec<Kind>`

- [ ] **Step 1: Write the failing tests**

Append to `src-tauri/src/k8s/read/tests.rs`:

```rust
use kube::core::Status;

use crate::error::AppError;
use crate::k8s::failure::{Endpoint, UNREACHABLE_PUBLIC};

const PUBLIC: Endpoint = Endpoint { public: true, private: false };

#[tokio::test(start_paused = true)]
async fn bounded_turns_a_slow_request_into_unreachable() {
    let slow = async {
        tokio::time::sleep(std::time::Duration::from_secs(31)).await;
        Ok::<(), kube::Error>(())
    };
    assert_eq!(bounded(slow, "list", "pods", PUBLIC).await, Err(AppError::Network { message: UNREACHABLE_PUBLIC.into() }));
}

#[tokio::test]
async fn bounded_maps_forbidden_to_the_verb_and_resource() {
    let denied = async { Err::<(), _>(kube::Error::Api(Box::new(Status::failure("no", "Forbidden").with_code(403)))) };
    assert_eq!(bounded(denied, "get", "secrets", PUBLIC).await, Err(AppError::AccessDenied { action: "get secrets".into() }));
    assert_eq!(bounded(async { Ok::<_, kube::Error>(7) }, "get", "x", PUBLIC).await, Ok(7));
}
```

Create `src-tauri/src/k8s/read/kinds/tests.rs`:

```rust
use kube::discovery::{ApiCapabilities, ApiResource, Scope};

use super::*;

fn ar(group: &str, version: &str, kind: &str, plural: &str) -> ApiResource {
    let api_version = if group.is_empty() { version.to_string() } else { format!("{group}/{version}") };
    ApiResource { group: group.into(), version: version.into(), api_version, kind: kind.into(), plural: plural.into() }
}

fn caps(scope: Scope, ops: &[&str]) -> ApiCapabilities {
    ApiCapabilities { scope, subresources: vec![], operations: ops.iter().map(|s| s.to_string()).collect() }
}

#[test]
fn listable_builtin_and_custom_kinds() {
    let d = kind_of(&ar("apps", "v1", "Deployment", "deployments"), &caps(Scope::Namespaced, &["get", "list", "watch", "create"])).unwrap();
    assert_eq!(d.kind, KindRef { group: "apps".into(), version: "v1".into(), kind: "Deployment".into(), plural: "deployments".into(), namespaced: true });
    assert!(!d.custom);
    assert_eq!(d.verbs, ["get", "list", "watch", "create"]);
    let w = kind_of(&ar("mm.example.com", "v1", "Widget", "widgets"), &caps(Scope::Cluster, &["list", "watch"])).unwrap();
    assert!(w.custom && !w.kind.namespaced);
    let core = kind_of(&ar("", "v1", "Pod", "pods"), &caps(Scope::Namespaced, &["list", "watch"])).unwrap();
    assert!(!core.custom);
}

#[test]
fn kinds_without_list_and_watch_are_left_out() {
    // metrics.k8s.io는 get, list만 된다
    assert_eq!(kind_of(&ar("metrics.k8s.io", "v1beta1", "PodMetrics", "pods"), &caps(Scope::Namespaced, &["get", "list"])), None);
    assert_eq!(kind_of(&ar("authorization.k8s.io", "v1", "SelfSubjectReview", "selfsubjectreviews"), &caps(Scope::Cluster, &["create"])), None);
}

#[test]
fn kind_json_is_flat() {
    let k = kind_of(&ar("apps", "v1", "Deployment", "deployments"), &caps(Scope::Namespaced, &["list", "watch"])).unwrap();
    assert_eq!(
        serde_json::to_value(k).unwrap(),
        serde_json::json!({ "group": "apps", "version": "v1", "kind": "Deployment", "plural": "deployments", "namespaced": true, "verbs": ["list", "watch"], "custom": false })
    );
}

#[test]
fn only_other_failures_fall_back_to_per_group_discovery() {
    assert!(falls_back(&Failure::Other("the server could not find the requested resource".into())));
    for f in [Failure::Unreachable, Failure::Tls, Failure::Unauthorized, Failure::SsoExpired, Failure::Forbidden { verb: "get".into(), resource: "api".into() }] {
        assert!(!falls_back(&f), "{f:?}");
    }
}
```

`k8s_kinds` is a thin wrapper over `kinds::discover` + `kinds_of` (session lookup is K1-tested); the live test in Task K2-B10 covers it against a real server.

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `cd src-tauri && cargo test --lib k8s::read`
Expected: compile errors (`bounded`, `kinds` not found).

- [ ] **Step 3: Implement**

In `src-tauri/src/k8s/read.rs`, add the module and `bounded`:

```rust
pub mod kinds;
pub mod values;

use std::future::Future;

use super::connect::REQUEST_TIMEOUT;
use super::failure::{describe, failure_of, Endpoint, Failure};
use crate::error::AppError;

/// 쿠버네티스 요청 하나를 `REQUEST_TIMEOUT` 안에 끝낸다. 시간이 넘으면 엔드포인트에 맞는 연결 안내, 오류는 동작·리소스 이름으로 가른다.
pub async fn bounded<T>(fut: impl Future<Output = Result<T, kube::Error>>, verb: &str, resource: &str, endpoint: Endpoint) -> Result<T, AppError> {
    tokio::time::timeout(REQUEST_TIMEOUT, fut)
        .await
        .map_err(|_| describe(&Failure::Unreachable, endpoint))?
        .map_err(|e| describe(&failure_of(&e, verb, resource), endpoint))
}
```

Create `src-tauri/src/k8s/read/kinds.rs`:

```rust
//! API discovery로 클러스터가 내주는 종류를 나열한다. 목록과 watch가 모두 되는 것만 둔다(화면이 watch로 목록을 받는다).
//! CRD인지는 내장 API 그룹 표로 가른다(CRD 목록을 읽을 권한이 없는 신원도 많다).
use kube::discovery::{ApiCapabilities, ApiResource, Discovery, Scope};
use kube::Client;
use serde::Serialize;

use super::bounded;
use crate::error::AppError;
use crate::k8s::connect::REQUEST_TIMEOUT;
use crate::k8s::failure::{describe, failure_of, Endpoint, Failure};
use crate::k8s::rows::KindRef;

/// 쿠버네티스가 직접 내주는 API 그룹(1.33 기준). 여기 없는 그룹은 사용자 정의 리소스로 본다.
pub const BUILTIN_GROUPS: &[&str] = &[
    "",
    "admissionregistration.k8s.io",
    "apiextensions.k8s.io",
    "apiregistration.k8s.io",
    "apps",
    "authentication.k8s.io",
    "authorization.k8s.io",
    "autoscaling",
    "batch",
    "certificates.k8s.io",
    "coordination.k8s.io",
    "discovery.k8s.io",
    "events.k8s.io",
    "flowcontrol.apiserver.k8s.io",
    "internal.apiserver.k8s.io",
    "metrics.k8s.io",
    "networking.k8s.io",
    "node.k8s.io",
    "policy",
    "rbac.authorization.k8s.io",
    "resource.k8s.io",
    "scheduling.k8s.io",
    "storage.k8s.io",
    "storagemigration.k8s.io",
];

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Kind {
    #[serde(flatten)]
    pub kind: KindRef,
    pub verbs: Vec<String>,
    pub custom: bool,
}

pub fn kind_of(ar: &ApiResource, caps: &ApiCapabilities) -> Option<Kind> {
    let listable = ["list", "watch"].iter().all(|v| caps.operations.iter().any(|o| o == v));
    if !listable {
        return None;
    }
    Some(Kind {
        kind: KindRef { group: ar.group.clone(), version: ar.version.clone(), kind: ar.kind.clone(), plural: ar.plural.clone(), namespaced: caps.scope == Scope::Namespaced },
        verbs: caps.operations.clone(),
        custom: !BUILTIN_GROUPS.contains(&ar.group.as_str()),
    })
}

/// 그룹마다 권장 버전의 종류. 그룹·종류 이름 순서.
pub fn kinds_of(discovery: &Discovery) -> Vec<Kind> {
    let mut out: Vec<Kind> = discovery.groups().flat_map(|g| g.recommended_resources()).filter_map(|(ar, caps)| kind_of(&ar, &caps)).collect();
    out.sort_by(|a, b| (&a.kind.group, &a.kind.kind).cmp(&(&b.kind.group, &b.kind.kind)));
    out
}

/// 집계 discovery가 서버에서 안 될 때(오래된 서버, 프록시)만 그룹별 discovery로 다시 묻는다. 권한·연결·인증 문제는 다시 물어도 같다.
pub fn falls_back(f: &Failure) -> bool {
    matches!(f, Failure::Other(_))
}

/// 집계 discovery(1.30부터 정식)를 먼저 쓴다. 각 시도는 `REQUEST_TIMEOUT` 안에 끝나야 한다.
pub async fn discover(client: &Client, endpoint: Endpoint) -> Result<Discovery, AppError> {
    let first = tokio::time::timeout(REQUEST_TIMEOUT, Discovery::new(client.clone()).run_aggregated()).await.map_err(|_| describe(&Failure::Unreachable, endpoint))?;
    match first {
        Ok(d) => Ok(d),
        Err(e) => {
            let failure = failure_of(&e, "get", "api");
            if !falls_back(&failure) {
                return Err(describe(&failure, endpoint));
            }
            bounded(Discovery::new(client.clone()).run(), "get", "api", endpoint).await
        }
    }
}

#[cfg(test)]
mod tests;
```

In `src-tauri/src/k8s_commands.rs`, add `use crate::k8s::read::kinds::{self, Kind};` and:

```rust
/// 클러스터가 내주는 종류(목록·watch가 되는 것). 사용자 정의 리소스 목록을 만든다.
#[tauri::command]
pub async fn k8s_kinds(k8s: State<'_, K8sState>, target: K8sTarget) -> Result<Vec<Kind>, AppError> {
    let s = k8s.session(&target)?;
    let discovery = kinds::discover(&s.client, s.endpoint).await?;
    Ok(kinds::kinds_of(&discovery))
}
```

In `src-tauri/src/lib.rs`, add `k8s_commands::k8s_kinds,` after `k8s_commands::k8s_unwatch,` in `invoke_handler`.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `cd src-tauri && cargo test --lib k8s && cargo clippy --all-targets -- -D warnings`
Expected: all pass, clippy clean. The hygiene test still passes.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/k8s/read.rs src-tauri/src/k8s/read/tests.rs src-tauri/src/k8s/read/kinds.rs src-tauri/src/k8s/read/kinds/tests.rs src-tauri/src/k8s_commands.rs src-tauri/src/lib.rs
git commit -m "feat(k8s): API discovery and the k8s_kinds command with a request time limit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task K2-B5: Secret masking, `k8s_secret_value`, and the view YAML

**Files:**
- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/k8s/read.rs`, `src-tauri/src/k8s_commands.rs`, `src-tauri/src/lib.rs`
- Create: `src-tauri/src/k8s/read/secret.rs`, `src-tauri/src/k8s/read/secret/tests.rs`, `src-tauri/src/k8s/read/yaml.rs`, `src-tauri/src/k8s/read/yaml/tests.rs`

**Interfaces:**
- Consumes: `read::{api_for, bounded}`, `rows::KindRef`.
- Produces:
  - `read/secret.rs`: `pub const MASK: &str = "••••"`, `pub const LAST_APPLIED: &str = "kubectl.kubernetes.io/last-applied-configuration"`, `pub const SECRET_UNREADABLE: &str`, `pub fn key_missing(key: &str) -> String`, `pub fn is_secret(kind: &KindRef) -> bool`, `pub fn secrets_kind() -> KindRef`, `pub fn mask(obj: &mut Value)` (idempotent), `#[derive(Debug, Clone, PartialEq, Serialize)] pub struct SecretKey { pub key: String, pub size: u64 }`, `pub fn keys(obj: &Value) -> Vec<SecretKey>` (sorted by key), `#[derive(Debug, Clone, Copy, PartialEq, Serialize)] #[serde(rename_all = "camelCase")] pub enum Encoding { Utf8, Base64 }`, `#[derive(Clone, PartialEq, Serialize)] pub struct SecretValue { pub text: String, pub encoding: Encoding }` with a `Debug` that prints `SecretValue(••••)`, `pub fn value_of(obj: &Value, key: &str) -> Result<SecretValue, AppError>`, `pub async fn secret_value(client: &Client, namespace: &str, name: &str, key: &str, endpoint: Endpoint) -> Result<SecretValue, AppError>`
  - `read/yaml.rs`: `pub const YAML_FAILED: &str = "YAML로 바꾸지 못했어요"`, `pub fn view_yaml(kind: &KindRef, obj: &Value) -> Result<String, AppError>`
  - Tauri command `k8s_secret_value(target, namespace: String, name: String, key: String) -> SecretValue`

- [ ] **Step 1: Add the crates**

In `src-tauri/Cargo.toml` `[dependencies]`, after `k8s-openapi`:

```toml
# 보기용 YAML과 Secret 값 풀기. 둘 다 kube-client가 이미 쓰는 크레이트(같은 버전)라 새로 받는 것은 없다
serde-saphyr = "0.0.29"
base64 = "0.22"
```

Run: `cd src-tauri && cargo tree -i serde-saphyr && cargo tree -i base64@0.22.1 | head -5`
Expected: both already used by `kube-client`; `Cargo.lock` gains no new `[[package]]` entries (`git diff --stat Cargo.lock` shows only the root package's dependency list).

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/k8s/read/secret/tests.rs`:

```rust
use serde_json::json;

use super::*;

fn secret() -> Value {
    json!({
        "apiVersion": "v1", "kind": "Secret", "type": "Opaque",
        "metadata": { "name": "db", "namespace": "web", "annotations": {
            "kubectl.kubernetes.io/last-applied-configuration": "{\"data\":{\"password\":\"aHVudGVyMg==\"}}",
            "team": "a"
        } },
        // hunter2, 바이너리 두 바이트(0xff 0xfe)
        "data": { "password": "aHVudGVyMg==", "blob": "//4=" },
        "stringData": { "token": "plain-secret" }
    })
}

#[test]
fn mask_hides_values_and_the_last_applied_annotation_but_keeps_keys() {
    let mut s = secret();
    mask(&mut s);
    assert_eq!(s["data"], json!({ "password": MASK, "blob": MASK }));
    assert_eq!(s["stringData"], json!({ "token": MASK }));
    assert_eq!(s["metadata"]["annotations"][LAST_APPLIED], json!(MASK));
    assert_eq!(s["metadata"]["annotations"]["team"], json!("a"));
    let text = s.to_string();
    for leak in ["aHVudGVyMg==", "hunter2", "plain-secret", "//4="] {
        assert!(!text.contains(leak), "{leak}");
    }
    let once = s.clone();
    mask(&mut s);
    assert_eq!(s, once);
}

#[test]
fn keys_report_decoded_sizes_sorted() {
    assert_eq!(
        keys(&secret()),
        [SecretKey { key: "blob".into(), size: 2 }, SecretKey { key: "password".into(), size: 7 }, SecretKey { key: "token".into(), size: 12 }]
    );
    assert!(keys(&json!({ "kind": "Secret" })).is_empty());
}

#[test]
fn value_of_decodes_text_and_falls_back_to_base64() {
    assert_eq!(value_of(&secret(), "password").unwrap(), SecretValue { text: "hunter2".into(), encoding: Encoding::Utf8 });
    assert_eq!(value_of(&secret(), "blob").unwrap(), SecretValue { text: "//4=".into(), encoding: Encoding::Base64 });
    assert_eq!(value_of(&secret(), "token").unwrap(), SecretValue { text: "plain-secret".into(), encoding: Encoding::Utf8 });
}

#[test]
fn errors_name_the_key_and_never_the_value() {
    assert_eq!(value_of(&secret(), "nope").unwrap_err(), AppError::other(key_missing("nope")));
    assert_eq!(key_missing("nope"), "이 Secret에 nope 키가 없어요");
    let bad = json!({ "data": { "k": "not base64 hunter2!" } });
    let err = value_of(&bad, "k").unwrap_err();
    assert_eq!(err, AppError::other(SECRET_UNREADABLE));
    assert!(!format!("{err:?}").contains("hunter2"));
}

#[test]
fn debug_and_json_shapes() {
    let v = value_of(&secret(), "password").unwrap();
    assert_eq!(format!("{v:?}"), "SecretValue(••••)");
    assert_eq!(serde_json::to_value(&v).unwrap(), json!({ "text": "hunter2", "encoding": "utf8" }));
    assert_eq!(serde_json::to_value(SecretKey { key: "a".into(), size: 1 }).unwrap(), json!({ "key": "a", "size": 1 }));
}

#[test]
fn secret_kind_detection() {
    assert!(is_secret(&secrets_kind()));
    let cm = KindRef { group: "".into(), version: "v1".into(), kind: "ConfigMap".into(), plural: "configmaps".into(), namespaced: true };
    assert!(!is_secret(&cm));
}
```

Create `src-tauri/src/k8s/read/yaml/tests.rs`:

```rust
use serde_json::json;

use super::*;
use crate::k8s::read::secret::{secrets_kind, MASK};

fn deployments() -> KindRef {
    KindRef { group: "apps".into(), version: "v1".into(), kind: "Deployment".into(), plural: "deployments".into(), namespaced: true }
}

fn deployment() -> Value {
    json!({
        "status": { "readyReplicas": 1 },
        "spec": { "replicas": 1, "template": { "spec": { "containers": [{ "name": "app", "image": "nginx:1.27", "args": ["--port", "8080"] }] } } },
        "metadata": { "name": "web", "namespace": "prod", "managedFields": [{ "manager": "kubectl", "apiVersion": "apps/v1" }],
            "annotations": { "note": "line one\nline two: with colon" } },
        "kind": "Deployment",
        "apiVersion": "apps/v1"
    })
}

#[test]
fn drops_managed_fields_keeps_status_and_uses_kubectl_order() {
    let y = view_yaml(&deployments(), &deployment()).unwrap();
    assert!(!y.contains("managedFields"));
    let at = |k: &str| y.find(&format!("\n{k}:")).or_else(|| y.starts_with(&format!("{k}:")).then_some(0)).unwrap_or_else(|| panic!("{k} missing in\n{y}"));
    assert!(at("apiVersion") < at("kind") && at("kind") < at("metadata") && at("metadata") < at("spec") && at("spec") < at("status"), "{y}");
}

#[test]
fn round_trips_to_the_same_value() {
    let y = view_yaml(&deployments(), &deployment()).unwrap();
    let back: Value = serde_saphyr::from_str(&y).unwrap();
    let mut expected = deployment();
    expected["metadata"].as_object_mut().unwrap().remove("managedFields");
    assert_eq!(back, expected);
}

#[test]
fn secret_yaml_is_masked() {
    let s = json!({ "apiVersion": "v1", "kind": "Secret", "metadata": { "name": "db", "annotations": {
        "kubectl.kubernetes.io/last-applied-configuration": "{\"data\":{\"p\":\"aHVudGVyMg==\"}}" } },
        "data": { "p": "aHVudGVyMg==" } });
    let y = view_yaml(&secrets_kind(), &s).unwrap();
    assert!(y.contains(MASK));
    assert!(!y.contains("aHVudGVyMg==") && !y.contains("hunter2"), "{y}");
}

#[test]
fn other_kinds_are_not_masked() {
    let cm = KindRef { group: "".into(), version: "v1".into(), kind: "ConfigMap".into(), plural: "configmaps".into(), namespaced: true };
    let y = view_yaml(&cm, &json!({ "apiVersion": "v1", "kind": "ConfigMap", "metadata": { "name": "c" }, "data": { "k": "visible" } })).unwrap();
    assert!(y.contains("visible"));
}
```

`k8s_secret_value` is a thin wrapper over `secret::secret_value`; the live test in Task K2-B10 reads a real Secret through it.

- [ ] **Step 3: Run the tests to make sure they fail**

Run: `cd src-tauri && cargo test --lib k8s::read`
Expected: compile errors (`secret`, `yaml` modules missing).

- [ ] **Step 4: Implement**

In `src-tauri/src/k8s/read.rs`, add `pub mod secret;` and `pub mod yaml;` to the module list (alphabetical: `kinds`, `secret`, `values`, `yaml`).

Create `src-tauri/src/k8s/read/secret.rs`:

```rust
//! Secret 값 다루기. 값은 `k8s_secret_value`(`secret_value`)로만 나간다. 상세·YAML에서는 가리고(`mask`), 오류에는 키 이름까지만 넣는다.
use std::fmt;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use kube::Client;
use serde::Serialize;
use serde_json::Value;

use super::{api_for, bounded};
use crate::error::AppError;
use crate::k8s::failure::Endpoint;
use crate::k8s::rows::KindRef;

pub const MASK: &str = "••••";
/// `kubectl apply`가 남기는 어노테이션. Secret이면 그 안에 값이 그대로 들어 있다.
pub const LAST_APPLIED: &str = "kubectl.kubernetes.io/last-applied-configuration";
pub const SECRET_UNREADABLE: &str = "Secret 값을 해석하지 못했어요";

pub fn key_missing(key: &str) -> String {
    format!("이 Secret에 {key} 키가 없어요")
}

pub fn is_secret(kind: &KindRef) -> bool {
    kind.group.is_empty() && kind.kind == "Secret"
}

pub fn secrets_kind() -> KindRef {
    KindRef { group: String::new(), version: "v1".into(), kind: "Secret".into(), plural: "secrets".into(), namespaced: true }
}

/// `data`, `stringData`의 모든 값과 last-applied 어노테이션을 `MASK`로 바꾼다. 키는 그대로 둔다.
pub fn mask(obj: &mut Value) {
    for field in ["data", "stringData"] {
        if let Some(Value::Object(m)) = obj.get_mut(field) {
            for v in m.values_mut() {
                *v = Value::String(MASK.into());
            }
        }
    }
    if let Some(Value::Object(a)) = obj.pointer_mut("/metadata/annotations") {
        if let Some(v) = a.get_mut(LAST_APPLIED) {
            *v = Value::String(MASK.into());
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretKey {
    pub key: String,
    pub size: u64,
}

/// 키와 값의 바이트 수. `data`는 base64를 풀어 잰다(풀지 못하면 글자 수). `stringData`는 서버가 돌려주지 않는 쓰기용 필드지만 있으면 센다.
pub fn keys(obj: &Value) -> Vec<SecretKey> {
    let mut out: Vec<SecretKey> = Vec::new();
    if let Some(m) = obj.get("data").and_then(Value::as_object) {
        for (k, v) in m {
            let s = v.as_str().unwrap_or("");
            let size = STANDARD.decode(s).map_or(s.len(), |b| b.len()) as u64;
            out.push(SecretKey { key: k.clone(), size });
        }
    }
    if let Some(m) = obj.get("stringData").and_then(Value::as_object) {
        for (k, v) in m {
            if !out.iter().any(|e| e.key == *k) {
                out.push(SecretKey { key: k.clone(), size: v.as_str().map_or(0, str::len) as u64 });
            }
        }
    }
    out.sort_by(|a, b| a.key.cmp(&b.key));
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Encoding {
    Utf8,
    Base64,
}

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretValue {
    pub text: String,
    pub encoding: Encoding,
}

/// 값이 로그나 패닉 글에 찍히지 않게 손으로 쓴다
impl fmt::Debug for SecretValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretValue(••••)")
    }
}

/// 키 하나의 값. UTF-8이면 글로, 아니면 base64 그대로.
pub fn value_of(obj: &Value, key: &str) -> Result<SecretValue, AppError> {
    if let Some(s) = obj.get("data").and_then(|d| d.get(key)).and_then(Value::as_str) {
        let bytes = STANDARD.decode(s).map_err(|_| AppError::other(SECRET_UNREADABLE))?;
        return Ok(match String::from_utf8(bytes) {
            Ok(text) => SecretValue { text, encoding: Encoding::Utf8 },
            Err(e) => SecretValue { text: STANDARD.encode(e.into_bytes()), encoding: Encoding::Base64 },
        });
    }
    if let Some(s) = obj.get("stringData").and_then(|d| d.get(key)).and_then(Value::as_str) {
        return Ok(SecretValue { text: s.to_string(), encoding: Encoding::Utf8 });
    }
    Err(AppError::other(key_missing(key)))
}

/// 누를 때마다 서버에서 읽는다(캐시하지 않는다)
pub async fn secret_value(client: &Client, namespace: &str, name: &str, key: &str, endpoint: Endpoint) -> Result<SecretValue, AppError> {
    let api = api_for(client.clone(), &secrets_kind(), Some(namespace));
    let obj = bounded(api.get(name), "get", "secrets", endpoint).await?;
    value_of(&obj.data, key)
}

#[cfg(test)]
mod tests;
```

Create `src-tauri/src/k8s/read/yaml.rs`:

```rust
//! 보기용 YAML. managedFields를 빼고(status는 둔다), Secret이면 값을 가린 뒤 kubectl 순서(apiVersion, kind, metadata, 나머지, status)로 쓴다.
use serde::ser::{SerializeMap, Serializer};
use serde::Serialize;
use serde_json::Value;

use super::secret::{is_secret, mask};
use crate::error::AppError;
use crate::k8s::rows::KindRef;

/// 직렬화 오류의 글에는 값 조각이 실릴 수 있어 고정 문구만 쓴다
pub const YAML_FAILED: &str = "YAML로 바꾸지 못했어요";
const FIRST: [&str; 3] = ["apiVersion", "kind", "metadata"];
const LAST: &str = "status";

pub fn view_yaml(kind: &KindRef, obj: &Value) -> Result<String, AppError> {
    let mut v = obj.clone();
    if let Some(Value::Object(meta)) = v.get_mut("metadata") {
        meta.remove("managedFields");
    }
    if is_secret(kind) {
        mask(&mut v);
    }
    serde_saphyr::to_string(&Ordered(&v)).map_err(|_| AppError::other(YAML_FAILED))
}

/// 맨 위 키만 kubectl 순서로 쓴다. 안쪽은 원래(이름) 순서.
struct Ordered<'a>(&'a Value);

impl Serialize for Ordered<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let Value::Object(m) = self.0 else { return self.0.serialize(s) };
        let rank = |k: &str| match FIRST.iter().position(|f| *f == k) {
            Some(i) => i,
            None if k == LAST => FIRST.len() + 1,
            None => FIRST.len(),
        };
        let mut keys: Vec<&String> = m.keys().collect();
        keys.sort_by_key(|k| rank(k));
        let mut map = s.serialize_map(Some(m.len()))?;
        for k in keys {
            map.serialize_entry(k, &m[k])?;
        }
        map.end()
    }
}

#[cfg(test)]
mod tests;
```

In `src-tauri/src/k8s_commands.rs`, add `use crate::k8s::read::secret::{self, SecretValue};` and:

```rust
/// Secret 키 하나의 값. 화면이 "값 보기"를 누를 때만 부른다. 값은 기록·오류에 넣지 않는다.
#[tauri::command]
pub async fn k8s_secret_value(k8s: State<'_, K8sState>, target: K8sTarget, namespace: String, name: String, key: String) -> Result<SecretValue, AppError> {
    let s = k8s.session(&target)?;
    secret::secret_value(&s.client, &namespace, &name, &key, s.endpoint).await
}
```

In `src-tauri/src/lib.rs`, add `k8s_commands::k8s_secret_value,` after `k8s_commands::k8s_kinds,`.

- [ ] **Step 5: Run the tests to make sure they pass**

Run: `cd src-tauri && cargo test --lib k8s && cargo clippy --all-targets -- -D warnings`
Expected: all pass, clippy clean. If `serde_saphyr::to_string` quotes or folds the multi-line annotation differently, `round_trips_to_the_same_value` still passes as long as the parsed value is equal; do not loosen it to a string comparison.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/k8s/read.rs src-tauri/src/k8s/read/secret.rs src-tauri/src/k8s/read/secret/tests.rs src-tauri/src/k8s/read/yaml.rs src-tauri/src/k8s/read/yaml/tests.rs src-tauri/src/k8s_commands.rs src-tauri/src/lib.rs
git commit -m "feat(k8s): Secret masking, the k8s_secret_value command, and the view YAML

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task K2-B6: Object detail and `k8s_get`

**Files:**
- Create: `src-tauri/src/k8s/read/detail.rs`, `src-tauri/src/k8s/read/detail/tests.rs`
- Modify: `src-tauri/src/k8s/read.rs`, `src-tauri/src/k8s_commands.rs`, `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `read::{api_for, bounded}`, `values::{values_of, list, text, int, Problem, event_count, event_last_seen, event_object}`, `secret::{is_secret, keys, mask, SecretKey}`, `yaml::{view_yaml, YAML_FAILED}`, `rows::{row_of, KindRef, Row}`.
- Produces (all `#[derive(Debug, Clone, PartialEq, Serialize)] #[serde(rename_all = "camelCase")]`):
  - `pub struct Link { pub group: String, pub version: String, pub kind: String, pub name: String, pub namespace: Option<String>, pub uid: String, pub controller: bool, pub problems: Vec<Problem> }`
  - `pub struct Termination { pub reason: Option<String>, pub exit_code: i64, pub finished_at: Option<String> }`
  - `pub enum ContainerState { Running, Waiting, Terminated, Unknown, Template }`
  - `pub struct Container { pub name: String, pub image: String, pub init: bool, pub state: ContainerState, pub ready: bool, pub restarts: i64, pub reason: Option<String>, pub message: Option<String>, pub last_termination: Option<Termination> }`
  - `pub struct Condition { #[serde(rename = "type")] pub type_: String, pub status: String, pub reason: Option<String>, pub message: Option<String>, pub last_transition: Option<String> }`
  - `pub struct EventView { #[serde(rename = "type")] pub type_: String, pub reason: String, pub message: String, pub count: i64, pub last_seen: Option<String>, pub source: Option<String>, pub object: String }`
  - `pub struct ObjectView { pub kind: KindRef, pub row: Row, pub annotations: BTreeMap<String, String>, pub owners: Vec<Link>, pub children: Vec<Link>, pub children_truncated: bool, pub children_error: Option<AppError>, pub containers: Vec<Container>, pub conditions: Vec<Condition>, pub events: Vec<EventView>, pub events_error: Option<AppError>, pub yaml: String, pub secret_keys: Option<Vec<SecretKey>> }`
  - `pub const CHILDREN_MAX: u32 = 500`, `pub const EVENTS_MAX: usize = 100`
  - pure: `pub fn split_api_version(v: &str) -> (String, String)`, `pub fn owners_of(obj: &DynamicObject) -> Vec<Link>`, `pub fn child_kind(kind: &KindRef) -> Option<KindRef>`, `pub fn selector_of(obj: &Value) -> Option<String>`, `pub fn children_of(child: &KindRef, owner_uid: &str, items: &[DynamicObject]) -> Vec<Link>` (sorted by name), `pub fn containers_of(kind: &KindRef, d: &Value) -> Vec<Container>`, `pub fn conditions_of(d: &Value) -> Vec<Condition>`, `pub fn events_of(items: &[DynamicObject]) -> Vec<EventView>` (newest first, at most `EVENTS_MAX`), `pub fn events_kind() -> KindRef`, `pub fn view_of(kind: &KindRef, obj: &DynamicObject) -> Result<ObjectView, AppError>` (children/events empty)
  - async: `pub async fn get(client: &Client, kind: &KindRef, namespace: Option<&str>, name: &str, endpoint: Endpoint) -> Result<ObjectView, AppError>`
  - Tauri command `k8s_get(target, kind: KindRef, namespace: Option<String>, name: String) -> ObjectView`

Child kinds: Deployment → ReplicaSet (`apps/v1 replicasets`); ReplicaSet, StatefulSet, DaemonSet, Job → Pod (`v1 pods`); CronJob → Job (`batch/v1 jobs`); others → none. The children list uses the owner's `spec.selector.matchLabels` as a label selector when present (narrows the list; `matchExpressions` are ignored so the list is wider, never narrower), one page of 500, then keeps items whose `ownerReferences` include the owner's uid. Related events: `involvedObject.uid=<uid>` field selector, in the object's namespace (all namespaces for cluster-scoped objects), one page of 100. Failures of children or events go into `childrenError`/`eventsError`; only the object `get` itself fails the command.

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/k8s/read/detail/tests.rs`:

```rust
use serde_json::json;

use super::*;
use crate::k8s::read::secret::{secrets_kind, MASK};

fn kind(group: &str, k: &str, plural: &str) -> KindRef {
    KindRef { group: group.into(), version: "v1".into(), kind: k.into(), plural: plural.into(), namespaced: true }
}

fn obj(v: serde_json::Value) -> DynamicObject {
    serde_json::from_value(v).unwrap()
}

fn pod() -> DynamicObject {
    obj(json!({
        "apiVersion": "v1", "kind": "Pod",
        "metadata": { "name": "web-1", "namespace": "prod", "uid": "p1", "resourceVersion": "9",
            "ownerReferences": [{ "apiVersion": "apps/v1", "kind": "ReplicaSet", "name": "web-5d", "uid": "rs1", "controller": true }],
            "managedFields": [{ "manager": "kubelet" }] },
        "spec": {
            "initContainers": [{ "name": "init", "image": "busybox" }],
            "containers": [{ "name": "app", "image": "nginx:1.27" }, { "name": "side", "image": "envoy" }]
        },
        "status": {
            "phase": "Running",
            "conditions": [{ "type": "Ready", "status": "False", "reason": "ContainersNotReady", "message": "containers with unready status: [app]", "lastTransitionTime": "2026-10-30T01:00:00Z" }],
            "initContainerStatuses": [{ "name": "init", "ready": true, "restartCount": 0, "state": { "terminated": { "reason": "Completed", "exitCode": 0 } } }],
            "containerStatuses": [
                { "name": "app", "ready": false, "restartCount": 4, "state": { "waiting": { "reason": "CrashLoopBackOff", "message": "back-off 40s" } },
                  "lastState": { "terminated": { "reason": "OOMKilled", "exitCode": 137, "finishedAt": "2026-10-30T00:59:00Z" } } },
                { "name": "side", "ready": true, "restartCount": 0, "state": { "running": { "startedAt": "2026-10-30T00:00:00Z" } } }
            ]
        }
    }))
}

#[test]
fn api_versions_split_into_group_and_version() {
    assert_eq!(split_api_version("apps/v1"), ("apps".into(), "v1".into()));
    assert_eq!(split_api_version("v1"), ("".into(), "v1".into()));
}

#[test]
fn owners_come_from_owner_references() {
    assert_eq!(
        owners_of(&pod()),
        [Link { group: "apps".into(), version: "v1".into(), kind: "ReplicaSet".into(), name: "web-5d".into(), namespace: Some("prod".into()), uid: "rs1".into(), controller: true, problems: vec![] }]
    );
}

#[test]
fn pod_containers_carry_state_and_last_termination() {
    let c = containers_of(&kind("", "Pod", "pods"), &serde_json::to_value(pod()).unwrap());
    assert_eq!(c.iter().map(|c| (c.name.as_str(), c.init)).collect::<Vec<_>>(), [("init", true), ("app", false), ("side", false)]);
    assert_eq!((c[0].state, c[0].reason.as_deref()), (ContainerState::Terminated, Some("Completed")));
    assert_eq!((c[1].state, c[1].reason.as_deref(), c[1].message.as_deref(), c[1].restarts, c[1].ready), (ContainerState::Waiting, Some("CrashLoopBackOff"), Some("back-off 40s"), 4, false));
    assert_eq!(c[1].last_termination, Some(Termination { reason: Some("OOMKilled".into()), exit_code: 137, finished_at: Some("2026-10-30T00:59:00Z".into()) }));
    assert_eq!((c[2].state, c[2].ready, c[2].image.as_str()), (ContainerState::Running, true, "envoy"));
}

#[test]
fn workload_containers_come_from_the_template() {
    let d = json!({ "spec": { "template": { "spec": { "containers": [{ "name": "app", "image": "nginx" }] } } } });
    let c = containers_of(&kind("apps", "Deployment", "deployments"), &d);
    assert_eq!(c.len(), 1);
    assert_eq!((c[0].state, c[0].image.as_str()), (ContainerState::Template, "nginx"));
    let cj = json!({ "spec": { "jobTemplate": { "spec": { "template": { "spec": { "containers": [{ "name": "run", "image": "job" }] } } } } } });
    assert_eq!(containers_of(&kind("batch", "CronJob", "cronjobs"), &cj)[0].name, "run");
    assert!(containers_of(&kind("", "ConfigMap", "configmaps"), &json!({})).is_empty());
}

#[test]
fn conditions_are_listed() {
    let c = conditions_of(&serde_json::to_value(pod()).unwrap());
    assert_eq!(
        c,
        [Condition { type_: "Ready".into(), status: "False".into(), reason: Some("ContainersNotReady".into()), message: Some("containers with unready status: [app]".into()), last_transition: Some("2026-10-30T01:00:00Z".into()) }]
    );
}

#[test]
fn child_kinds_and_selector() {
    assert_eq!(child_kind(&kind("apps", "Deployment", "deployments")).map(|k| k.plural), Some("replicasets".into()));
    for (g, k, p) in [("apps", "ReplicaSet", "replicasets"), ("apps", "StatefulSet", "statefulsets"), ("apps", "DaemonSet", "daemonsets"), ("batch", "Job", "jobs")] {
        assert_eq!(child_kind(&kind(g, k, p)).map(|k| k.plural), Some("pods".into()), "{k}");
    }
    assert_eq!(child_kind(&kind("batch", "CronJob", "cronjobs")).map(|k| (k.group, k.plural)), Some(("batch".into(), "jobs".into())));
    assert_eq!(child_kind(&kind("", "Service", "services")), None);
    assert_eq!(selector_of(&json!({ "spec": { "selector": { "matchLabels": { "app": "web", "tier": "fe" } } } })), Some("app=web,tier=fe".into()));
    assert_eq!(selector_of(&json!({ "spec": { "selector": { "matchExpressions": [] } } })), None);
}

#[test]
fn children_are_filtered_by_owner_uid_and_carry_problems() {
    let child = |name: &str, owner: &str, phase: &str| {
        obj(json!({ "apiVersion": "v1", "kind": "Pod", "metadata": { "name": name, "namespace": "prod", "uid": format!("u-{name}"),
            "ownerReferences": [{ "apiVersion": "apps/v1", "kind": "ReplicaSet", "name": "rs", "uid": owner }] },
            "spec": { "containers": [{ "name": "a", "image": "x" }] }, "status": { "phase": phase } }))
    };
    let pods = kind("", "Pod", "pods");
    let items = [child("b", "rs1", "Pending"), child("a", "rs1", "Running"), child("c", "other", "Running")];
    let links = children_of(&pods, "rs1", &items);
    assert_eq!(links.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(), ["a", "b"]);
    assert_eq!(links[1].problems, [Problem::Pending]);
    assert!(!links[0].controller);
}

#[test]
fn events_are_newest_first_and_capped() {
    let ev = |i: usize| {
        obj(json!({ "apiVersion": "v1", "kind": "Event", "metadata": { "name": format!("e{i}"), "namespace": "prod" },
            "type": if i % 2 == 0 { "Normal" } else { "Warning" }, "reason": "R", "message": format!("m{i}"),
            "involvedObject": { "kind": "Pod", "name": "web-1" }, "source": { "component": "kubelet" },
            "lastTimestamp": format!("2026-10-30T{:02}:{:02}:00Z", i / 60, i % 60) }))
    };
    let items: Vec<DynamicObject> = (0..120).map(ev).collect();
    let got = events_of(&items);
    assert_eq!(got.len(), EVENTS_MAX);
    assert_eq!(got[0].message, "m119");
    assert_eq!((got[0].type_.as_str(), got[0].object.as_str(), got[0].source.as_deref(), got[0].count), ("Warning", "Pod/web-1", Some("kubelet"), 1));
}

#[test]
fn view_of_a_pod() {
    let v = view_of(&kind("", "Pod", "pods"), &pod()).unwrap();
    assert_eq!(v.row.name, "web-1");
    assert_eq!(v.owners.len(), 1);
    assert_eq!(v.containers.len(), 3);
    assert!(v.yaml.contains("web-1") && !v.yaml.contains("managedFields"));
    assert_eq!(v.secret_keys, None);
    assert!(v.children.is_empty() && v.events.is_empty());
}

#[test]
fn view_of_a_secret_masks_everything_but_counts_keys() {
    let s = obj(json!({ "apiVersion": "v1", "kind": "Secret", "type": "Opaque",
        "metadata": { "name": "db", "namespace": "prod", "uid": "s1", "annotations": {
            "kubectl.kubernetes.io/last-applied-configuration": "{\"data\":{\"p\":\"aHVudGVyMg==\"}}", "team": "a" } },
        "data": { "p": "aHVudGVyMg==" } }));
    let v = view_of(&secrets_kind(), &s).unwrap();
    assert_eq!(v.secret_keys, Some(vec![SecretKey { key: "p".into(), size: 7 }]));
    assert_eq!(v.annotations.get(crate::k8s::read::secret::LAST_APPLIED).map(String::as_str), Some(MASK));
    assert_eq!(v.annotations.get("team").map(String::as_str), Some("a"));
    let all = serde_json::to_string(&v).unwrap();
    assert!(!all.contains("aHVudGVyMg==") && !all.contains("hunter2"), "{all}");
}

#[test]
fn object_view_json_keys_match_the_ts_contract() {
    let v = serde_json::to_value(view_of(&kind("", "Pod", "pods"), &pod()).unwrap()).unwrap();
    for key in ["kind", "row", "annotations", "owners", "children", "childrenTruncated", "childrenError", "containers", "conditions", "events", "eventsError", "yaml", "secretKeys"] {
        assert!(v.get(key).is_some(), "{key}");
    }
    assert_eq!(v["containers"][1]["lastTermination"]["exitCode"], json!(137));
    assert_eq!(v["containers"][1]["state"], json!("waiting"));
    assert_eq!(v["conditions"][0]["type"], json!("Ready"));
    assert_eq!(v["conditions"][0]["lastTransition"], json!("2026-10-30T01:00:00Z"));
}
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `cd src-tauri && cargo test --lib k8s::read::detail`
Expected: compile error (`detail` module missing).

- [ ] **Step 3: Implement**

In `src-tauri/src/k8s/read.rs`, add `pub mod detail;` (first in the module list).

Create `src-tauri/src/k8s/read/detail.rs`:

```rust
//! 상세: 요약 줄, 소유 관계(위: ownerReferences, 아래: 알려진 자식 종류), 컨테이너, 상태 조건, 관련 이벤트, 보기용 YAML.
//! Secret은 키 크기를 센 뒤 JSON을 가리고, 어노테이션·YAML은 모두 가린 JSON에서 만든다.
use std::collections::BTreeMap;

use kube::api::{DynamicObject, ListParams};
use kube::Client;
use serde::Serialize;
use serde_json::Value;

use super::secret::{is_secret, keys, mask, SecretKey};
use super::values::{event_count, event_last_seen, event_object, list, text, Problem};
use super::yaml::{view_yaml, YAML_FAILED};
use super::{api_for, bounded};
use crate::error::AppError;
use crate::k8s::failure::Endpoint;
use crate::k8s::rows::{row_of, KindRef, Row};

pub const CHILDREN_MAX: u32 = 500;
pub const EVENTS_MAX: usize = 100;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub group: String,
    pub version: String,
    pub kind: String,
    pub name: String,
    pub namespace: Option<String>,
    pub uid: String,
    pub controller: bool,
    pub problems: Vec<Problem>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Termination {
    pub reason: Option<String>,
    pub exit_code: i64,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ContainerState {
    Running,
    Waiting,
    Terminated,
    Unknown,
    /// 워크로드의 Pod 템플릿에서 읽은 컨테이너(상태 없음)
    Template,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Container {
    pub name: String,
    pub image: String,
    pub init: bool,
    pub state: ContainerState,
    pub ready: bool,
    pub restarts: i64,
    pub reason: Option<String>,
    pub message: Option<String>,
    pub last_termination: Option<Termination>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Condition {
    #[serde(rename = "type")]
    pub type_: String,
    pub status: String,
    pub reason: Option<String>,
    pub message: Option<String>,
    pub last_transition: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventView {
    #[serde(rename = "type")]
    pub type_: String,
    pub reason: String,
    pub message: String,
    pub count: i64,
    pub last_seen: Option<String>,
    pub source: Option<String>,
    pub object: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectView {
    pub kind: KindRef,
    pub row: Row,
    pub annotations: BTreeMap<String, String>,
    pub owners: Vec<Link>,
    pub children: Vec<Link>,
    pub children_truncated: bool,
    pub children_error: Option<AppError>,
    pub containers: Vec<Container>,
    pub conditions: Vec<Condition>,
    pub events: Vec<EventView>,
    pub events_error: Option<AppError>,
    pub yaml: String,
    pub secret_keys: Option<Vec<SecretKey>>,
}

fn opt(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_string)
}

pub fn split_api_version(v: &str) -> (String, String) {
    match v.split_once('/') {
        Some((g, ver)) => (g.to_string(), ver.to_string()),
        None => (String::new(), v.to_string()),
    }
}

pub fn owners_of(obj: &DynamicObject) -> Vec<Link> {
    obj.metadata
        .owner_references
        .iter()
        .flatten()
        .map(|o| {
            let (group, version) = split_api_version(&o.api_version);
            Link { group, version, kind: o.kind.clone(), name: o.name.clone(), namespace: obj.metadata.namespace.clone(), uid: o.uid.clone(), controller: o.controller == Some(true), problems: vec![] }
        })
        .collect()
}

pub fn child_kind(kind: &KindRef) -> Option<KindRef> {
    let k = |group: &str, kind: &str, plural: &str| KindRef { group: group.into(), version: "v1".into(), kind: kind.into(), plural: plural.into(), namespaced: true };
    match (kind.group.as_str(), kind.kind.as_str()) {
        ("apps", "Deployment") => Some(k("apps", "ReplicaSet", "replicasets")),
        ("apps", "ReplicaSet" | "StatefulSet" | "DaemonSet") | ("batch", "Job") => Some(k("", "Pod", "pods")),
        ("batch", "CronJob") => Some(k("batch", "Job", "jobs")),
        _ => None,
    }
}

/// 자식 목록을 좁히는 레이블 셀렉터. matchLabels만 쓴다(matchExpressions는 빼서 넓게 받고 소유자 uid로 거른다).
pub fn selector_of(obj: &Value) -> Option<String> {
    let m = obj.pointer("/spec/selector/matchLabels").and_then(Value::as_object).filter(|m| !m.is_empty())?;
    Some(m.iter().map(|(k, v)| format!("{k}={}", v.as_str().unwrap_or(""))).collect::<Vec<_>>().join(","))
}

pub fn children_of(child: &KindRef, owner_uid: &str, items: &[DynamicObject]) -> Vec<Link> {
    let mut out: Vec<Link> = items
        .iter()
        .filter(|o| o.metadata.owner_references.iter().flatten().any(|r| r.uid == owner_uid))
        .map(|o| Link {
            group: child.group.clone(),
            version: child.version.clone(),
            kind: child.kind.clone(),
            name: o.metadata.name.clone().unwrap_or_default(),
            namespace: o.metadata.namespace.clone(),
            uid: o.metadata.uid.clone().unwrap_or_default(),
            controller: false,
            problems: row_of(child, o).problems,
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn state_of(status: Option<&Value>) -> (ContainerState, Option<String>, Option<String>) {
    let Some(st) = status.and_then(|s| s.get("state")) else { return (ContainerState::Unknown, None, None) };
    if st.get("running").is_some() {
        return (ContainerState::Running, None, None);
    }
    if let Some(w) = st.get("waiting") {
        return (ContainerState::Waiting, opt(w, "reason"), opt(w, "message"));
    }
    if let Some(t) = st.get("terminated") {
        return (ContainerState::Terminated, opt(t, "reason"), opt(t, "message"));
    }
    (ContainerState::Unknown, None, None)
}

fn termination(status: Option<&Value>) -> Option<Termination> {
    let t = status?.pointer("/lastState/terminated")?;
    Some(Termination { reason: opt(t, "reason"), exit_code: t["exitCode"].as_i64().unwrap_or(0), finished_at: opt(t, "finishedAt") })
}

fn pod_containers(d: &Value, spec_path: &str, status_path: &str, init: bool) -> Vec<Container> {
    let statuses = list(d, status_path);
    list(d, spec_path)
        .iter()
        .map(|c| {
            let status = statuses.iter().find(|s| s["name"] == c["name"]);
            let (state, reason, message) = state_of(status);
            Container {
                name: opt(c, "name").unwrap_or_default(),
                image: opt(c, "image").unwrap_or_default(),
                init,
                state,
                ready: status.and_then(|s| s["ready"].as_bool()).unwrap_or(false),
                restarts: status.and_then(|s| s["restartCount"].as_i64()).unwrap_or(0),
                reason,
                message,
                last_termination: termination(status),
            }
        })
        .collect()
}

/// Pod는 상태까지, 워크로드는 Pod 템플릿의 이름과 이미지만
pub fn containers_of(kind: &KindRef, d: &Value) -> Vec<Container> {
    if kind.group.is_empty() && kind.kind == "Pod" {
        let mut out = pod_containers(d, "/spec/initContainers", "/status/initContainerStatuses", true);
        out.extend(pod_containers(d, "/spec/containers", "/status/containerStatuses", false));
        return out;
    }
    let spec = match (kind.group.as_str(), kind.kind.as_str()) {
        ("apps", "Deployment" | "StatefulSet" | "DaemonSet" | "ReplicaSet") | ("batch", "Job") => "/spec/template/spec",
        ("batch", "CronJob") => "/spec/jobTemplate/spec/template/spec",
        _ => return vec![],
    };
    let template = |path: &str, init: bool| -> Vec<Container> {
        list(d, &format!("{spec}{path}"))
            .iter()
            .map(|c| Container {
                name: opt(c, "name").unwrap_or_default(),
                image: opt(c, "image").unwrap_or_default(),
                init,
                state: ContainerState::Template,
                ready: false,
                restarts: 0,
                reason: None,
                message: None,
                last_termination: None,
            })
            .collect()
    };
    let mut out = template("/initContainers", true);
    out.extend(template("/containers", false));
    out
}

pub fn conditions_of(d: &Value) -> Vec<Condition> {
    list(d, "/status/conditions")
        .iter()
        .map(|c| Condition {
            type_: opt(c, "type").unwrap_or_default(),
            status: opt(c, "status").unwrap_or_default(),
            reason: opt(c, "reason"),
            message: opt(c, "message"),
            last_transition: opt(c, "lastTransitionTime"),
        })
        .collect()
}

pub fn events_kind() -> KindRef {
    KindRef { group: String::new(), version: "v1".into(), kind: "Event".into(), plural: "events".into(), namespaced: true }
}

pub fn events_of(items: &[DynamicObject]) -> Vec<EventView> {
    let mut out: Vec<EventView> = items
        .iter()
        .map(|o| {
            let d = &o.data;
            EventView {
                type_: text(d, "/type").unwrap_or("Normal").to_string(),
                reason: text(d, "/reason").unwrap_or("").to_string(),
                message: text(d, "/message").unwrap_or("").to_string(),
                count: event_count(d),
                last_seen: event_last_seen(o),
                source: text(d, "/source/component").or_else(|| text(d, "/reportingComponent")).filter(|s| !s.is_empty()).map(str::to_string),
                object: event_object(d),
            }
        })
        .collect();
    out.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
    out.truncate(EVENTS_MAX);
    out
}

/// 객체 하나에서 만들 수 있는 것. 자식과 이벤트는 `get`이 따로 채운다.
pub fn view_of(kind: &KindRef, obj: &DynamicObject) -> Result<ObjectView, AppError> {
    let mut json = serde_json::to_value(obj).map_err(|_| AppError::other(YAML_FAILED))?;
    let secret_keys = is_secret(kind).then(|| keys(&json));
    if is_secret(kind) {
        mask(&mut json);
    }
    let annotations = json
        .pointer("/metadata/annotations")
        .and_then(Value::as_object)
        .map(|m| m.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect())
        .unwrap_or_default();
    Ok(ObjectView {
        kind: kind.clone(),
        row: row_of(kind, obj),
        annotations,
        owners: owners_of(obj),
        children: vec![],
        children_truncated: false,
        children_error: None,
        containers: containers_of(kind, &json),
        conditions: conditions_of(&json),
        events: vec![],
        events_error: None,
        yaml: view_yaml(kind, &json)?,
        secret_keys,
    })
}

async fn children(client: &Client, kind: &KindRef, obj: &DynamicObject, endpoint: Endpoint) -> Result<(Vec<Link>, bool), AppError> {
    let Some(child) = child_kind(kind) else { return Ok((vec![], false)) };
    let mut lp = ListParams::default().limit(CHILDREN_MAX);
    let selector = selector_of(&obj.data);
    if let Some(s) = &selector {
        lp = lp.labels(s);
    }
    let api = api_for(client.clone(), &child, obj.metadata.namespace.as_deref());
    let page = bounded(api.list(&lp), "list", &child.plural, endpoint).await?;
    let uid = obj.metadata.uid.clone().unwrap_or_default();
    let truncated = page.metadata.continue_.as_deref().is_some_and(|c| !c.is_empty());
    Ok((children_of(&child, &uid, &page.items), truncated))
}

async fn events(client: &Client, uid: &str, namespace: Option<&str>, endpoint: Endpoint) -> Result<Vec<EventView>, AppError> {
    let lp = ListParams::default().fields(&format!("involvedObject.uid={uid}")).limit(EVENTS_MAX as u32);
    let page = bounded(api_for(client.clone(), &events_kind(), namespace).list(&lp), "list", "events", endpoint).await?;
    Ok(events_of(&page.items))
}

/// 객체를 읽고(실패하면 명령도 실패), 자식과 이벤트를 함께 읽는다(실패는 각자 오류 칸에 둔다)
pub async fn get(client: &Client, kind: &KindRef, namespace: Option<&str>, name: &str, endpoint: Endpoint) -> Result<ObjectView, AppError> {
    let api = api_for(client.clone(), kind, namespace);
    let obj = bounded(api.get(name), "get", &kind.plural, endpoint).await?;
    let mut view = view_of(kind, &obj)?;
    let uid = view.row.uid.clone();
    let (kids, evs) = tokio::join!(children(client, kind, &obj, endpoint), events(client, &uid, obj.metadata.namespace.as_deref(), endpoint));
    match kids {
        Ok((links, truncated)) => {
            view.children = links;
            view.children_truncated = truncated;
        }
        Err(e) => view.children_error = Some(e),
    }
    match evs {
        Ok(e) => view.events = e,
        Err(e) => view.events_error = Some(e),
    }
    Ok(view)
}

#[cfg(test)]
mod tests;
```

In `src-tauri/src/k8s_commands.rs`, add `use crate::k8s::read::detail::{self, ObjectView};` and:

```rust
/// 상세 화면. 소유 관계, 컨테이너, 이벤트, YAML(Secret 값은 가림)을 한 번에 돌려준다.
#[tauri::command]
pub async fn k8s_get(k8s: State<'_, K8sState>, target: K8sTarget, kind: KindRef, namespace: Option<String>, name: String) -> Result<ObjectView, AppError> {
    let s = k8s.session(&target)?;
    detail::get(&s.client, &kind, namespace.as_deref(), &name, s.endpoint).await
}
```

In `src-tauri/src/lib.rs`, add `k8s_commands::k8s_get,` after `k8s_commands::k8s_kinds,`.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `cd src-tauri && cargo test --lib k8s && cargo clippy --all-targets -- -D warnings`
Expected: all pass, clippy clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/k8s/read.rs src-tauri/src/k8s/read/detail.rs src-tauri/src/k8s/read/detail/tests.rs src-tauri/src/k8s_commands.rs src-tauri/src/lib.rs
git commit -m "feat(k8s): object detail with ownership, containers, conditions, events and masked YAML

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task K2-B7: Overview pure parts: quantities, node views, version skew, removed-API table

**Files:**
- Create: `src-tauri/src/k8s/read/quantity.rs`, `src-tauri/src/k8s/read/quantity/tests.rs`, `src-tauri/src/k8s/read/nodes.rs`, `src-tauri/src/k8s/read/nodes/tests.rs`, `src-tauri/src/k8s/read/removed.rs`, `src-tauri/src/k8s/read/removed/tests.rs`
- Modify: `src-tauri/src/k8s/read.rs`

**Interfaces:**
- Consumes: `values::{list, text, condition, labels_of, node_group, GroupKind, INSTANCE_TYPE_LABEL, ZONE_LABEL}`, `secret::LAST_APPLIED`.
- Produces:
  - `quantity`: `pub fn cpu_milli(q: &str) -> Option<i64>` (rounded up), `pub fn bytes(q: &str) -> Option<i64>` (rounded up)
  - `nodes` (structs `#[derive(Debug, Clone, PartialEq, Serialize)] #[serde(rename_all = "camelCase")]`, `Resources` and `Usage` also `Copy, Default`):
    - `pub struct Resources { pub cpu_milli: i64, pub memory_bytes: i64, pub pods: i64 }`
    - `pub struct Usage { pub cpu_milli: i64, pub memory_bytes: i64 }`
    - `pub struct NodeView { pub name: String, pub ready: bool, pub unschedulable: bool, pub pressures: Vec<String>, pub instance_type: Option<String>, pub zone: Option<String>, pub group_kind: GroupKind, pub group: Option<String>, pub kubelet_version: String, pub allocatable: Resources, pub requested: Resources, pub usage: Option<Usage> }`
    - `pub struct Skew { pub node: String, pub kubelet_version: String, pub minors_behind: u32 }`
    - `pub const PRESSURES: [&str; 4] = ["MemoryPressure", "DiskPressure", "PIDPressure", "NetworkUnavailable"]`
    - `pub fn pod_requests(pod: &Value) -> Resources` (max(sum of containers, largest init container) + overhead; `pods: 1`)
    - `pub fn requests_by_node(pods: &[DynamicObject]) -> HashMap<String, Resources>` (skips pods without `spec.nodeName` and `Succeeded`/`Failed` pods)
    - `pub fn usage_of(metrics: &DynamicObject) -> (String, Usage)` (NodeMetrics `usage.cpu`, `usage.memory`)
    - `pub fn node_view(node: &DynamicObject, requested: Resources, usage: Option<Usage>) -> NodeView`
    - `pub fn minor(version: &str) -> Option<u32>` (`"1.33"`, `"v1.31.4-eks-1"` → 33, 31)
    - `pub fn skew(control_plane: &str, nodes: &[NodeView]) -> Vec<Skew>` (only nodes behind the control plane)
  - `removed`:
    - `pub struct Removed { pub removed_in: &'static str, pub api_version: &'static str, pub kind: &'static str, pub list_group: &'static str, pub list_version: &'static str, pub plural: &'static str, pub namespaced: bool, pub replacement: &'static str }`
    - `pub const REMOVED: &[Removed]`
    - `pub fn next_minor(version: &str) -> Option<String>` (`"1.31"` → `"1.32"`)
    - `pub fn due(cluster_version: &str) -> Vec<&'static Removed>` (entries removed in the next minor)
    - `pub fn uses(obj: &Value, api_version: &str) -> bool` (a `managedFields[].apiVersion` or the last-applied `apiVersion` equals it)
    - `#[derive(Debug, Clone, PartialEq, Serialize)] #[serde(rename_all = "camelCase")] pub struct RemovedUse { pub kind: String, pub api_version: String, pub replacement: String, pub removed_in: String, pub namespace: Option<String>, pub name: String }`
    - `pub fn uses_of(r: &Removed, items: &[DynamicObject]) -> Vec<RemovedUse>`

The table (`removed_in`, old `api_version`, `kind`, listed through `list_group/list_version/plural`, `namespaced`, `replacement`):

| removed_in | api_version | kind | list through | namespaced | replacement |
|---|---|---|---|---|---|
| 1.25 | batch/v1beta1 | CronJob | batch/v1 cronjobs | yes | batch/v1 |
| 1.25 | discovery.k8s.io/v1beta1 | EndpointSlice | discovery.k8s.io/v1 endpointslices | yes | discovery.k8s.io/v1 |
| 1.25 | autoscaling/v2beta1 | HorizontalPodAutoscaler | autoscaling/v2 horizontalpodautoscalers | yes | autoscaling/v2 |
| 1.25 | policy/v1beta1 | PodDisruptionBudget | policy/v1 poddisruptionbudgets | yes | policy/v1 |
| 1.25 | node.k8s.io/v1beta1 | RuntimeClass | node.k8s.io/v1 runtimeclasses | no | node.k8s.io/v1 |
| 1.26 | autoscaling/v2beta2 | HorizontalPodAutoscaler | autoscaling/v2 horizontalpodautoscalers | yes | autoscaling/v2 |
| 1.26 | flowcontrol.apiserver.k8s.io/v1beta1 | FlowSchema | flowcontrol.apiserver.k8s.io/v1beta2 flowschemas | no | flowcontrol.apiserver.k8s.io/v1beta3 |
| 1.26 | flowcontrol.apiserver.k8s.io/v1beta1 | PriorityLevelConfiguration | flowcontrol.apiserver.k8s.io/v1beta2 prioritylevelconfigurations | no | flowcontrol.apiserver.k8s.io/v1beta3 |
| 1.27 | storage.k8s.io/v1beta1 | CSIStorageCapacity | storage.k8s.io/v1 csistoragecapacities | yes | storage.k8s.io/v1 |
| 1.29 | flowcontrol.apiserver.k8s.io/v1beta2 | FlowSchema | flowcontrol.apiserver.k8s.io/v1beta3 flowschemas | no | flowcontrol.apiserver.k8s.io/v1 |
| 1.29 | flowcontrol.apiserver.k8s.io/v1beta2 | PriorityLevelConfiguration | flowcontrol.apiserver.k8s.io/v1beta3 prioritylevelconfigurations | no | flowcontrol.apiserver.k8s.io/v1 |
| 1.32 | flowcontrol.apiserver.k8s.io/v1beta3 | FlowSchema | flowcontrol.apiserver.k8s.io/v1 flowschemas | no | flowcontrol.apiserver.k8s.io/v1 |
| 1.32 | flowcontrol.apiserver.k8s.io/v1beta3 | PriorityLevelConfiguration | flowcontrol.apiserver.k8s.io/v1 prioritylevelconfigurations | no | flowcontrol.apiserver.k8s.io/v1 |

("list through" is a version the cluster one minor before `removed_in` serves, so the listing works on exactly the clusters the entry is due for.)

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/k8s/read/quantity/tests.rs`:

```rust
use super::*;

#[test]
fn cpu_in_millicores() {
    for (q, want) in [("100m", 100), ("2", 2000), ("0.5", 500), ("1500000n", 2), ("250u", 1), ("1.25", 1250)] {
        assert_eq!(cpu_milli(q), Some(want), "{q}");
    }
    assert_eq!(cpu_milli("x"), None);
    assert_eq!(cpu_milli(""), None);
}

#[test]
fn memory_in_bytes() {
    for (q, want) in [("128Mi", 134_217_728), ("1G", 1_000_000_000), ("1000k", 1_000_000), ("123", 123), ("1e3", 1000), ("1.5Gi", 1_610_612_736), ("2Ki", 2048)] {
        assert_eq!(bytes(q), Some(want), "{q}");
    }
    assert_eq!(bytes("Mi"), None);
}
```

Create `src-tauri/src/k8s/read/nodes/tests.rs`:

```rust
use serde_json::json;

use super::*;
use crate::k8s::read::values::GroupKind;

fn obj(v: serde_json::Value) -> DynamicObject {
    serde_json::from_value(v).unwrap()
}

#[test]
fn pod_requests_take_the_larger_of_containers_and_init_plus_overhead() {
    let pod = json!({ "spec": {
        "containers": [{ "resources": { "requests": { "cpu": "100m", "memory": "64Mi" } } }, { "resources": { "requests": { "cpu": "200m" } } }],
        "initContainers": [{ "resources": { "requests": { "cpu": "500m", "memory": "32Mi" } } }],
        "overhead": { "cpu": "10m", "memory": "1Mi" }
    } });
    assert_eq!(pod_requests(&pod), Resources { cpu_milli: 510, memory_bytes: 65 * 1024 * 1024, pods: 1 });
    assert_eq!(pod_requests(&json!({ "spec": { "containers": [{}] } })), Resources { cpu_milli: 0, memory_bytes: 0, pods: 1 });
}

#[test]
fn requests_are_summed_per_node_for_running_pods_only() {
    let pod = |node: Option<&str>, phase: &str| {
        let mut spec = json!({ "containers": [{ "resources": { "requests": { "cpu": "100m" } } }] });
        if let Some(n) = node {
            spec["nodeName"] = json!(n);
        }
        obj(json!({ "apiVersion": "v1", "kind": "Pod", "metadata": { "name": "p" }, "spec": spec, "status": { "phase": phase } }))
    };
    let pods = [pod(Some("a"), "Running"), pod(Some("a"), "Pending"), pod(Some("a"), "Succeeded"), pod(Some("b"), "Failed"), pod(None, "Pending")];
    let by = requests_by_node(&pods);
    assert_eq!(by.get("a"), Some(&Resources { cpu_milli: 200, memory_bytes: 0, pods: 2 }));
    assert_eq!(by.get("b"), None);
}

#[test]
fn node_view_reads_status_labels_and_allocatable() {
    let n = obj(json!({ "apiVersion": "v1", "kind": "Node",
        "metadata": { "name": "ip-1", "labels": { "node.kubernetes.io/instance-type": "m6i.large", "topology.kubernetes.io/zone": "ap-northeast-2a", "karpenter.sh/nodepool": "default" } },
        "spec": { "unschedulable": true },
        "status": {
            "conditions": [{ "type": "Ready", "status": "True" }, { "type": "MemoryPressure", "status": "True" }, { "type": "DiskPressure", "status": "False" }],
            "allocatable": { "cpu": "1930m", "memory": "7Gi", "pods": "29" },
            "nodeInfo": { "kubeletVersion": "v1.31.4-eks-1" }
        } }));
    let req = Resources { cpu_milli: 300, memory_bytes: 1, pods: 4 };
    let v = node_view(&n, req, Some(Usage { cpu_milli: 50, memory_bytes: 2 }));
    assert_eq!(v.name, "ip-1");
    assert!(v.ready && v.unschedulable);
    assert_eq!(v.pressures, ["MemoryPressure"]);
    assert_eq!((v.instance_type.as_deref(), v.zone.as_deref()), (Some("m6i.large"), Some("ap-northeast-2a")));
    assert_eq!((v.group_kind, v.group.as_deref()), (GroupKind::Karpenter, Some("default")));
    assert_eq!(v.allocatable, Resources { cpu_milli: 1930, memory_bytes: 7 * 1024 * 1024 * 1024, pods: 29 });
    assert_eq!(v.requested, req);
    assert_eq!(v.kubelet_version, "v1.31.4-eks-1");
}

#[test]
fn usage_from_node_metrics() {
    let m = obj(json!({ "apiVersion": "metrics.k8s.io/v1beta1", "kind": "NodeMetrics", "metadata": { "name": "ip-1" }, "usage": { "cpu": "250000000n", "memory": "1024Ki" } }));
    assert_eq!(usage_of(&m), ("ip-1".into(), Usage { cpu_milli: 250, memory_bytes: 1_048_576 }));
}

#[test]
fn minor_versions_and_skew() {
    assert_eq!(minor("1.33"), Some(33));
    assert_eq!(minor("v1.31.4-eks-1"), Some(31));
    assert_eq!(minor("x"), None);
    let node = |name: &str, v: &str| NodeView {
        name: name.into(), ready: true, unschedulable: false, pressures: vec![], instance_type: None, zone: None,
        group_kind: GroupKind::SelfManaged, group: None, kubelet_version: v.into(),
        allocatable: Resources::default(), requested: Resources::default(), usage: None,
    };
    let s = skew("1.33", &[node("a", "v1.33.1"), node("b", "v1.31.4-eks-1"), node("c", "bogus")]);
    assert_eq!(s, [Skew { node: "b".into(), kubelet_version: "v1.31.4-eks-1".into(), minors_behind: 2 }]);
}

#[test]
fn node_view_json_keys() {
    let n = obj(json!({ "apiVersion": "v1", "kind": "Node", "metadata": { "name": "n" }, "status": {} }));
    let v = serde_json::to_value(node_view(&n, Resources::default(), None)).unwrap();
    assert_eq!(v["groupKind"], json!("self"));
    assert_eq!(v["allocatable"], json!({ "cpuMilli": 0, "memoryBytes": 0, "pods": 0 }));
    assert_eq!(v["usage"], json!(null));
    assert_eq!(v["kubeletVersion"], json!(""));
}
```

Create `src-tauri/src/k8s/read/removed/tests.rs`:

```rust
use serde_json::json;

use super::*;

#[test]
fn next_minor_and_due_entries() {
    assert_eq!(next_minor("1.31"), Some("1.32".into()));
    assert_eq!(next_minor("v1.28.3-eks-1"), Some("1.29".into()));
    assert_eq!(next_minor("x"), None);
    let due31: Vec<&str> = due("1.31").iter().map(|r| r.kind).collect();
    assert_eq!(due31, ["FlowSchema", "PriorityLevelConfiguration"]);
    assert!(due("1.33").is_empty());
    assert_eq!(due("1.24").len(), 5);
}

#[test]
fn table_lists_through_a_newer_version_and_is_ordered() {
    for r in REMOVED {
        assert_ne!(format!("{}/{}", r.list_group, r.list_version), r.api_version, "{} {}", r.kind, r.removed_in);
    }
    assert!(REMOVED.windows(2).all(|w| minor(w[0].removed_in) <= minor(w[1].removed_in)));
}

fn minor(v: &str) -> u32 {
    v.split('.').nth(1).unwrap().parse().unwrap()
}

#[test]
fn uses_reads_managed_fields_and_last_applied() {
    let written_old = json!({ "metadata": { "managedFields": [{ "manager": "helm", "apiVersion": "flowcontrol.apiserver.k8s.io/v1beta3" }] } });
    assert!(uses(&written_old, "flowcontrol.apiserver.k8s.io/v1beta3"));
    let applied_old = json!({ "metadata": { "annotations": { "kubectl.kubernetes.io/last-applied-configuration": "{\"apiVersion\":\"batch/v1beta1\",\"kind\":\"CronJob\"}" } } });
    assert!(uses(&applied_old, "batch/v1beta1"));
    let new = json!({ "metadata": { "managedFields": [{ "apiVersion": "batch/v1" }], "annotations": { "kubectl.kubernetes.io/last-applied-configuration": "not json" } } });
    assert!(!uses(&new, "batch/v1beta1"));
}

#[test]
fn uses_of_builds_rows() {
    let r = &REMOVED[0];
    let o = |name: &str, api: &str| -> DynamicObject {
        serde_json::from_value(json!({ "apiVersion": "batch/v1", "kind": "CronJob", "metadata": { "name": name, "namespace": "ops", "managedFields": [{ "apiVersion": api }] } })).unwrap()
    };
    let got = uses_of(r, &[o("old", "batch/v1beta1"), o("new", "batch/v1")]);
    assert_eq!(
        got,
        [RemovedUse { kind: "CronJob".into(), api_version: "batch/v1beta1".into(), replacement: "batch/v1".into(), removed_in: "1.25".into(), namespace: Some("ops".into()), name: "old".into() }]
    );
}
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `cd src-tauri && cargo test --lib k8s::read`
Expected: compile errors (modules missing).

- [ ] **Step 3: Implement**

In `src-tauri/src/k8s/read.rs`, add `pub mod nodes;`, `pub mod quantity;`, `pub mod removed;` (keep the list alphabetical).

Create `src-tauri/src/k8s/read/quantity.rs`:

```rust
//! 쿠버네티스 수량 글(`100m`, `1.5Gi`, `2e3`)을 숫자로. CPU는 밀리코어, 메모리는 바이트, 둘 다 올림. 해석하지 못하면 None.

/// 접미사와 배수. 두 글자(이진)를 한 글자보다 먼저 본다.
const SUFFIXES: [(&str, f64); 15] = [
    ("Ki", 1024.0),
    ("Mi", 1_048_576.0),
    ("Gi", 1_073_741_824.0),
    ("Ti", 1_099_511_627_776.0),
    ("Pi", 1_125_899_906_842_624.0),
    ("Ei", 1_152_921_504_606_846_976.0),
    ("n", 1e-9),
    ("u", 1e-6),
    ("m", 1e-3),
    ("k", 1e3),
    ("M", 1e6),
    ("G", 1e9),
    ("T", 1e12),
    ("P", 1e15),
    ("E", 1e18),
];

fn amount(q: &str) -> Option<f64> {
    let q = q.trim();
    let number = |n: &str| n.parse::<f64>().ok().filter(|v| v.is_finite());
    for (suffix, factor) in SUFFIXES {
        if let Some(n) = q.strip_suffix(suffix) {
            return number(n).map(|v| v * factor);
        }
    }
    number(q)
}

pub fn cpu_milli(q: &str) -> Option<i64> {
    amount(q).map(|v| (v * 1000.0 - 1e-9).ceil() as i64)
}

pub fn bytes(q: &str) -> Option<i64> {
    amount(q).map(|v| (v - 1e-9).ceil() as i64)
}

#[cfg(test)]
mod tests;
```

(The `- 1e-9` keeps exact values like `0.5` → 500 from rounding up through floating-point noise; `1500000n` is 1.5 m and still rounds up to 2.)

Create `src-tauri/src/k8s/read/nodes.rs`:

```rust
//! 개요의 노드: 상태, 묶음, 할당 가능량 대비 요청량, metrics-server 사용량, 컨트롤 플레인과의 버전 차이.
use std::collections::HashMap;

use kube::api::DynamicObject;
use serde::Serialize;
use serde_json::Value;

use super::quantity::{bytes, cpu_milli};
use super::values::{condition, labels_of, list, node_group, text, GroupKind, INSTANCE_TYPE_LABEL, ZONE_LABEL};

pub const PRESSURES: [&str; 4] = ["MemoryPressure", "DiskPressure", "PIDPressure", "NetworkUnavailable"];

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resources {
    pub cpu_milli: i64,
    pub memory_bytes: i64,
    pub pods: i64,
}

impl Resources {
    fn add(&mut self, o: Resources) {
        self.cpu_milli += o.cpu_milli;
        self.memory_bytes += o.memory_bytes;
        self.pods += o.pods;
    }

    fn max(self, o: Resources) -> Resources {
        Resources { cpu_milli: self.cpu_milli.max(o.cpu_milli), memory_bytes: self.memory_bytes.max(o.memory_bytes), pods: self.pods.max(o.pods) }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub cpu_milli: i64,
    pub memory_bytes: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeView {
    pub name: String,
    pub ready: bool,
    pub unschedulable: bool,
    pub pressures: Vec<String>,
    pub instance_type: Option<String>,
    pub zone: Option<String>,
    pub group_kind: GroupKind,
    pub group: Option<String>,
    pub kubelet_version: String,
    pub allocatable: Resources,
    pub requested: Resources,
    pub usage: Option<Usage>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skew {
    pub node: String,
    pub kubelet_version: String,
    pub minors_behind: u32,
}

fn resources_at(d: &Value, path: &str) -> Resources {
    let at = |k: &str| d.pointer(&format!("{path}/{k}")).and_then(Value::as_str);
    Resources {
        cpu_milli: at("cpu").and_then(cpu_milli).unwrap_or(0),
        memory_bytes: at("memory").and_then(bytes).unwrap_or(0),
        pods: at("pods").and_then(|p| p.parse().ok()).unwrap_or(0),
    }
}

/// kubectl describe node와 같은 셈: max(컨테이너 합, 가장 큰 init 컨테이너) + overhead
pub fn pod_requests(pod: &Value) -> Resources {
    let mut sum = Resources::default();
    for c in list(pod, "/spec/containers") {
        sum.add(resources_at(c, "/resources/requests"));
    }
    let init = list(pod, "/spec/initContainers").iter().map(|c| resources_at(c, "/resources/requests")).fold(Resources::default(), Resources::max);
    let mut total = sum.max(init);
    total.add(resources_at(pod, "/spec/overhead"));
    total.pods = 1;
    total
}

pub fn requests_by_node(pods: &[DynamicObject]) -> HashMap<String, Resources> {
    let mut out: HashMap<String, Resources> = HashMap::new();
    for p in pods {
        let d = &p.data;
        if matches!(text(d, "/status/phase"), Some("Succeeded" | "Failed")) {
            continue;
        }
        let Some(node) = text(d, "/spec/nodeName") else { continue };
        out.entry(node.to_string()).or_default().add(pod_requests(d));
    }
    out
}

pub fn usage_of(metrics: &DynamicObject) -> (String, Usage) {
    let d = &metrics.data;
    let usage = Usage { cpu_milli: text(d, "/usage/cpu").and_then(cpu_milli).unwrap_or(0), memory_bytes: text(d, "/usage/memory").and_then(bytes).unwrap_or(0) };
    (metrics.metadata.name.clone().unwrap_or_default(), usage)
}

pub fn node_view(node: &DynamicObject, requested: Resources, usage: Option<Usage>) -> NodeView {
    let d = &node.data;
    let labels = labels_of(node);
    let (group_kind, group) = node_group(&labels);
    NodeView {
        name: node.metadata.name.clone().unwrap_or_default(),
        ready: condition(d, "Ready") == Some("True"),
        unschedulable: d.pointer("/spec/unschedulable") == Some(&Value::Bool(true)),
        pressures: PRESSURES.iter().filter(|p| condition(d, p) == Some("True")).map(|p| p.to_string()).collect(),
        instance_type: labels.get(INSTANCE_TYPE_LABEL).cloned(),
        zone: labels.get(ZONE_LABEL).cloned(),
        group_kind,
        group,
        kubelet_version: text(d, "/status/nodeInfo/kubeletVersion").unwrap_or("").to_string(),
        allocatable: resources_at(d, "/status/allocatable"),
        requested,
        usage,
    }
}

pub fn minor(version: &str) -> Option<u32> {
    version.trim_start_matches('v').split('.').nth(1)?.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()
}

pub fn skew(control_plane: &str, nodes: &[NodeView]) -> Vec<Skew> {
    let Some(cp) = minor(control_plane) else { return vec![] };
    nodes
        .iter()
        .filter_map(|n| {
            let m = minor(&n.kubelet_version)?;
            (m < cp).then(|| Skew { node: n.name.clone(), kubelet_version: n.kubelet_version.clone(), minors_behind: cp - m })
        })
        .collect()
}

#[cfg(test)]
mod tests;
```

Create `src-tauri/src/k8s/read/removed.rs`:

```rust
//! 다음 마이너 버전에서 제거되는 API를 쓰는 리소스. 고정 표에서 그 버전에 해당하는 것만 본다.
//! 객체 목록은 서버가 어느 버전으로든 같은 객체를 돌려주므로, 옛 API로 썼는지는 managedFields와 last-applied의 apiVersion으로 가린다.
//! 표는 쿠버네티스가 새 제거를 알리면 더한다. PodSecurityPolicy(1.25)는 옮겨 갈 종류가 없고 EKS 1.24는 지원이 끝나 넣지 않았다.
use kube::api::DynamicObject;
use serde::Serialize;
use serde_json::Value;

use super::secret::LAST_APPLIED;
use super::values::list;

#[derive(Debug, PartialEq)]
pub struct Removed {
    pub removed_in: &'static str,
    pub api_version: &'static str,
    pub kind: &'static str,
    /// 목록을 읽을 그룹·버전(제거 한 버전 전의 클러스터가 내주는 것)
    pub list_group: &'static str,
    pub list_version: &'static str,
    pub plural: &'static str,
    pub namespaced: bool,
    pub replacement: &'static str,
}

const fn r(
    removed_in: &'static str,
    api_version: &'static str,
    kind: &'static str,
    list_group: &'static str,
    list_version: &'static str,
    plural: &'static str,
    namespaced: bool,
    replacement: &'static str,
) -> Removed {
    Removed { removed_in, api_version, kind, list_group, list_version, plural, namespaced, replacement }
}

const FC: &str = "flowcontrol.apiserver.k8s.io";

pub const REMOVED: &[Removed] = &[
    r("1.25", "batch/v1beta1", "CronJob", "batch", "v1", "cronjobs", true, "batch/v1"),
    r("1.25", "discovery.k8s.io/v1beta1", "EndpointSlice", "discovery.k8s.io", "v1", "endpointslices", true, "discovery.k8s.io/v1"),
    r("1.25", "autoscaling/v2beta1", "HorizontalPodAutoscaler", "autoscaling", "v2", "horizontalpodautoscalers", true, "autoscaling/v2"),
    r("1.25", "policy/v1beta1", "PodDisruptionBudget", "policy", "v1", "poddisruptionbudgets", true, "policy/v1"),
    r("1.25", "node.k8s.io/v1beta1", "RuntimeClass", "node.k8s.io", "v1", "runtimeclasses", false, "node.k8s.io/v1"),
    r("1.26", "autoscaling/v2beta2", "HorizontalPodAutoscaler", "autoscaling", "v2", "horizontalpodautoscalers", true, "autoscaling/v2"),
    r("1.26", "flowcontrol.apiserver.k8s.io/v1beta1", "FlowSchema", FC, "v1beta2", "flowschemas", false, "flowcontrol.apiserver.k8s.io/v1beta3"),
    r("1.26", "flowcontrol.apiserver.k8s.io/v1beta1", "PriorityLevelConfiguration", FC, "v1beta2", "prioritylevelconfigurations", false, "flowcontrol.apiserver.k8s.io/v1beta3"),
    r("1.27", "storage.k8s.io/v1beta1", "CSIStorageCapacity", "storage.k8s.io", "v1", "csistoragecapacities", true, "storage.k8s.io/v1"),
    r("1.29", "flowcontrol.apiserver.k8s.io/v1beta2", "FlowSchema", FC, "v1beta3", "flowschemas", false, "flowcontrol.apiserver.k8s.io/v1"),
    r("1.29", "flowcontrol.apiserver.k8s.io/v1beta2", "PriorityLevelConfiguration", FC, "v1beta3", "prioritylevelconfigurations", false, "flowcontrol.apiserver.k8s.io/v1"),
    r("1.32", "flowcontrol.apiserver.k8s.io/v1beta3", "FlowSchema", FC, "v1", "flowschemas", false, "flowcontrol.apiserver.k8s.io/v1"),
    r("1.32", "flowcontrol.apiserver.k8s.io/v1beta3", "PriorityLevelConfiguration", FC, "v1", "prioritylevelconfigurations", false, "flowcontrol.apiserver.k8s.io/v1"),
];

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovedUse {
    pub kind: String,
    pub api_version: String,
    pub replacement: String,
    pub removed_in: String,
    pub namespace: Option<String>,
    pub name: String,
}

pub fn next_minor(version: &str) -> Option<String> {
    let mut parts = version.trim_start_matches('v').split('.');
    let major: u32 = parts.next()?.parse().ok()?;
    let minor: u32 = parts.next()?.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()?;
    Some(format!("{major}.{}", minor + 1))
}

pub fn due(cluster_version: &str) -> Vec<&'static Removed> {
    let Some(next) = next_minor(cluster_version) else { return vec![] };
    REMOVED.iter().filter(|r| r.removed_in == next).collect()
}

pub fn uses(obj: &Value, api_version: &str) -> bool {
    let managed = list(obj, "/metadata/managedFields").iter().any(|f| f["apiVersion"] == api_version);
    let applied = || {
        obj.pointer("/metadata/annotations")
            .and_then(|a| a.get(LAST_APPLIED))
            .and_then(Value::as_str)
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .is_some_and(|a| a["apiVersion"] == api_version)
    };
    managed || applied()
}

pub fn uses_of(r: &Removed, items: &[DynamicObject]) -> Vec<RemovedUse> {
    items
        .iter()
        .filter(|o| serde_json::to_value(o).is_ok_and(|v| uses(&v, r.api_version)))
        .map(|o| RemovedUse {
            kind: r.kind.into(),
            api_version: r.api_version.into(),
            replacement: r.replacement.into(),
            removed_in: r.removed_in.into(),
            namespace: o.metadata.namespace.clone(),
            name: o.metadata.name.clone().unwrap_or_default(),
        })
        .collect()
}

#[cfg(test)]
mod tests;
```

(`clippy::too_many_arguments` may flag `r`; add `#[allow(clippy::too_many_arguments)]` on it, since it only builds table rows.)

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `cd src-tauri && cargo test --lib k8s::read && cargo clippy --all-targets -- -D warnings`
Expected: all pass, clippy clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/k8s/read.rs src-tauri/src/k8s/read/quantity.rs src-tauri/src/k8s/read/quantity src-tauri/src/k8s/read/nodes.rs src-tauri/src/k8s/read/nodes src-tauri/src/k8s/read/removed.rs src-tauri/src/k8s/read/removed
git commit -m "feat(k8s): overview building blocks for quantities, node views, version skew and removed APIs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task K2-B8: Overview EKS calls (cluster, node groups, Fargate, add-ons, Upgrade Insights)

**Files:**
- Create: `src-tauri/src/k8s/read/eks.rs`, `src-tauri/src/k8s/read/eks/tests.rs`
- Modify: `src-tauri/src/k8s/read.rs`

**Interfaces:**
- Consumes: `crate::error::{from_sdk, AppError}`, `connect::REQUEST_TIMEOUT`, `target::not_found`.
- Produces (structs `#[derive(Debug, Clone, PartialEq, Serialize)] #[serde(rename_all = "camelCase")]`):
  - `pub struct ClusterView { pub version: String, pub platform_version: Option<String>, pub status: Option<String>, pub endpoint_public: bool, pub endpoint_private: bool, pub public_cidrs: Vec<String>, pub logging: Vec<String>, pub secrets_encrypted: bool, pub oidc_issuer: Option<String>, pub authentication_mode: Option<String> }`
  - `pub struct NodegroupView { pub name: String, pub status: Option<String>, pub version: Option<String>, pub instance_types: Vec<String>, pub capacity_type: Option<String>, pub min: Option<i32>, pub max: Option<i32>, pub desired: Option<i32> }`
  - `pub struct AddonView { pub name: String, pub version: Option<String>, pub latest: Option<String>, pub status: Option<String>, pub issues: Vec<String> }` (issue text `"${code}: ${message}"`)
  - `pub struct InsightView { pub name: String, pub category: Option<String>, pub status: Option<String>, pub reason: Option<String>, pub description: Option<String>, pub kubernetes_version: Option<String> }`
  - `pub fn eks_timeout(action: &str) -> String`, `pub const PAGES_MAX: usize = 20`
  - `pub async fn call<T, E, R>(fut: impl Future<Output = Result<T, SdkError<E, R>>>, action: &str) -> Result<T, AppError>` (same bounds as `from_sdk`)
  - pure: `pub fn cluster_view(c: &Cluster) -> ClusterView`, `pub fn nodegroup_view(n: &Nodegroup) -> NodegroupView`, `pub fn addon_view(a: &Addon, latest: Option<String>) -> AddonView`, `pub fn insight_view(i: &InsightSummary) -> InsightView`, `pub fn latest_version<'a>(versions: impl Iterator<Item = &'a str>) -> Option<String>`
  - async (each request through `call`, lists at most `PAGES_MAX` pages): `pub async fn describe(eks: &Eks, cluster: &str) -> Result<ClusterView, AppError>`, `pub async fn nodegroups(eks: &Eks, cluster: &str) -> Result<Vec<NodegroupView>, AppError>`, `pub async fn fargate_profiles(eks: &Eks, cluster: &str) -> Result<Vec<String>, AppError>`, `pub async fn addons(eks: &Eks, cluster: &str, version: Option<&str>) -> Result<Vec<AddonView>, AppError>` (a failing `DescribeAddonVersions` leaves `latest: None`), `pub async fn insights(eks: &Eks, cluster: &str) -> Result<Vec<InsightView>, AppError>` — `Eks` is `aws_sdk_eks::Client`.

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/k8s/read/eks/tests.rs`:

```rust
use aws_sdk_eks::operation::describe_cluster::DescribeClusterError;
use aws_sdk_eks::types::{
    AccessConfigResponse, AddonHealth, AddonIssue, AddonIssueCode, AddonStatus, AuthenticationMode, CapacityTypes, Category, ClusterStatus, EncryptionConfig, Identity,
    InsightStatus, InsightStatusValue, LogSetup, LogType, Logging, NodegroupScalingConfig, NodegroupStatus, Oidc, VpcConfigResponse,
};
use aws_smithy_runtime_api::client::orchestrator::HttpResponse;

use super::*;

#[test]
fn cluster_view_reads_access_logging_encryption_oidc_and_auth_mode() {
    let c = Cluster::builder()
        .version("1.31")
        .platform_version("eks.12")
        .status(ClusterStatus::Active)
        .resources_vpc_config(VpcConfigResponse::builder().endpoint_public_access(true).endpoint_private_access(false).public_access_cidrs("0.0.0.0/0").build())
        .logging(
            Logging::builder()
                .cluster_logging(LogSetup::builder().types(LogType::Api).types(LogType::Audit).enabled(true).build())
                .cluster_logging(LogSetup::builder().types(LogType::Scheduler).enabled(false).build())
                .build(),
        )
        .encryption_config(EncryptionConfig::builder().resources("secrets").build())
        .identity(Identity::builder().oidc(Oidc::builder().issuer("https://oidc.eks.ap-northeast-2.amazonaws.com/id/ABC").build()).build())
        .access_config(AccessConfigResponse::builder().authentication_mode(AuthenticationMode::ApiAndConfigMap).build())
        .build();
    assert_eq!(
        cluster_view(&c),
        ClusterView {
            version: "1.31".into(),
            platform_version: Some("eks.12".into()),
            status: Some("ACTIVE".into()),
            endpoint_public: true,
            endpoint_private: false,
            public_cidrs: vec!["0.0.0.0/0".into()],
            logging: vec!["api".into(), "audit".into()],
            secrets_encrypted: true,
            oidc_issuer: Some("https://oidc.eks.ap-northeast-2.amazonaws.com/id/ABC".into()),
            authentication_mode: Some("API_AND_CONFIG_MAP".into()),
        }
    );
    let bare = cluster_view(&Cluster::builder().build());
    assert!(!bare.secrets_encrypted && bare.logging.is_empty() && bare.oidc_issuer.is_none());
}

#[test]
fn nodegroup_addon_and_insight_views() {
    let n = Nodegroup::builder()
        .nodegroup_name("ng-1")
        .status(NodegroupStatus::Active)
        .version("1.30")
        .instance_types("m6i.large")
        .capacity_type(CapacityTypes::OnDemand)
        .scaling_config(NodegroupScalingConfig::builder().min_size(1).max_size(3).desired_size(2).build())
        .build();
    assert_eq!(
        nodegroup_view(&n),
        NodegroupView { name: "ng-1".into(), status: Some("ACTIVE".into()), version: Some("1.30".into()), instance_types: vec!["m6i.large".into()], capacity_type: Some("ON_DEMAND".into()), min: Some(1), max: Some(3), desired: Some(2) }
    );
    let a = Addon::builder()
        .addon_name("coredns")
        .addon_version("v1.11.1-eksbuild.4")
        .status(AddonStatus::Degraded)
        .health(AddonHealth::builder().issues(AddonIssue::builder().code(AddonIssueCode::InsufficientNumberOfReplicas).message("1 of 2 ready").build()).build())
        .build();
    assert_eq!(
        addon_view(&a, Some("v1.11.3-eksbuild.1".into())),
        AddonView { name: "coredns".into(), version: Some("v1.11.1-eksbuild.4".into()), latest: Some("v1.11.3-eksbuild.1".into()), status: Some("DEGRADED".into()), issues: vec!["InsufficientNumberOfReplicas: 1 of 2 ready".into()] }
    );
    let i = InsightSummary::builder()
        .name("Deprecated APIs removed in Kubernetes v1.32")
        .category(Category::UpgradeReadiness)
        .kubernetes_version("1.32")
        .insight_status(InsightStatus::builder().status(InsightStatusValue::Warning).reason("Deprecated API usage detected").build())
        .description("Checks for usage of deprecated APIs")
        .build();
    let v = insight_view(&i);
    assert_eq!((v.category.as_deref(), v.status.as_deref(), v.reason.as_deref(), v.kubernetes_version.as_deref()), (Some("UPGRADE_READINESS"), Some("WARNING"), Some("Deprecated API usage detected"), Some("1.32")));
}

#[test]
fn latest_version_compares_numbers_not_text() {
    let v = ["v1.9.0-eksbuild.3", "v1.10.0-eksbuild.1", "v1.10.0-eksbuild.2", "v1.2.0-eksbuild.9"];
    assert_eq!(latest_version(v.into_iter()), Some("v1.10.0-eksbuild.2".into()));
    assert_eq!(latest_version(std::iter::empty()), None);
}

#[tokio::test(start_paused = true)]
async fn calls_time_out_after_30_seconds() {
    let never = std::future::pending::<Result<(), SdkError<DescribeClusterError, HttpResponse>>>();
    assert_eq!(call(never, "eks:DescribeCluster").await, Err(AppError::Network { message: eks_timeout("eks:DescribeCluster") }));
    assert_eq!(eks_timeout("eks:ListInsights"), "EKS API가 30초 안에 답하지 않았어요(eks:ListInsights)");
}
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `cd src-tauri && cargo test --lib k8s::read::eks`
Expected: compile error (`eks` module missing).

- [ ] **Step 3: Implement**

In `src-tauri/src/k8s/read.rs`, add `pub mod eks;` (alphabetical).

Create `src-tauri/src/k8s/read/eks.rs`:

```rust
//! 개요의 EKS 쪽: 클러스터 설정, 노드그룹, Fargate 프로필, 애드온(현재·최신 버전), Upgrade Insights. 읽기(Describe/List)만 한다.
//! 모든 호출은 `REQUEST_TIMEOUT` 안에 끝나야 하고, 목록은 `PAGES_MAX` 쪽까지만 넘긴다.
use std::future::Future;

use aws_sdk_eks::error::{ProvideErrorMetadata, SdkError};
use aws_sdk_eks::types::{Addon, Cluster, InsightSummary, Nodegroup};
use aws_sdk_eks::Client as Eks;
use serde::Serialize;

use crate::error::{from_sdk, AppError};
use crate::k8s::connect::REQUEST_TIMEOUT;
use crate::k8s::target::not_found;

pub const PAGES_MAX: usize = 20;

pub fn eks_timeout(action: &str) -> String {
    format!("EKS API가 30초 안에 답하지 않았어요({action})")
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterView {
    pub version: String,
    pub platform_version: Option<String>,
    pub status: Option<String>,
    pub endpoint_public: bool,
    pub endpoint_private: bool,
    pub public_cidrs: Vec<String>,
    pub logging: Vec<String>,
    pub secrets_encrypted: bool,
    pub oidc_issuer: Option<String>,
    pub authentication_mode: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodegroupView {
    pub name: String,
    pub status: Option<String>,
    pub version: Option<String>,
    pub instance_types: Vec<String>,
    pub capacity_type: Option<String>,
    pub min: Option<i32>,
    pub max: Option<i32>,
    pub desired: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddonView {
    pub name: String,
    pub version: Option<String>,
    pub latest: Option<String>,
    pub status: Option<String>,
    pub issues: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InsightView {
    pub name: String,
    pub category: Option<String>,
    pub status: Option<String>,
    pub reason: Option<String>,
    pub description: Option<String>,
    pub kubernetes_version: Option<String>,
}

pub async fn call<T, E, R>(fut: impl Future<Output = Result<T, SdkError<E, R>>>, action: &str) -> Result<T, AppError>
where
    E: ProvideErrorMetadata + std::error::Error + Send + Sync + 'static,
    R: std::fmt::Debug + Send + Sync + 'static,
{
    match tokio::time::timeout(REQUEST_TIMEOUT, fut).await {
        Err(_) => Err(AppError::Network { message: eks_timeout(action) }),
        Ok(r) => r.map_err(|e| from_sdk(e, action)),
    }
}

pub fn cluster_view(c: &Cluster) -> ClusterView {
    let vpc = c.resources_vpc_config();
    ClusterView {
        version: c.version().unwrap_or_default().to_string(),
        platform_version: c.platform_version().map(str::to_string),
        status: c.status().map(|s| s.as_str().to_string()),
        endpoint_public: vpc.is_some_and(|v| v.endpoint_public_access()),
        endpoint_private: vpc.is_some_and(|v| v.endpoint_private_access()),
        public_cidrs: vpc.map(|v| v.public_access_cidrs().to_vec()).unwrap_or_default(),
        logging: c
            .logging()
            .map(|l| l.cluster_logging().iter().filter(|s| s.enabled() == Some(true)).flat_map(|s| s.types().iter().map(|t| t.as_str().to_string())).collect())
            .unwrap_or_default(),
        secrets_encrypted: c.encryption_config().iter().any(|e| e.resources().iter().any(|r| r == "secrets")),
        oidc_issuer: c.identity().and_then(|i| i.oidc()).and_then(|o| o.issuer()).map(str::to_string),
        authentication_mode: c.access_config().and_then(|a| a.authentication_mode()).map(|m| m.as_str().to_string()),
    }
}

pub fn nodegroup_view(n: &Nodegroup) -> NodegroupView {
    let scaling = n.scaling_config();
    NodegroupView {
        name: n.nodegroup_name().unwrap_or_default().to_string(),
        status: n.status().map(|s| s.as_str().to_string()),
        version: n.version().map(str::to_string),
        instance_types: n.instance_types().to_vec(),
        capacity_type: n.capacity_type().map(|c| c.as_str().to_string()),
        min: scaling.and_then(|s| s.min_size()),
        max: scaling.and_then(|s| s.max_size()),
        desired: scaling.and_then(|s| s.desired_size()),
    }
}

pub fn addon_view(a: &Addon, latest: Option<String>) -> AddonView {
    AddonView {
        name: a.addon_name().unwrap_or_default().to_string(),
        version: a.addon_version().map(str::to_string),
        latest,
        status: a.status().map(|s| s.as_str().to_string()),
        issues: a
            .health()
            .map(|h| h.issues().iter().map(|i| format!("{}: {}", i.code().map_or("", |c| c.as_str()), i.message().unwrap_or(""))).collect())
            .unwrap_or_default(),
    }
}

pub fn insight_view(i: &InsightSummary) -> InsightView {
    let status = i.insight_status();
    InsightView {
        name: i.name().unwrap_or_default().to_string(),
        category: i.category().map(|c| c.as_str().to_string()),
        status: status.and_then(|s| s.status()).map(|s| s.as_str().to_string()),
        reason: status.and_then(|s| s.reason()).map(str::to_string),
        description: i.description().map(str::to_string),
        kubernetes_version: i.kubernetes_version().map(str::to_string),
    }
}

fn numbers(v: &str) -> Vec<u64> {
    v.split(|c: char| !c.is_ascii_digit()).filter(|s| !s.is_empty()).filter_map(|s| s.parse().ok()).collect()
}

/// `v1.10.0-eksbuild.2` 같은 버전에서 숫자만 차례로 비교해 가장 큰 것
pub fn latest_version<'a>(versions: impl Iterator<Item = &'a str>) -> Option<String> {
    versions.max_by(|a, b| numbers(a).cmp(&numbers(b))).map(str::to_string)
}

pub async fn describe(eks: &Eks, cluster: &str) -> Result<ClusterView, AppError> {
    let out = call(eks.describe_cluster().name(cluster).send(), "eks:DescribeCluster").await?;
    out.cluster().map(cluster_view).ok_or_else(|| AppError::other(not_found(cluster)))
}

pub async fn nodegroups(eks: &Eks, cluster: &str) -> Result<Vec<NodegroupView>, AppError> {
    let mut names = Vec::new();
    let mut token: Option<String> = None;
    for _ in 0..PAGES_MAX {
        let out = call(eks.list_nodegroups().cluster_name(cluster).set_next_token(token.take()).send(), "eks:ListNodegroups").await?;
        names.extend(out.nodegroups().iter().cloned());
        token = out.next_token().map(str::to_string);
        if token.is_none() {
            break;
        }
    }
    let views = futures::future::try_join_all(names.iter().map(|n| async move {
        let out = call(eks.describe_nodegroup().cluster_name(cluster).nodegroup_name(n).send(), "eks:DescribeNodegroup").await?;
        Ok::<_, AppError>(out.nodegroup().map(nodegroup_view))
    }))
    .await?;
    Ok(views.into_iter().flatten().collect())
}

pub async fn fargate_profiles(eks: &Eks, cluster: &str) -> Result<Vec<String>, AppError> {
    let mut names = Vec::new();
    let mut token: Option<String> = None;
    for _ in 0..PAGES_MAX {
        let out = call(eks.list_fargate_profiles().cluster_name(cluster).set_next_token(token.take()).send(), "eks:ListFargateProfiles").await?;
        names.extend(out.fargate_profile_names().iter().cloned());
        token = out.next_token().map(str::to_string);
        if token.is_none() {
            break;
        }
    }
    Ok(names)
}

/// 이 클러스터 버전에서 쓸 수 있는 가장 새 버전. 읽지 못하면 None(애드온 목록은 그대로 보인다).
async fn latest_for(eks: &Eks, addon: &str, version: &str) -> Option<String> {
    let out = call(eks.describe_addon_versions().addon_name(addon).kubernetes_version(version).send(), "eks:DescribeAddonVersions").await.ok()?;
    latest_version(out.addons().iter().flat_map(|a| a.addon_versions()).filter_map(|v| v.addon_version()))
}

pub async fn addons(eks: &Eks, cluster: &str, version: Option<&str>) -> Result<Vec<AddonView>, AppError> {
    let mut names = Vec::new();
    let mut token: Option<String> = None;
    for _ in 0..PAGES_MAX {
        let out = call(eks.list_addons().cluster_name(cluster).set_next_token(token.take()).send(), "eks:ListAddons").await?;
        names.extend(out.addons().iter().cloned());
        token = out.next_token().map(str::to_string);
        if token.is_none() {
            break;
        }
    }
    let views = futures::future::try_join_all(names.iter().map(|n| async move {
        let out = call(eks.describe_addon().cluster_name(cluster).addon_name(n).send(), "eks:DescribeAddon").await?;
        let latest = match version {
            Some(v) => latest_for(eks, n, v).await,
            None => None,
        };
        Ok::<_, AppError>(out.addon().map(|a| addon_view(a, latest)))
    }))
    .await?;
    Ok(views.into_iter().flatten().collect())
}

pub async fn insights(eks: &Eks, cluster: &str) -> Result<Vec<InsightView>, AppError> {
    let mut out_views = Vec::new();
    let mut token: Option<String> = None;
    for _ in 0..PAGES_MAX {
        let out = call(eks.list_insights().cluster_name(cluster).set_next_token(token.take()).send(), "eks:ListInsights").await?;
        out_views.extend(out.insights().iter().map(insight_view));
        token = out.next_token().map(str::to_string);
        if token.is_none() {
            break;
        }
    }
    Ok(out_views)
}

#[cfg(test)]
mod tests;
```

If a builder in the test is fallible in aws-sdk-eks 1.157 (returns `Result`), add `.unwrap()` to that builder call; do not change the assertions.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `cd src-tauri && cargo test --lib k8s::read::eks && cargo clippy --all-targets -- -D warnings`
Expected: all pass, clippy clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/k8s/read.rs src-tauri/src/k8s/read/eks.rs src-tauri/src/k8s/read/eks/tests.rs
git commit -m "feat(k8s): overview EKS reads for cluster settings, node groups, Fargate, add-ons and insights

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task K2-B9: Overview assembly with gaps, paged lists, `k8s_overview`

**Files:**
- Create: `src-tauri/src/k8s/read/overview.rs`, `src-tauri/src/k8s/read/overview/tests.rs`
- Modify: `src-tauri/src/k8s/read.rs`, `src-tauri/src/k8s_commands.rs`, `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: Tasks K2-B4 (`bounded`, `kinds::discover`), K2-B7 (`nodes::*`, `removed::*`), K2-B8 (`eks::*`), K1 `AppState`, `K8sState::session`, `watch::PAGE_SIZE`.
- Produces:
  - `pub async fn read::list_all(api: &Api<DynamicObject>, lp: &ListParams, max_pages: usize, resource: &str, endpoint: Endpoint) -> Result<(Vec<DynamicObject>, bool), AppError>` (pages of `PAGE_SIZE`; `true` when it stopped at the cap)
  - `#[derive(Debug, Clone, Copy, PartialEq, Serialize)] #[serde(rename_all = "camelCase")] pub enum overview::Section { Cluster, Nodes, Metrics, Nodegroups, Fargate, NodePools, Addons, Insights, RemovedApis }`
  - `#[derive(Debug, Clone, PartialEq, Serialize)] #[serde(rename_all = "camelCase")] pub struct Gap { pub section: Section, pub error: AppError }`
  - `#[derive(Debug, Clone, PartialEq, Serialize)] #[serde(rename_all = "camelCase")] pub struct Overview { pub cluster: Option<ClusterView>, pub nodes: Option<Vec<NodeView>>, pub requests_partial: bool, pub metrics: bool, pub nodegroups: Option<Vec<NodegroupView>>, pub fargate_profiles: Option<Vec<String>>, pub node_pools: Option<Vec<String>>, pub addons: Option<Vec<AddonView>>, pub insights: Option<Vec<InsightView>>, pub removed_apis: Option<Vec<RemovedUse>>, pub next_version: Option<String>, pub skew: Vec<Skew>, pub gaps: Vec<Gap> }`
  - `pub struct EksParts { pub cluster: Result<ClusterView, AppError>, pub nodegroups: Result<Vec<NodegroupView>, AppError>, pub fargate: Result<Vec<String>, AppError>, pub addons: Result<Vec<AddonView>, AppError>, pub insights: Result<Vec<InsightView>, AppError> }`
  - `pub struct K8sParts { pub nodes: Result<Vec<DynamicObject>, AppError>, pub requests: Result<(HashMap<String, Resources>, bool), AppError>, pub usage: Result<Option<HashMap<String, Usage>>, AppError>, pub node_pools: Result<Option<Vec<String>>, AppError>, pub removed: Result<Option<Vec<RemovedUse>>, AppError> }`
  - `pub const LIST_PAGES_MAX: usize = 20`, `pub const RUNNING_PODS: &str = "status.phase!=Succeeded,status.phase!=Failed"`
  - `pub fn assemble(eks: EksParts, k8s: K8sParts) -> Overview` (pure)
  - `pub async fn k8s_parts(client: &Client, version: Option<&str>, endpoint: Endpoint) -> K8sParts`
  - `pub async fn overview(eks: &aws_sdk_eks::Client, cluster: &str, client: &Client, endpoint: Endpoint) -> Overview`
  - Tauri command `k8s_overview(target) -> Overview`

Rules for `assemble`: each failed part adds one gap with its section (nodes and requests both use `Section::Nodes`; usage uses `Metrics`) and leaves its field `None`; `metrics` is true only when usage came back; nodes are sorted by name and get `requested` from the per-node map (default zero) and `usage` when present; `next_version` and `skew` need the cluster version (none when the cluster part failed). In `k8s_parts`, a failed discovery fails usage, node pools, and removed APIs with the same error (three gaps), while nodes and requests still load.

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/k8s/read/overview/tests.rs`:

```rust
use serde_json::json;

use super::*;
use crate::k8s::read::values::GroupKind;

fn cluster(version: &str) -> ClusterView {
    ClusterView {
        version: version.into(), platform_version: None, status: None, endpoint_public: true, endpoint_private: false,
        public_cidrs: vec![], logging: vec![], secrets_encrypted: false, oidc_issuer: None, authentication_mode: None,
    }
}

fn node(name: &str, kubelet: &str) -> DynamicObject {
    serde_json::from_value(json!({ "apiVersion": "v1", "kind": "Node", "metadata": { "name": name },
        "status": { "conditions": [{ "type": "Ready", "status": "True" }], "nodeInfo": { "kubeletVersion": kubelet }, "allocatable": { "cpu": "2", "memory": "4Gi", "pods": "29" } } }))
    .unwrap()
}

fn eks_ok() -> EksParts {
    EksParts { cluster: Ok(cluster("1.31")), nodegroups: Ok(vec![]), fargate: Ok(vec![]), addons: Ok(vec![]), insights: Ok(vec![]) }
}

fn k8s_ok() -> K8sParts {
    let mut req = HashMap::new();
    req.insert("b".to_string(), Resources { cpu_milli: 500, memory_bytes: 1, pods: 3 });
    let mut usage = HashMap::new();
    usage.insert("b".to_string(), Usage { cpu_milli: 100, memory_bytes: 2 });
    K8sParts {
        nodes: Ok(vec![node("b", "v1.31.1"), node("a", "v1.29.9")]),
        requests: Ok((req, false)),
        usage: Ok(Some(usage)),
        node_pools: Ok(None),
        removed: Ok(Some(vec![])),
    }
}

fn denied(action: &str) -> AppError {
    AppError::AccessDenied { action: action.into() }
}

#[test]
fn everything_loads() {
    let o = assemble(eks_ok(), k8s_ok());
    assert!(o.gaps.is_empty());
    let nodes = o.nodes.unwrap();
    assert_eq!(nodes.iter().map(|n| n.name.as_str()).collect::<Vec<_>>(), ["a", "b"]);
    assert_eq!(nodes[1].requested, Resources { cpu_milli: 500, memory_bytes: 1, pods: 3 });
    assert_eq!(nodes[1].usage, Some(Usage { cpu_milli: 100, memory_bytes: 2 }));
    assert_eq!(nodes[0].requested, Resources::default());
    assert_eq!(nodes[0].group_kind, GroupKind::SelfManaged);
    assert!(o.metrics);
    assert_eq!(o.next_version.as_deref(), Some("1.32"));
    assert_eq!(o.skew, [Skew { node: "a".into(), kubelet_version: "v1.29.9".into(), minors_behind: 2 }]);
    assert_eq!(o.node_pools, None);
    assert_eq!(o.removed_apis, Some(vec![]));
}

#[test]
fn failed_parts_become_gaps_and_the_rest_stays() {
    let eks = EksParts { cluster: Err(denied("eks:DescribeCluster")), addons: Err(denied("eks:ListAddons")), ..eks_ok() };
    let k8s = K8sParts { requests: Err(denied("list pods")), usage: Err(denied("list nodes.metrics.k8s.io")), ..k8s_ok() };
    let o = assemble(eks, k8s);
    let sections: Vec<Section> = o.gaps.iter().map(|g| g.section).collect();
    assert_eq!(sections, [Section::Cluster, Section::Addons, Section::Nodes, Section::Metrics]);
    assert_eq!(o.gaps[2].error, denied("list pods"));
    assert!(o.cluster.is_none() && o.addons.is_none());
    // 노드는 보이고 요청량은 0, 사용량은 없다
    let nodes = o.nodes.unwrap();
    assert!(nodes.iter().all(|n| n.requested == Resources::default() && n.usage.is_none()));
    assert!(!o.metrics);
    // 클러스터 버전을 모르면 다음 버전과 버전 차이도 없다
    assert_eq!(o.next_version, None);
    assert!(o.skew.is_empty());
    assert_eq!(o.nodegroups, Some(vec![]));
}

#[test]
fn no_metrics_server_is_not_a_gap() {
    let o = assemble(eks_ok(), K8sParts { usage: Ok(None), ..k8s_ok() });
    assert!(o.gaps.is_empty() && !o.metrics);
}

#[test]
fn overview_json_keys_match_the_ts_contract() {
    let v = serde_json::to_value(assemble(eks_ok(), K8sParts { requests: Ok((HashMap::new(), true)), ..k8s_ok() })).unwrap();
    for key in ["cluster", "nodes", "requestsPartial", "metrics", "nodegroups", "fargateProfiles", "nodePools", "addons", "insights", "removedApis", "nextVersion", "skew", "gaps"] {
        assert!(v.get(key).is_some(), "{key}");
    }
    assert_eq!(v["requestsPartial"], json!(true));
    let gap = serde_json::to_value(Gap { section: Section::RemovedApis, error: denied("x") }).unwrap();
    assert_eq!(gap, json!({ "section": "removedApis", "error": { "kind": "accessDenied", "action": "x" } }));
    assert_eq!(serde_json::to_value(Section::NodePools).unwrap(), json!("nodePools"));
}
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `cd src-tauri && cargo test --lib k8s::read::overview`
Expected: compile error (`overview` module missing).

- [ ] **Step 3: Implement**

In `src-tauri/src/k8s/read.rs`, add `pub mod overview;` (alphabetical) and:

```rust
use kube::api::ListParams;

use super::watch::PAGE_SIZE;

/// 쪽을 넘기며 끝까지 읽되 `max_pages` 쪽에서 멈춘다. 둘째 값은 멈췄는지(뒤에 더 있음).
pub async fn list_all(api: &Api<DynamicObject>, lp: &ListParams, max_pages: usize, resource: &str, endpoint: Endpoint) -> Result<(Vec<DynamicObject>, bool), AppError> {
    let mut items = Vec::new();
    let mut token: Option<String> = None;
    for _ in 0..max_pages {
        let mut p = lp.clone().limit(PAGE_SIZE);
        if let Some(t) = &token {
            p = p.continue_token(t);
        }
        let page = bounded(api.list(&p), "list", resource, endpoint).await?;
        items.extend(page.items);
        token = page.metadata.continue_.filter(|c| !c.is_empty());
        if token.is_none() {
            return Ok((items, false));
        }
    }
    Ok((items, true))
}
```

Create `src-tauri/src/k8s/read/overview.rs`:

```rust
//! 개요 한 장. EKS 쪽과 쿠버네티스 쪽을 함께 읽고, 읽지 못한 부분은 `gaps`에 남긴다(나머지는 그대로 보인다).
use std::collections::HashMap;

use kube::api::{Api, DynamicObject, ListParams};
use kube::discovery::Discovery;
use kube::Client;
use serde::Serialize;

use super::eks::{self, AddonView, ClusterView, InsightView, NodegroupView};
use super::kinds::discover;
use super::nodes::{node_view, requests_by_node, skew, usage_of, NodeView, Resources, Skew, Usage};
use super::removed::{self, next_minor, RemovedUse};
use super::{api_for, bounded, list_all};
use crate::error::AppError;
use crate::k8s::failure::Endpoint;
use crate::k8s::rows::KindRef;

pub const LIST_PAGES_MAX: usize = 20;
pub const RUNNING_PODS: &str = "status.phase!=Succeeded,status.phase!=Failed";
const METRICS_GROUP: &str = "metrics.k8s.io";
const KARPENTER_GROUP: &str = "karpenter.sh";

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Section {
    Cluster,
    Nodes,
    Metrics,
    Nodegroups,
    Fargate,
    NodePools,
    Addons,
    Insights,
    RemovedApis,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gap {
    pub section: Section,
    pub error: AppError,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub cluster: Option<ClusterView>,
    pub nodes: Option<Vec<NodeView>>,
    pub requests_partial: bool,
    pub metrics: bool,
    pub nodegroups: Option<Vec<NodegroupView>>,
    pub fargate_profiles: Option<Vec<String>>,
    pub node_pools: Option<Vec<String>>,
    pub addons: Option<Vec<AddonView>>,
    pub insights: Option<Vec<InsightView>>,
    pub removed_apis: Option<Vec<RemovedUse>>,
    pub next_version: Option<String>,
    pub skew: Vec<Skew>,
    pub gaps: Vec<Gap>,
}

pub struct EksParts {
    pub cluster: Result<ClusterView, AppError>,
    pub nodegroups: Result<Vec<NodegroupView>, AppError>,
    pub fargate: Result<Vec<String>, AppError>,
    pub addons: Result<Vec<AddonView>, AppError>,
    pub insights: Result<Vec<InsightView>, AppError>,
}

pub struct K8sParts {
    pub nodes: Result<Vec<DynamicObject>, AppError>,
    pub requests: Result<(HashMap<String, Resources>, bool), AppError>,
    pub usage: Result<Option<HashMap<String, Usage>>, AppError>,
    pub node_pools: Result<Option<Vec<String>>, AppError>,
    pub removed: Result<Option<Vec<RemovedUse>>, AppError>,
}

fn keep<T>(r: Result<T, AppError>, section: Section, gaps: &mut Vec<Gap>) -> Option<T> {
    match r {
        Ok(v) => Some(v),
        Err(error) => {
            gaps.push(Gap { section, error });
            None
        }
    }
}

pub fn assemble(eks: EksParts, k8s: K8sParts) -> Overview {
    let mut gaps = Vec::new();
    let cluster = keep(eks.cluster, Section::Cluster, &mut gaps);
    let nodegroups = keep(eks.nodegroups, Section::Nodegroups, &mut gaps);
    let fargate_profiles = keep(eks.fargate, Section::Fargate, &mut gaps);
    let addons = keep(eks.addons, Section::Addons, &mut gaps);
    let insights = keep(eks.insights, Section::Insights, &mut gaps);
    let node_items = keep(k8s.nodes, Section::Nodes, &mut gaps);
    let (requests, requests_partial) = keep(k8s.requests, Section::Nodes, &mut gaps).unwrap_or_default();
    let usage = keep(k8s.usage, Section::Metrics, &mut gaps).flatten();
    let node_pools = keep(k8s.node_pools, Section::NodePools, &mut gaps).flatten();
    let removed_apis = keep(k8s.removed, Section::RemovedApis, &mut gaps).flatten();
    let nodes = node_items.map(|items| {
        let mut views: Vec<NodeView> = items
            .iter()
            .map(|n| {
                let name = n.metadata.name.clone().unwrap_or_default();
                node_view(n, requests.get(&name).copied().unwrap_or_default(), usage.as_ref().and_then(|u| u.get(&name).copied()))
            })
            .collect();
        views.sort_by(|a, b| a.name.cmp(&b.name));
        views
    });
    let version = cluster.as_ref().map(|c| c.version.clone());
    let skew = match (&version, &nodes) {
        (Some(v), Some(n)) => skew(v, n),
        _ => vec![],
    };
    Overview {
        next_version: version.as_deref().and_then(next_minor),
        cluster,
        nodes,
        requests_partial,
        metrics: usage.is_some(),
        nodegroups,
        fargate_profiles,
        node_pools,
        addons,
        insights,
        removed_apis,
        skew,
        gaps,
    }
}

fn core(kind: &str, plural: &str, namespaced: bool) -> KindRef {
    KindRef { group: String::new(), version: "v1".into(), kind: kind.into(), plural: plural.into(), namespaced }
}

async fn node_usage(client: &Client, d: &Discovery, endpoint: Endpoint) -> Result<Option<HashMap<String, Usage>>, AppError> {
    let Some((ar, _)) = d.get(METRICS_GROUP).and_then(|g| g.recommended_kind("NodeMetrics")) else { return Ok(None) };
    let api: Api<DynamicObject> = Api::all_with(client.clone(), &ar);
    let page = bounded(api.list(&ListParams::default()), "list", "nodes.metrics.k8s.io", endpoint).await?;
    Ok(Some(page.items.iter().map(usage_of).collect()))
}

async fn node_pools(client: &Client, d: &Discovery, endpoint: Endpoint) -> Result<Option<Vec<String>>, AppError> {
    let Some((ar, _)) = d.get(KARPENTER_GROUP).and_then(|g| g.recommended_kind("NodePool")) else { return Ok(None) };
    let (items, _) = list_all(&Api::all_with(client.clone(), &ar), &ListParams::default(), 1, "nodepools", endpoint).await?;
    let mut names: Vec<String> = items.into_iter().filter_map(|o| o.metadata.name).collect();
    names.sort();
    Ok(Some(names))
}

/// 다음 버전에서 제거되는 표 항목마다, 서버가 목록용 버전을 내줄 때만 한 쪽(500개)을 읽어 옛 API로 쓴 것을 고른다
async fn removed_uses(client: &Client, d: &Discovery, version: Option<&str>, endpoint: Endpoint) -> Result<Option<Vec<RemovedUse>>, AppError> {
    let Some(version) = version else { return Ok(None) };
    let mut out = Vec::new();
    for r in removed::due(version) {
        if !d.get(r.list_group).is_some_and(|g| g.versions().any(|v| v == r.list_version)) {
            continue;
        }
        let kind = KindRef { group: r.list_group.into(), version: r.list_version.into(), kind: r.kind.into(), plural: r.plural.into(), namespaced: r.namespaced };
        let (items, _) = list_all(&api_for(client.clone(), &kind, None), &ListParams::default(), 1, r.plural, endpoint).await?;
        out.extend(removed::uses_of(r, &items));
    }
    Ok(Some(out))
}

pub async fn k8s_parts(client: &Client, version: Option<&str>, endpoint: Endpoint) -> K8sParts {
    let nodes_api = api_for(client.clone(), &core("Node", "nodes", false), None);
    let pods_api = api_for(client.clone(), &core("Pod", "pods", true), None);
    let pods_lp = ListParams::default().fields(RUNNING_PODS);
    let (discovery, nodes, requests) = tokio::join!(
        discover(client, endpoint),
        async { list_all(&nodes_api, &ListParams::default(), LIST_PAGES_MAX, "nodes", endpoint).await.map(|(items, _)| items) },
        async { list_all(&pods_api, &pods_lp, LIST_PAGES_MAX, "pods", endpoint).await.map(|(items, partial)| (requests_by_node(&items), partial)) },
    );
    let (usage, node_pools, removed) = match discovery {
        Err(e) => (Err(e.clone()), Err(e.clone()), Err(e)),
        Ok(d) => tokio::join!(node_usage(client, &d, endpoint), node_pools(client, &d, endpoint), removed_uses(client, &d, version, endpoint)),
    };
    K8sParts { nodes, requests, usage, node_pools, removed }
}

/// 클러스터 버전을 먼저 읽고(애드온 최신 버전, 제거되는 API, 버전 차이에 쓴다) 나머지는 함께 읽는다
pub async fn overview(eks_client: &aws_sdk_eks::Client, cluster: &str, client: &Client, endpoint: Endpoint) -> Overview {
    let described = eks::describe(eks_client, cluster).await;
    let version = described.as_ref().ok().map(|c| c.version.clone());
    let v = version.as_deref();
    let (nodegroups, fargate, addons, insights, k8s) = tokio::join!(
        eks::nodegroups(eks_client, cluster),
        eks::fargate_profiles(eks_client, cluster),
        eks::addons(eks_client, cluster, v),
        eks::insights(eks_client, cluster),
        k8s_parts(client, v, endpoint),
    );
    assemble(EksParts { cluster: described, nodegroups, fargate, addons, insights }, k8s)
}

#[cfg(test)]
mod tests;
```

In `src-tauri/src/k8s_commands.rs`, add `use crate::k8s::read::overview::{self, Overview};` and:

```rust
/// 개요. 부분마다 실패를 `gaps`에 담아 돌려주므로 연결이 없을 때와 AWS 프로필 설정을 읽지 못할 때만 실패한다.
#[tauri::command]
pub async fn k8s_overview(app: State<'_, AppState>, k8s: State<'_, K8sState>, target: K8sTarget) -> Result<Overview, AppError> {
    let s = k8s.session(&target)?;
    let cfg = app.ctx.config(&target.profile, &target.region).await?;
    Ok(overview::overview(&aws_sdk_eks::Client::new(&cfg), &target.cluster, &s.client, s.endpoint).await)
}
```

In `src-tauri/src/lib.rs`, add `k8s_commands::k8s_overview,` after `k8s_commands::k8s_get,`.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `cd src-tauri && cargo test --lib k8s && cargo clippy --all-targets -- -D warnings`
Expected: all pass, clippy clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/k8s/read.rs src-tauri/src/k8s/read/overview.rs src-tauri/src/k8s/read/overview/tests.rs src-tauri/src/k8s_commands.rs src-tauri/src/lib.rs
git commit -m "feat(k8s): cluster overview with per-section gaps and the k8s_overview command

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task K2-B10: Live tests against kind for discovery, ownership, Secrets, problems, events, and the overview's Kubernetes part

**Files:**
- Modify: `scripts/k8s-live-test.sh`, `src-tauri/src/k8s/live_tests.rs`

**Interfaces:**
- Consumes: `read::kinds::{discover, kinds_of}`, `read::detail::{get, ContainerState}`, `read::secret::{secret_value, secrets_kind, key_missing, Encoding, SecretKey, SecretValue, MASK}`, `read::values::Problem`, `read::overview::k8s_parts`, K1 live helpers (`base`, `build`, `reader_config`, `recv`, `PRIVATE`, `client_for`, `run`).
- Produces: 6 new `#[ignore]` tests (18 live tests in total).

- [ ] **Step 1: Add the K2 fixtures to the live script**

In `scripts/k8s-live-test.sh`, after the `reader_token=…` line and before the exec-plugin section, add:

```bash
  # K2 픽스처: 준비되는 Deployment, 이미지를 받지 못하는 Pod, kubectl apply로 만든 Secret(last-applied에 값이 남는다), CRD와 그 객체
  kubectl --kubeconfig "$kc" apply -f - <<'YAML'
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata: { name: widgets.mm.example.com }
spec:
  group: mm.example.com
  scope: Namespaced
  names: { plural: widgets, singular: widget, kind: Widget }
  versions:
    - name: v1
      served: true
      storage: true
      schema: { openAPIV3Schema: { type: object, x-kubernetes-preserve-unknown-fields: true } }
YAML
  kubectl --kubeconfig "$kc" wait --for condition=established --timeout=60s crd/widgets.mm.example.com
  kubectl --kubeconfig "$kc" apply -f - <<'YAML'
apiVersion: v1
kind: Namespace
metadata: { name: mm-k2 }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: web, namespace: mm-k2 }
spec:
  replicas: 1
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec: { containers: [{ name: app, image: "registry.k8s.io/pause:3.10" }] }
---
apiVersion: v1
kind: Pod
metadata: { name: broken, namespace: mm-k2 }
spec: { containers: [{ name: app, image: "registry.invalid/mm/nope:1" }] }
---
apiVersion: v1
kind: Secret
metadata: { name: db, namespace: mm-k2 }
stringData: { password: hunter2 }
---
apiVersion: mm.example.com/v1
kind: Widget
metadata: { name: w1, namespace: mm-k2 }
YAML
  kubectl --kubeconfig "$kc" -n mm-k2 rollout status deployment/web --timeout=120s
```

- [ ] **Step 2: Write the live tests**

Append to `src-tauri/src/k8s/live_tests.rs` (add the imports at the top with the others):

```rust
use super::read::detail::{get, ContainerState};
use super::read::kinds::{discover, kinds_of};
use super::read::overview::k8s_parts;
use super::read::secret::{key_missing, secret_value, secrets_kind, Encoding, SecretKey, SecretValue, MASK};
use super::read::values::Problem;

fn kind_ref(group: &str, version: &str, kind: &str, plural: &str) -> KindRef {
    KindRef { group: group.into(), version: version.into(), kind: kind.into(), plural: plural.into(), namespaced: true }
}

async fn admin() -> kube::Client {
    let (context, value) = base();
    client_for(&build(&value), &context, PRIVATE).await.unwrap()
}

#[tokio::test]
#[ignore]
async fn discovery_lists_builtin_and_custom_kinds() {
    let client = admin().await;
    let kinds = kinds_of(&discover(&client, PRIVATE).await.unwrap());
    let find = |g: &str, k: &str| kinds.iter().find(|x| x.kind.group == g && x.kind.kind == k).cloned();
    let deploy = find("apps", "Deployment").expect("Deployment");
    assert!(!deploy.custom && deploy.kind.namespaced && deploy.kind.plural == "deployments");
    assert!(find("mm.example.com", "Widget").expect("Widget").custom);
    assert!(find("", "Pod").is_some() && find("", "Node").is_some_and(|n| !n.kind.namespaced));
}

#[tokio::test]
#[ignore]
async fn deployment_owns_a_replicaset_that_owns_a_pod() {
    let client = admin().await;
    let d = get(&client, &kind_ref("apps", "v1", "Deployment", "deployments"), Some("mm-k2"), "web", PRIVATE).await.unwrap();
    assert_eq!(d.containers[0].state, ContainerState::Template);
    assert!(d.children_error.is_none() && d.events_error.is_none());
    let rs = d.children.first().expect("a ReplicaSet child").clone();
    assert_eq!(rs.kind, "ReplicaSet");
    let rs_view = get(&client, &kind_ref("apps", "v1", "ReplicaSet", "replicasets"), Some("mm-k2"), &rs.name, PRIVATE).await.unwrap();
    assert!(rs_view.owners.iter().any(|o| o.kind == "Deployment" && o.name == "web" && o.controller));
    let pod = rs_view.children.first().expect("a Pod child").clone();
    let pod_view = get(&client, &kind_ref("", "v1", "Pod", "pods"), Some("mm-k2"), &pod.name, PRIVATE).await.unwrap();
    assert!(pod_view.owners.iter().any(|o| o.uid == rs_view.row.uid));
    assert!(!pod_view.yaml.contains("managedFields"));
}

#[tokio::test]
#[ignore]
async fn secret_is_masked_in_detail_and_readable_by_key() {
    let client = admin().await;
    let v = get(&client, &secrets_kind(), Some("mm-k2"), "db", PRIVATE).await.unwrap();
    let all = serde_json::to_string(&v).unwrap();
    assert!(!all.contains("hunter2") && !all.contains("aHVudGVyMg=="), "{all}");
    assert!(v.yaml.contains(MASK));
    assert_eq!(v.secret_keys, Some(vec![SecretKey { key: "password".into(), size: 7 }]));
    assert_eq!(secret_value(&client, "mm-k2", "db", "password", PRIVATE).await.unwrap(), SecretValue { text: "hunter2".into(), encoding: Encoding::Utf8 });
    assert_eq!(secret_value(&client, "mm-k2", "db", "nope", PRIVATE).await.unwrap_err(), AppError::other(key_missing("nope")));
}

#[tokio::test]
#[ignore]
async fn a_reader_without_secret_access_is_denied() {
    let (context, value) = reader_config();
    let client = client_for(&build(&value), &context, PRIVATE).await.unwrap();
    assert_eq!(secret_value(&client, "mm-live", "any", "k", PRIVATE).await.unwrap_err(), AppError::AccessDenied { action: "get secrets".into() });
}

#[tokio::test]
#[ignore]
async fn broken_pod_is_flagged_in_the_watch_and_has_warning_events() {
    let client = admin().await;
    let pods = kind_ref("", "v1", "Pod", "pods");
    let (tx, mut rx) = mpsc::unbounded_channel();
    let task = tokio::spawn(run(client.clone(), pods.clone(), Some("mm-k2".into()), PRIVATE, move |m| tx.send(m).is_ok()));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        match recv(&mut rx, left).await {
            Some(WatchMessage::Reset { rows }) | Some(WatchMessage::Changes { upserts: rows, .. })
                if rows.iter().any(|r| r.name == "broken" && r.problems.contains(&Problem::ImagePullBackOff)) =>
            {
                break
            }
            Some(_) => {}
            None => panic!("broken never showed imagePullBackOff within 120 s"),
        }
    }
    task.abort();
    let v = get(&client, &pods, Some("mm-k2"), "broken", PRIVATE).await.unwrap();
    assert!(v.events.iter().any(|e| e.type_ == "Warning"), "{:?}", v.events);
}

#[tokio::test]
#[ignore]
async fn overview_kubernetes_part_reads_nodes_and_requests() {
    let client = admin().await;
    let parts = k8s_parts(&client, Some("1.33"), PRIVATE).await;
    assert!(!parts.nodes.unwrap().is_empty());
    let (requests, partial) = parts.requests.unwrap();
    assert!(!partial);
    // coredns가 CPU를 요청한다
    assert!(requests.values().any(|r| r.cpu_milli > 0 && r.pods > 0), "{requests:?}");
    // kind에는 metrics-server와 Karpenter가 없다
    assert_eq!(parts.usage.unwrap(), None);
    assert_eq!(parts.node_pools.unwrap(), None);
    assert_eq!(parts.removed.unwrap(), Some(vec![]));
}
```

If `kinds_of` returns `Kind` values that are not `Clone`, the `.cloned()` above needs `Kind: Clone` (it derives `Clone` in Task K2-B4).

- [ ] **Step 3: Run the unit tests and the live tests**

Run: `cd src-tauri && cargo test --lib k8s && cargo clippy --all-targets -- -D warnings`
Expected: pass (the new tests are ignored here).

Run: `scripts/k8s-live-test.sh`
Expected: 18 live tests pass on both kind images (`v1.33.1`, `v1.35.0`). If Docker is not available in the implementer's environment, report that and leave the run to the controller; do not mark this step done.

- [ ] **Step 4: Commit**

```bash
git add scripts/k8s-live-test.sh src-tauri/src/k8s/live_tests.rs
git commit -m "test(k8s): live tests for discovery, ownership, Secret masking, problems, events and overview

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task K2-F1: Frontend data layer (types, strings, API, queries)

**Files:**
- Modify: `src/k8s/types.ts`, `src/k8s/text.ts`, `src/k8s/api.ts`, `src/k8s/api.test.ts`, `src/k8s/queries.ts`, `src/k8s/queries.test.tsx`, `src/k8s/targets.ts`, `src/k8s/targets.test.ts`, `src/k8s/useK8sWatch.ts`

**Interfaces:**
- Consumes: the Contract (backend runs in parallel; tests mock `invoke`/`k8sApi`).
- Produces:
  - `types.ts`: every K2 type in the Contract (`K8sProblem`, `K8sKind`, `K8sLink`, `K8sTermination`, `K8sContainer`, `K8sCondition`, `K8sEvent`, `K8sSecretKey`, `K8sObjectView`, `K8sSecretValue`, `K8sOverviewSection`, `K8sGap`, `K8sClusterView`, `K8sResources`, `K8sGroupKind`, `K8sNodeView`, `K8sNodegroupView`, `K8sAddonView`, `K8sInsightView`, `K8sRemovedUse`, `K8sSkew`, `K8sOverview`), `K8sRow.problems`, and the frontend-only `interface ObjectRef { kind: K8sKindRef; namespace: string | null; name: string }`
  - `targets.ts`: `export const kindKey = (k: K8sKindRef) => \`${k.group}/${k.version}/${k.plural}\``
  - `api.ts`: `k8sApi.kinds(target, ssoProfile)`, `k8sApi.get(target, kind, namespace, name, ssoProfile)`, `k8sApi.secretValue(target, namespace, name, key, ssoProfile)`, `k8sApi.overview(target)` (top-level `profile: target.profile`)
  - `queries.ts`: `k8sKeys.kinds(t, context)`, `k8sKeys.object(t, context, ref, resourceVersion)`, `k8sKeys.overview(t, context)`; hooks `useK8sKinds(target, context, ssoProfile, enabled)`, `useK8sObject(target, context, ref: ObjectRef | null, resourceVersion: string | null, ssoProfile, enabled)`, `useK8sOverview(target, context, ssoProfile, enabled)`. No hook for Secret values.
  - `text.ts`: every K2 TS string in Global Constraints, with the names below.

- [ ] **Step 1: Write the failing tests**

Append to `src/k8s/api.test.ts`:

```ts
test("K2 reads pass the exec profile at the top level", async () => {
  vi.mocked(invoke).mockResolvedValue({});
  const kind = { group: "apps", version: "v1", kind: "Deployment", plural: "deployments", namespaced: true };
  await k8sApi.kinds(T, "prod-ro");
  expect(invoke).toHaveBeenLastCalledWith("k8s_kinds", { target: T, profile: "prod-ro" });
  await k8sApi.get(T, kind, "web", "api", "prod-ro");
  expect(invoke).toHaveBeenLastCalledWith("k8s_get", { target: T, kind, namespace: "web", name: "api", profile: "prod-ro" });
  await k8sApi.secretValue(T, "web", "db", "password", "prod-ro");
  expect(invoke).toHaveBeenLastCalledWith("k8s_secret_value", { target: T, namespace: "web", name: "db", key: "password", profile: "prod-ro" });
});

test("overview reports SSO expiry for the app profile", async () => {
  vi.mocked(invoke).mockResolvedValue({});
  await k8sApi.overview(T);
  expect(invoke).toHaveBeenLastCalledWith("k8s_overview", { target: T, profile: "app" });
});
```

Append to `src/k8s/targets.test.ts`:

```ts
test("kindKey names group, version and plural", () => {
  expect(kindKey({ group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true })).toBe("/v1/pods");
  expect(kindKey({ group: "apps", version: "v1", kind: "Deployment", plural: "deployments", namespaced: true })).toBe("apps/v1/deployments");
});
```

(add `kindKey` to that file's import from `./targets`).

In `src/k8s/queries.test.tsx`, change the `vi.mock("./api", …)` factory to include `kinds: vi.fn(), get: vi.fn(), secretValue: vi.fn(), overview: vi.fn()`, import `useK8sKinds, useK8sObject, useK8sOverview` from `./queries`, and append:

```ts
const DEPLOY = { group: "apps", version: "v1", kind: "Deployment", plural: "deployments", namespaced: true };

test("K2 keys live under the target and include the context", () => {
  const ref = { kind: DEPLOY, namespace: "web", name: "api" };
  expect(k8sKeys.kinds(T, "ctx")).toEqual(["k8s", "app|r|prod", "kinds", "ctx"]);
  expect(k8sKeys.object(T, "ctx", ref, "7")).toEqual(["k8s", "app|r|prod", "object", "ctx", "apps/v1/deployments", "web", "api", "7"]);
  expect(k8sKeys.overview(T, "ctx")).toEqual(["k8s", "app|r|prod", "overview", "ctx"]);
});

test("useK8sObject reads once per resourceVersion and waits for enabled", async () => {
  const qc = client();
  api.get.mockResolvedValue({ yaml: "a" } as never);
  const ref = { kind: DEPLOY, namespace: "web", name: "api" };
  const { rerender } = renderHook(({ rv, on }) => useK8sObject(T, "ctx", ref, rv, "p", on), { wrapper: wrap(qc), initialProps: { rv: "1", on: false } });
  expect(api.get).not.toHaveBeenCalled();
  rerender({ rv: "1", on: true });
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
  expect(api.get).toHaveBeenCalledWith(T, DEPLOY, "web", "api", "p");
  rerender({ rv: "2", on: true });
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
});

test("useK8sKinds and useK8sOverview need a context and enabled", async () => {
  const qc = client();
  api.kinds.mockResolvedValue([]);
  api.overview.mockResolvedValue({ gaps: [] } as never);
  renderHook(() => useK8sKinds(T, null, "p", true), { wrapper: wrap(qc) });
  renderHook(() => useK8sOverview(T, "ctx", "p", false), { wrapper: wrap(qc) });
  await new Promise((r) => setTimeout(r, 0));
  expect(api.kinds).not.toHaveBeenCalled();
  expect(api.overview).not.toHaveBeenCalled();
  const k = renderHook(() => useK8sKinds(T, "ctx", "p", true), { wrapper: wrap(qc) });
  await waitFor(() => expect(k.result.current.isSuccess).toBe(true));
  expect(api.kinds).toHaveBeenCalledWith(T, "p");
});

test("refreshK8s removes K2 data so it is read again on the new connection", async () => {
  const qc = client();
  qc.setQueryData(k8sKeys.kinds(T, "ctx"), []);
  qc.setQueryData(k8sKeys.overview(T, "ctx"), { gaps: [] });
  qc.setQueryData(k8sKeys.object(T, "ctx", { kind: DEPLOY, namespace: "web", name: "api" }, "1"), { yaml: "" });
  await refreshK8s(qc, T, "p");
  expect(qc.getQueryData(k8sKeys.kinds(T, "ctx"))).toBeUndefined();
  expect(qc.getQueryData(k8sKeys.overview(T, "ctx"))).toBeUndefined();
  expect(qc.getQueriesData({ queryKey: [...k8sKeys.root(T), "object"] })).toEqual([]);
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run src/k8s/api.test.ts src/k8s/queries.test.tsx src/k8s/targets.test.ts`
Expected: FAIL (`k8sApi.kinds` is not a function, `kindKey`/`useK8sObject` missing).

- [ ] **Step 3: Implement**

Append to `src/k8s/types.ts` (and add `problems: K8sProblem[];` as the last field of `K8sRow` with the comment `/** 이상 표시. 정렬돼 있고 겹치지 않는다(K2) */`):

```ts
export type K8sProblem = "crashLoopBackOff" | "imagePullBackOff" | "pending" | "oomKilled" | "notReady";

export interface K8sKind extends K8sKindRef {
  verbs: string[];
  /** 내장 API 그룹이 아닌 종류(사용자 정의 리소스) */
  custom: boolean;
}

/** 소유자 또는 자식. plural은 kinds로 프론트가 찾는다 */
export interface K8sLink {
  group: string;
  version: string;
  kind: string;
  name: string;
  namespace: string | null;
  uid: string;
  controller: boolean;
  problems: K8sProblem[];
}

export interface K8sTermination {
  reason: string | null;
  exitCode: number;
  finishedAt: string | null;
}

export interface K8sContainer {
  name: string;
  image: string;
  init: boolean;
  /** template: 워크로드의 Pod 템플릿에서 읽은 것(상태 없음) */
  state: "running" | "waiting" | "terminated" | "unknown" | "template";
  ready: boolean;
  restarts: number;
  reason: string | null;
  message: string | null;
  lastTermination: K8sTermination | null;
}

export interface K8sCondition {
  type: string;
  status: string;
  reason: string | null;
  message: string | null;
  lastTransition: string | null;
}

export interface K8sEvent {
  type: string;
  reason: string;
  message: string;
  count: number;
  lastSeen: string | null;
  source: string | null;
  /** "Kind/name" */
  object: string;
}

export interface K8sSecretKey {
  key: string;
  /** 값의 바이트 수 */
  size: number;
}

export interface K8sObjectView {
  kind: K8sKindRef;
  row: K8sRow;
  /** Secret이면 last-applied 어노테이션은 가려져 있다 */
  annotations: Record<string, string>;
  owners: K8sLink[];
  children: K8sLink[];
  childrenTruncated: boolean;
  childrenError: AppError | null;
  containers: K8sContainer[];
  conditions: K8sCondition[];
  /** 최근 것부터, 최대 100개 */
  events: K8sEvent[];
  eventsError: AppError | null;
  /** managedFields 없음, Secret 값은 •••• */
  yaml: string;
  /** Secret일 때만 */
  secretKeys: K8sSecretKey[] | null;
}

/** Secret 키 하나의 값. 컴포넌트 상태에만 둔다(React Query에 넣지 않는다) */
export interface K8sSecretValue {
  text: string;
  encoding: "utf8" | "base64";
}

export type K8sOverviewSection = "cluster" | "nodes" | "metrics" | "nodegroups" | "fargate" | "nodePools" | "addons" | "insights" | "removedApis";

export interface K8sGap {
  section: K8sOverviewSection;
  error: AppError;
}

export interface K8sClusterView {
  version: string;
  platformVersion: string | null;
  status: string | null;
  endpointPublic: boolean;
  endpointPrivate: boolean;
  publicCidrs: string[];
  /** 켜진 컨트롤 플레인 로그 종류 */
  logging: string[];
  secretsEncrypted: boolean;
  oidcIssuer: string | null;
  authenticationMode: string | null;
}

export interface K8sResources {
  cpuMilli: number;
  memoryBytes: number;
  pods: number;
}

export type K8sGroupKind = "managed" | "fargate" | "karpenter" | "self";

export interface K8sNodeView {
  name: string;
  ready: boolean;
  unschedulable: boolean;
  pressures: string[];
  instanceType: string | null;
  zone: string | null;
  groupKind: K8sGroupKind;
  group: string | null;
  kubeletVersion: string;
  allocatable: K8sResources;
  requested: K8sResources;
  usage: { cpuMilli: number; memoryBytes: number } | null;
}

export interface K8sNodegroupView {
  name: string;
  status: string | null;
  version: string | null;
  instanceTypes: string[];
  capacityType: string | null;
  min: number | null;
  max: number | null;
  desired: number | null;
}

export interface K8sAddonView {
  name: string;
  version: string | null;
  latest: string | null;
  status: string | null;
  issues: string[];
}

export interface K8sInsightView {
  name: string;
  category: string | null;
  status: string | null;
  reason: string | null;
  description: string | null;
  kubernetesVersion: string | null;
}

export interface K8sRemovedUse {
  kind: string;
  apiVersion: string;
  replacement: string;
  removedIn: string;
  namespace: string | null;
  name: string;
}

export interface K8sSkew {
  node: string;
  kubeletVersion: string;
  minorsBehind: number;
}

export interface K8sOverview {
  cluster: K8sClusterView | null;
  nodes: K8sNodeView[] | null;
  requestsPartial: boolean;
  /** 사용량을 metrics-server에서 받았는지 */
  metrics: boolean;
  nodegroups: K8sNodegroupView[] | null;
  fargateProfiles: string[] | null;
  /** null: Karpenter NodePool 종류가 없다(또는 읽지 못함) */
  nodePools: string[] | null;
  addons: K8sAddonView[] | null;
  insights: K8sInsightView[] | null;
  removedApis: K8sRemovedUse[] | null;
  nextVersion: string | null;
  skew: K8sSkew[];
  gaps: K8sGap[];
}

/** 화면 안에서 객체 하나를 가리킨다(프론트 전용) */
export interface ObjectRef {
  kind: K8sKindRef;
  namespace: string | null;
  name: string;
}
```

In `src/k8s/targets.ts`, add:

```ts
/** 종류를 가리키는 키(감시 키, 쿼리 키에 쓴다) */
export const kindKey = (k: K8sKindRef) => `${k.group}/${k.version}/${k.plural}`;
```

In `src/k8s/useK8sWatch.ts`, import `kindKey` from `./targets` and build the key as `` `${tk}|${context}|${kindKey(kind)}|${namespace ?? "*"}` `` (same string as before).

In `src/k8s/api.ts`, extend the import with `K8sKind, K8sObjectView, K8sOverview, K8sSecretValue` and add to `k8sApi`:

```ts
  kinds: (target: K8sTarget, ssoProfile: string) => invoke<K8sKind[]>("k8s_kinds", { target, profile: ssoProfile }),
  get: (target: K8sTarget, kind: K8sKindRef, namespace: string | null, name: string, ssoProfile: string) =>
    invoke<K8sObjectView>("k8s_get", { target, kind, namespace, name, profile: ssoProfile }),
  /** Secret 키 하나의 값. 부른 쪽이 컴포넌트 상태에만 둔다(쿼리 캐시에 넣지 않는다) */
  secretValue: (target: K8sTarget, namespace: string, name: string, key: string, ssoProfile: string) =>
    invoke<K8sSecretValue>("k8s_secret_value", { target, namespace, name, key, profile: ssoProfile }),
  /** 개요가 던지는 오류는 앱 프로필의 AWS 설정에서만 나온다(쿠버네티스 쪽 실패는 gaps에 담긴다) */
  overview: (target: K8sTarget) => invoke<K8sOverview>("k8s_overview", { target, profile: target.profile }),
```

In `src/k8s/queries.ts`, import `kindKey` from `./targets` and `K8sKind, K8sObjectView, K8sOverview, ObjectRef` from `./types`, extend `k8sKeys`:

```ts
  kinds: (t: K8sTarget, context: string | null) => ["k8s", targetKey(t), "kinds", context] as const,
  object: (t: K8sTarget, context: string | null, ref: ObjectRef, resourceVersion: string | null) =>
    ["k8s", targetKey(t), "object", context, kindKey(ref.kind), ref.namespace, ref.name, resourceVersion] as const,
  overview: (t: K8sTarget, context: string | null) => ["k8s", targetKey(t), "overview", context] as const,
```

and add the hooks:

```ts
/** 클러스터가 내주는 종류. 연결이 바뀌면 refreshK8s가 지운다. */
export function useK8sKinds(target: K8sTarget, context: string | null, ssoProfile: string, enabled: boolean) {
  return useQuery<K8sKind[], AppError>({
    queryKey: k8sKeys.kinds(target, context),
    queryFn: () => k8sApi.kinds(target, ssoProfile),
    enabled: enabled && context !== null,
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * 객체 상세. 목록의 resourceVersion을 키에 넣어, 목록이 바뀌면 상세도 다시 읽는다.
 * 목록 밖의 객체(소유자로 옮겨 간 것)는 resourceVersion이 null이라 30초 동안만 그대로 쓴다.
 */
export function useK8sObject(target: K8sTarget, context: string | null, ref: ObjectRef | null, resourceVersion: string | null, ssoProfile: string, enabled: boolean) {
  return useQuery<K8sObjectView, AppError>({
    queryKey: ref ? k8sKeys.object(target, context, ref, resourceVersion) : ["k8s", targetKey(target), "object", "none"],
    queryFn: () => k8sApi.get(target, ref!.kind, ref!.namespace, ref!.name, ssoProfile),
    enabled: enabled && ref !== null && context !== null,
    staleTime: resourceVersion === null ? 30_000 : Infinity,
    retry: false,
  });
}

export function useK8sOverview(target: K8sTarget, context: string | null, ssoProfile: string, enabled: boolean) {
  return useQuery<K8sOverview, AppError>({
    queryKey: k8sKeys.overview(target, context),
    queryFn: () => k8sApi.overview(target),
    enabled: enabled && context !== null,
    staleTime: 60_000,
    retry: false,
  });
}
```

(`ssoProfile` is unused by `useK8sOverview`'s query function by design; keep the parameter so every hook has the same shape, and name it `_ssoProfile` if the linter flags it.)

Append to `src/k8s/text.ts`:

```ts
// K2
export const NAV_OVERVIEW = "개요";
export const NAV_WORKLOADS = "워크로드";
export const NAV_EVENTS = "이벤트";

export const CAT_WORKLOADS = "워크로드";
export const CAT_NETWORK = "네트워크";
export const CAT_CONFIG = "설정";
export const CAT_STORAGE = "저장소";
export const CAT_CLUSTER = "클러스터";
export const CAT_CUSTOM = "사용자 정의 리소스";
export const KIND_TREE_LABEL = "리소스 종류";

export const FILTER_PLACEHOLDER = "이름 또는 레이블 셀렉터(app=web,tier!=db)";
export const ONLY_PROBLEMS = "문제 있는 것만";
export const LIST_EMPTY = "항목이 없어요";
export const LIST_NO_MATCH = "조건에 맞는 항목이 없어요";
export const BAD_SELECTOR = "레이블 셀렉터를 해석하지 못했어요";
export const LOADING = "불러오는 중…";

export const COL_NAME = "이름";
export const COL_NAMESPACE = "네임스페이스";
export const COL_PROBLEMS = "이상";
export const COL_AGE = "나이";
/** 종류별 값의 열 이름. 키는 백엔드 read/values.rs의 키와 같다 */
export const COLUMN_LABELS: Record<string, string> = {
  ready: "준비", status: "상태", restarts: "재시작", node: "노드", ip: "IP", upToDate: "최신", available: "사용 가능",
  desired: "원하는 수", current: "현재", completions: "완료", schedule: "일정", suspend: "일시정지", active: "실행 중",
  lastSchedule: "마지막 실행", type: "타입", clusterIp: "클러스터 IP", externalIp: "외부 주소", ports: "포트", class: "클래스",
  hosts: "호스트", address: "주소", podSelector: "Pod 셀렉터", policyTypes: "정책 종류", endpoints: "엔드포인트", keys: "키",
  roleArn: "IAM 역할", volume: "볼륨", capacity: "용량", accessModes: "접근 모드", storageClass: "스토리지 클래스",
  reclaimPolicy: "회수 정책", claim: "클레임", provisioner: "프로비저너", volumeBindingMode: "바인딩 모드", default: "기본",
  version: "kubelet", instanceType: "인스턴스 타입", zone: "AZ", group: "노드그룹",
};
export const PROBLEM_LABELS: Record<K8sProblem, string> = {
  crashLoopBackOff: "CrashLoopBackOff",
  imagePullBackOff: "ImagePullBackOff",
  pending: "Pending",
  oomKilled: "OOMKilled",
  notReady: "준비 안 됨",
};

export const TAB_SUMMARY = "요약";
export const TAB_YAML = "YAML";
export const SEC_OWNERS = "소유자";
export const SEC_CHILDREN = "소유한 리소스";
export const SEC_CONTAINERS = "컨테이너";
export const SEC_CONDITIONS = "상태 조건";
export const SEC_EVENTS = "이벤트";
export const SEC_LABELS = "레이블";
export const SEC_ANNOTATIONS = "어노테이션";
export const SEC_SECRET_KEYS = "Secret 키";
export const BACK = "← 뒤로";
export const CLOSE = "닫기";
export const openNode = (name: string) => `노드 ${name} 보기`;
export const OPEN_IN_IAM = "IAM에서 열기";
export const CREATED_AT = "만든 시각";
export const CHILDREN_TRUNCATED = "처음 500개만 보여줘요";
export const NO_RECENT_EVENTS = "최근 이벤트가 없어요";
export const H_IMAGE = "이미지";
export const H_STATE = "상태";
export const H_RESTARTS = "재시작";
export const H_LAST_TERMINATION = "마지막 종료";
export const INIT_MARK = "init";
export const H_KIND = "종류";
export const H_REASON = "이유";
export const H_MESSAGE = "메시지";
export const YAML_SECRET_NOTE = "Secret 값은 ••••로 가렸어요";
export const DETAIL_LABEL = "상세";

export const H_KEY = "키";
export const H_SIZE = "크기";
export const H_VALUE = "값";
export const byteSize = (n: number) => `${n}바이트`;
export const SHOW_VALUE = "값 보기";
export const HIDE_VALUE = "숨기기";
export const BASE64_NOTE = "텍스트가 아니라서 base64로 보여줘요";
export const NO_SECRET_PERMISSION = "이 네임스페이스의 secrets get 권한이 없어요";

export const WARNINGS_ONLY = "Warning만 보기";
export const H_TIME = "시각";
export const H_OBJECT = "대상";
export const H_COUNT = "횟수";
export const NO_EVENTS = "이벤트가 없어요";

export const SEC_CLUSTER = "클러스터";
export const SEC_NODES = "노드";
export const SEC_NODEGROUPS = "노드그룹";
export const SEC_FARGATE = "Fargate 프로필";
export const SEC_NODEPOOLS = "Karpenter NodePool";
export const SEC_ADDONS = "애드온";
export const SEC_UPGRADE = "업그레이드 점검";
export const REFRESH = "새로 고침";
export const L_VERSION = "버전";
export const L_PLATFORM = "플랫폼 버전";
export const L_STATUS = "상태";
export const L_ENDPOINT = "엔드포인트";
export const L_PUBLIC = "퍼블릭";
export const L_PRIVATE = "프라이빗";
export const L_CIDRS = "허용 CIDR";
export const L_LOGGING = "컨트롤 플레인 로깅";
export const L_SECRETS_ENCRYPTION = "Secret 암호화";
export const L_OIDC = "OIDC 공급자";
export const L_AUTH_MODE = "인증 모드";
export const ON = "켜짐";
export const OFF = "꺼짐";
export const NONE = "없음";
export const H_INSTANCE_TYPE = "인스턴스 타입";
export const H_ZONE = "AZ";
export const H_NODEGROUP = "노드그룹";
export const H_KUBELET = "kubelet";
export const H_CPU_REQUESTED = "CPU 요청";
export const H_MEMORY_REQUESTED = "메모리 요청";
export const H_CPU_USED = "CPU 사용";
export const H_MEMORY_USED = "메모리 사용";
export const GROUP_KIND_LABELS: Record<K8sGroupKind, string> = { managed: "관리형", fargate: "Fargate", karpenter: "Karpenter", self: "자체 관리" };
export const CORDONED = "스케줄 중지";
export const NO_METRICS = "metrics-server가 없어 사용량은 보여주지 않아요";
export const REQUESTS_PARTIAL = "Pod가 많아 요청량은 처음 10,000개 Pod로만 계산했어요";
export const H_VERSION = "버전";
export const H_CAPACITY_TYPE = "용량 타입";
export const H_SIZE_RANGE = "크기(최소/원하는/최대)";
export const H_ADDON = "애드온";
export const H_CURRENT_VERSION = "현재 버전";
export const H_LATEST_VERSION = "최신 버전";
export const H_ISSUES = "문제";
export const UP_TO_DATE = "최신이에요";
export const SUB_INSIGHTS = "Upgrade Insights";
export const SUB_REMOVED = "제거되는 API";
export const SUB_SKEW = "버전 차이";
export const H_CHECK = "점검";
export const NO_INSIGHTS = "Upgrade Insights 결과가 없어요";
export const removedTitle = (version: string) => `${version}에서 제거되는 API를 쓰는 리소스`;
export const H_CURRENT_API = "지금 API";
export const H_NEW_API = "바꿀 API";
export const noRemoved = (version: string) => `${version}에서 제거되는 API를 쓰는 리소스가 없어요`;
export const skewText = (n: number) => `컨트롤 플레인보다 ${n} 마이너 버전 낮아요`;
export const NO_SKEW = "모든 노드가 컨트롤 플레인과 같은 버전이에요";
export const gapText = (section: string) => `이 부분을 읽지 못했어요: ${section}`;
export const SECTION_LABELS: Record<K8sOverviewSection, string> = {
  cluster: "클러스터", nodes: "노드", metrics: "사용량", nodegroups: "노드그룹", fargate: "Fargate 프로필",
  nodePools: "Karpenter NodePool", addons: "애드온", insights: "Upgrade Insights", removedApis: "제거되는 API",
};
```

At the top of `text.ts`, add `import type { K8sGroupKind, K8sOverviewSection, K8sProblem } from "./types";`.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run src/k8s && npx tsc --noEmit`
Expected: all pass, no type errors. Existing tests that build `K8sRow` literals without `problems` fail `tsc`; add `problems: []` to those fixtures (`K8sTab.test.tsx` `ns()`, `watchRegistry.test.ts` `row()`, `useK8sWatch.test.tsx`).

- [ ] **Step 5: Commit**

```bash
git add src/k8s/types.ts src/k8s/text.ts src/k8s/api.ts src/k8s/api.test.ts src/k8s/queries.ts src/k8s/queries.test.tsx src/k8s/targets.ts src/k8s/targets.test.ts src/k8s/useK8sWatch.ts src/k8s/K8sTab.test.tsx src/k8s/watchRegistry.test.ts src/k8s/useK8sWatch.test.tsx
git commit -m "feat(k8s): frontend types, strings, API and queries for overview, kinds, detail and Secret values

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task K2-F2: Kind catalog, label selectors, list columns, number formats

**Files:**
- Create: `src/k8s/kinds.ts`, `src/k8s/kinds.test.ts`, `src/k8s/selector.ts`, `src/k8s/selector.test.ts`, `src/k8s/format.ts`, `src/k8s/format.test.ts`, `src/k8s/columns.tsx`, `src/k8s/columns.test.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: Task K2-F1 (`kindKey`, types, `COLUMN_LABELS`, `PROBLEM_LABELS`, `COL_*`, `CAT_*`), `ListColumn` from `src/iam/ListTable.tsx`, `NAMESPACES` from `targets.ts`.
- Produces:
  - `kinds.ts`: `PODS, DEPLOYMENTS, STATEFULSETS, DAEMONSETS, REPLICASETS, JOBS, CRONJOBS, SERVICES, INGRESSES, NETWORK_POLICIES, ENDPOINTS, CONFIGMAPS, SECRETS, SERVICE_ACCOUNTS, PVCS, PVS, STORAGE_CLASSES, NODES, EVENTS: K8sKindRef`; `interface KindCategory { id: string; label: string; kinds: K8sKindRef[] }`; `CATEGORIES: KindCategory[]`; `BUILTIN: K8sKindRef[]`; `customCategories(kinds: K8sKind[]): KindCategory[]`; `resolveLink(link: { group: string; kind: string }, kinds: K8sKind[]): K8sKindRef | null`; `sameKind(a: K8sKindRef, b: K8sKindRef): boolean`; `isSecret(k: K8sKindRef): boolean`; `isPod(k)`, `isServiceAccount(k)`
  - `selector.ts`: `type Requirement = { key: string; op: "=" | "!=" | "in" | "notin" | "exists" | "!exists"; values: string[] }`; `type Filter = { kind: "none" } | { kind: "name"; text: string } | { kind: "selector"; reqs: Requirement[] } | { kind: "invalid" }`; `parseSelector(s: string): Requirement[] | null`; `parseFilter(input: string): Filter`; `matchesFilter(row: K8sRow, f: Filter): boolean`
  - `format.ts`: `formatCpu(milli: number): string`, `formatBytes(n: number): string`, `percent(part: number, whole: number): string`, `age(iso: string | null, now: number): string`
  - `columns.tsx`: `valueKeys(kind: K8sKindRef): string[]`, `columnsFor(kind: K8sKindRef, showNamespace: boolean, now: number): ListColumn<K8sRow>[]`, `function Problems({ problems }: { problems: K8sProblem[] }): JSX.Element | null`

A filter is a label selector when it contains `=`, `!`, `(`, or the word ` in `/` notin `; otherwise it matches names (case-insensitive substring).

- [ ] **Step 1: Write the failing tests**

Create `src/k8s/kinds.test.ts`:

```ts
import { BUILTIN, CATEGORIES, DEPLOYMENTS, NODES, SECRETS, customCategories, isSecret, resolveLink, sameKind } from "./kinds";
import { CAT_CLUSTER, CAT_WORKLOADS } from "./text";
import type { K8sKind } from "./types";

const kind = (group: string, k: string, plural: string, custom: boolean, version = "v1"): K8sKind => ({ group, version, kind: k, plural, namespaced: true, verbs: ["list", "watch"], custom });

test("categories hold the spec's built-in kinds", () => {
  expect(CATEGORIES[0].label).toBe(CAT_WORKLOADS);
  expect(CATEGORIES[0].kinds.map((k) => k.kind)).toEqual(["Pod", "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob"]);
  expect(CATEGORIES.find((c) => c.label === CAT_CLUSTER)!.kinds).toContainEqual(NODES);
  expect(BUILTIN).toContainEqual(SECRETS);
  expect(NODES.namespaced).toBe(false);
});

test("custom kinds are grouped by API group", () => {
  const cats = customCategories([kind("b.example.com", "Bee", "bees", true), kind("a.example.com", "Zed", "zeds", true), kind("a.example.com", "Ant", "ants", true), kind("apps", "Deployment", "deployments", false)]);
  expect(cats.map((c) => c.label)).toEqual(["a.example.com", "b.example.com"]);
  expect(cats[0].kinds.map((k) => k.kind)).toEqual(["Ant", "Zed"]);
  expect(cats[0].kinds[0]).toEqual({ group: "a.example.com", version: "v1", kind: "Ant", plural: "ants", namespaced: true });
});

test("links resolve to built-in kinds first, then discovered ones, else null", () => {
  expect(resolveLink({ group: "apps", kind: "Deployment" }, [])).toEqual(DEPLOYMENTS);
  const widget = kind("mm.example.com", "Widget", "widgets", true, "v2");
  expect(resolveLink({ group: "mm.example.com", kind: "Widget" }, [widget])).toEqual({ group: "mm.example.com", version: "v2", kind: "Widget", plural: "widgets", namespaced: true });
  expect(resolveLink({ group: "x.io", kind: "Thing" }, [widget])).toBeNull();
});

test("sameKind and isSecret", () => {
  expect(sameKind(DEPLOYMENTS, { ...DEPLOYMENTS })).toBe(true);
  expect(sameKind(DEPLOYMENTS, SECRETS)).toBe(false);
  expect(isSecret(SECRETS)).toBe(true);
  expect(isSecret(DEPLOYMENTS)).toBe(false);
});
```

Create `src/k8s/selector.test.ts`:

```ts
import { matchesFilter, parseFilter, parseSelector } from "./selector";
import type { K8sRow } from "./types";

const row = (name: string, labels: Record<string, string>): K8sRow => ({ uid: name, name, namespace: "web", resourceVersion: "1", createdAt: null, labels, values: {}, problems: [] });

test("parses equality, set and existence requirements", () => {
  expect(parseSelector("app=web, tier!=db")).toEqual([
    { key: "app", op: "=", values: ["web"] },
    { key: "tier", op: "!=", values: ["db"] },
  ]);
  expect(parseSelector("app==web")).toEqual([{ key: "app", op: "=", values: ["web"] }]);
  expect(parseSelector("env in (prod, stage),team notin (x)")).toEqual([
    { key: "env", op: "in", values: ["prod", "stage"] },
    { key: "team", op: "notin", values: ["x"] },
  ]);
  expect(parseSelector("app.kubernetes.io/name,!canary")).toEqual([
    { key: "app.kubernetes.io/name", op: "exists", values: [] },
    { key: "canary", op: "!exists", values: [] },
  ]);
});

test("rejects malformed selectors", () => {
  for (const bad of ["app=", "=web", "app=web,", "env in ()", "env in (a", "a b", "app=we b", "-bad=x"]) {
    expect(parseSelector(bad)).toBeNull();
  }
});

test("parseFilter decides between a name and a selector", () => {
  expect(parseFilter("  ")).toEqual({ kind: "none" });
  expect(parseFilter("Api")).toEqual({ kind: "name", text: "api" });
  expect(parseFilter("app=web")).toEqual({ kind: "selector", reqs: [{ key: "app", op: "=", values: ["web"] }] });
  expect(parseFilter("env in (a)")).toEqual({ kind: "selector", reqs: [{ key: "env", op: "in", values: ["a"] }] });
  expect(parseFilter("app=")).toEqual({ kind: "invalid" });
});

test("matches rows", () => {
  const r = row("api-7d", { app: "web", env: "prod" });
  expect(matchesFilter(r, parseFilter("API"))).toBe(true);
  expect(matchesFilter(r, parseFilter("app=web,env in (prod)"))).toBe(true);
  expect(matchesFilter(r, parseFilter("app!=web"))).toBe(false);
  // 키가 없으면 != 와 notin 은 맞는다(쿠버네티스와 같다)
  expect(matchesFilter(r, parseFilter("tier!=db,tier notin (db)"))).toBe(true);
  expect(matchesFilter(r, parseFilter("!env"))).toBe(false);
  expect(matchesFilter(r, parseFilter("env"))).toBe(true);
  expect(matchesFilter(r, { kind: "none" })).toBe(true);
  expect(matchesFilter(r, { kind: "invalid" })).toBe(true);
});
```

Create `src/k8s/format.test.ts`:

```ts
import { age, formatBytes, formatCpu, percent } from "./format";

test("cpu", () => {
  expect(formatCpu(250)).toBe("250m");
  expect(formatCpu(2000)).toBe("2");
  expect(formatCpu(1500)).toBe("1.5");
  expect(formatCpu(0)).toBe("0");
});

test("bytes", () => {
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(1536)).toBe("1.5 KiB");
  expect(formatBytes(64 * 1024 * 1024)).toBe("64 MiB");
  expect(formatBytes(7.5 * 1024 ** 3)).toBe("7.5 GiB");
});

test("percent", () => {
  expect(percent(1, 4)).toBe("25%");
  expect(percent(1, 0)).toBe("–");
});

test("age", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  expect(age("2026-10-30T11:59:20Z", now)).toBe("40s");
  expect(age("2026-10-30T11:15:00Z", now)).toBe("45m");
  expect(age("2026-10-29T00:00:00Z", now)).toBe("36h");
  expect(age("2026-10-20T12:00:00Z", now)).toBe("10d");
  expect(age(null, now)).toBe("");
});
```

Create `src/k8s/columns.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { Problems, columnsFor, valueKeys } from "./columns";
import { DEPLOYMENTS, NODES, PODS, SECRETS } from "./kinds";
import { COL_AGE, COL_NAME, COL_NAMESPACE, COL_PROBLEMS, COLUMN_LABELS, PROBLEM_LABELS } from "./text";
import type { K8sRow } from "./types";

const widget = { group: "mm.example.com", version: "v1", kind: "Widget", plural: "widgets", namespaced: true };

test("value keys per kind", () => {
  expect(valueKeys(PODS)).toEqual(["ready", "status", "restarts", "node", "ip"]);
  expect(valueKeys(DEPLOYMENTS)).toEqual(["ready", "upToDate", "available"]);
  expect(valueKeys(SECRETS)).toEqual(["type", "keys"]);
  expect(valueKeys(NODES)).toEqual(["status", "version", "instanceType", "zone", "group"]);
  expect(valueKeys(widget)).toEqual(["ready"]);
});

test("columns: name, namespace when all namespaces, values, problems, age", () => {
  const labels = (cols: ReturnType<typeof columnsFor>) => cols.map((c) => c.label);
  expect(labels(columnsFor(DEPLOYMENTS, true, 0))).toEqual([COL_NAME, COL_NAMESPACE, COLUMN_LABELS.ready, COLUMN_LABELS.upToDate, COLUMN_LABELS.available, COL_PROBLEMS, COL_AGE]);
  expect(labels(columnsFor(DEPLOYMENTS, false, 0))).not.toContain(COL_NAMESPACE);
  expect(labels(columnsFor(NODES, true, 0))).not.toContain(COL_NAMESPACE);
});

test("problems render as labelled badges", () => {
  render(<Problems problems={["crashLoopBackOff", "notReady"]} />);
  expect(screen.getByText(PROBLEM_LABELS.crashLoopBackOff)).toBeInTheDocument();
  expect(screen.getByText(PROBLEM_LABELS.notReady)).toBeInTheDocument();
});

test("age column sorts by creation time and renders relative age", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  const ageCol = columnsFor(PODS, false, now).find((c) => c.key === "age")!;
  const r: K8sRow = { uid: "u", name: "p", namespace: "web", resourceVersion: "1", createdAt: "2026-10-30T11:00:00Z", labels: {}, values: {}, problems: [] };
  expect(ageCol.sort!(r)).toBe(Date.parse("2026-10-30T11:00:00Z"));
  render(<>{ageCol.render(r)}</>);
  expect(screen.getByText("60m")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run src/k8s/kinds.test.ts src/k8s/selector.test.ts src/k8s/format.test.ts src/k8s/columns.test.tsx`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

Create `src/k8s/kinds.ts`:

```ts
import { NAMESPACES, kindKey } from "./targets";
import { CAT_CLUSTER, CAT_CONFIG, CAT_NETWORK, CAT_STORAGE, CAT_WORKLOADS } from "./text";
import type { K8sKind, K8sKindRef } from "./types";

const ref = (group: string, version: string, kind: string, plural: string, namespaced = true): K8sKindRef => ({ group, version, kind, plural, namespaced });

export const PODS = ref("", "v1", "Pod", "pods");
export const DEPLOYMENTS = ref("apps", "v1", "Deployment", "deployments");
export const STATEFULSETS = ref("apps", "v1", "StatefulSet", "statefulsets");
export const DAEMONSETS = ref("apps", "v1", "DaemonSet", "daemonsets");
export const REPLICASETS = ref("apps", "v1", "ReplicaSet", "replicasets");
export const JOBS = ref("batch", "v1", "Job", "jobs");
export const CRONJOBS = ref("batch", "v1", "CronJob", "cronjobs");
export const SERVICES = ref("", "v1", "Service", "services");
export const INGRESSES = ref("networking.k8s.io", "v1", "Ingress", "ingresses");
export const NETWORK_POLICIES = ref("networking.k8s.io", "v1", "NetworkPolicy", "networkpolicies");
export const ENDPOINTS = ref("", "v1", "Endpoints", "endpoints");
export const CONFIGMAPS = ref("", "v1", "ConfigMap", "configmaps");
export const SECRETS = ref("", "v1", "Secret", "secrets");
export const SERVICE_ACCOUNTS = ref("", "v1", "ServiceAccount", "serviceaccounts");
export const PVCS = ref("", "v1", "PersistentVolumeClaim", "persistentvolumeclaims");
export const PVS = ref("", "v1", "PersistentVolume", "persistentvolumes", false);
export const STORAGE_CLASSES = ref("storage.k8s.io", "v1", "StorageClass", "storageclasses", false);
export const NODES = ref("", "v1", "Node", "nodes", false);
export const EVENTS = ref("", "v1", "Event", "events");

export interface KindCategory {
  id: string;
  label: string;
  kinds: K8sKindRef[];
}

/** 설계의 워크로드 트리(내장 종류). 사용자 정의 리소스는 customCategories로 뒤에 붙인다. */
export const CATEGORIES: KindCategory[] = [
  { id: "workloads", label: CAT_WORKLOADS, kinds: [PODS, DEPLOYMENTS, STATEFULSETS, DAEMONSETS, REPLICASETS, JOBS, CRONJOBS] },
  { id: "network", label: CAT_NETWORK, kinds: [SERVICES, INGRESSES, NETWORK_POLICIES, ENDPOINTS] },
  { id: "config", label: CAT_CONFIG, kinds: [CONFIGMAPS, SECRETS, SERVICE_ACCOUNTS] },
  { id: "storage", label: CAT_STORAGE, kinds: [PVCS, PVS, STORAGE_CLASSES] },
  { id: "cluster", label: CAT_CLUSTER, kinds: [NAMESPACES, NODES] },
];

export const BUILTIN: K8sKindRef[] = CATEGORIES.flatMap((c) => c.kinds);

export const sameKind = (a: K8sKindRef, b: K8sKindRef) => kindKey(a) === kindKey(b);
export const isSecret = (k: K8sKindRef) => k.group === "" && k.kind === "Secret";
export const isPod = (k: K8sKindRef) => k.group === "" && k.kind === "Pod";
export const isServiceAccount = (k: K8sKindRef) => k.group === "" && k.kind === "ServiceAccount";

const strip = ({ group, version, kind, plural, namespaced }: K8sKindRef): K8sKindRef => ({ group, version, kind, plural, namespaced });

/** 사용자 정의 리소스를 API 그룹마다 묶는다(그룹, 종류 이름 순서) */
export function customCategories(kinds: K8sKind[]): KindCategory[] {
  const groups = new Map<string, K8sKindRef[]>();
  for (const k of kinds.filter((k) => k.custom)) groups.set(k.group, [...(groups.get(k.group) ?? []), strip(k)]);
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, list]) => ({ id: `custom:${group}`, label: group, kinds: list.sort((a, b) => a.kind.localeCompare(b.kind)) }));
}

/** 소유 관계 링크(그룹·종류)를 열 수 있는 종류로. 내장 → 발견한 종류 순서, 없으면 null(글로만 보인다). */
export function resolveLink(link: { group: string; kind: string }, kinds: K8sKind[]): K8sKindRef | null {
  const builtin = BUILTIN.find((k) => k.group === link.group && k.kind === link.kind);
  if (builtin) return builtin;
  const found = kinds.find((k) => k.group === link.group && k.kind === link.kind);
  return found ? strip(found) : null;
}
```

Create `src/k8s/selector.ts`:

```ts
import type { K8sRow } from "./types";

export type Requirement = { key: string; op: "=" | "!=" | "in" | "notin" | "exists" | "!exists"; values: string[] };
export type Filter = { kind: "none" } | { kind: "name"; text: string } | { kind: "selector"; reqs: Requirement[] } | { kind: "invalid" };

// 쿠버네티스 레이블 키(접두사/이름)와 값의 모양
const KEY = /^([a-z0-9]([-a-z0-9.]*[a-z0-9])?\/)?[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/;
const VALUE = /^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$/;
const SET = /^(\S+)\s+(in|notin)\s*\(([^()]*)\)$/;
const EQ = /^([^=!\s]+)\s*(==|=|!=)\s*(\S+)$/;
const NOT = /^!\s*(\S+)$/;

/** 괄호 밖의 쉼표로 나눈다 */
function split(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function requirement(t: string): Requirement | null {
  let m = SET.exec(t);
  if (m) {
    const values = m[3].split(",").map((v) => v.trim());
    if (values.some((v) => v === "" || !VALUE.test(v)) || !KEY.test(m[1])) return null;
    return { key: m[1], op: m[2] as "in" | "notin", values };
  }
  m = EQ.exec(t);
  if (m) {
    if (!KEY.test(m[1]) || !VALUE.test(m[3])) return null;
    return { key: m[1], op: m[2] === "!=" ? "!=" : "=", values: [m[3]] };
  }
  m = NOT.exec(t);
  if (m) return KEY.test(m[1]) ? { key: m[1], op: "!exists", values: [] } : null;
  return KEY.test(t) ? { key: t, op: "exists", values: [] } : null;
}

/** kubectl -l 과 같은 문법. 하나라도 틀리면 null */
export function parseSelector(s: string): Requirement[] | null {
  const reqs: Requirement[] = [];
  for (const t of split(s)) {
    const r = t === "" ? null : requirement(t);
    if (!r) return null;
    reqs.push(r);
  }
  return reqs;
}

export function parseFilter(input: string): Filter {
  const t = input.trim();
  if (t === "") return { kind: "none" };
  if (!/[=!(]/.test(t) && !/\s(in|notin)\s/.test(t)) return { kind: "name", text: t.toLowerCase() };
  const reqs = parseSelector(t);
  return reqs ? { kind: "selector", reqs } : { kind: "invalid" };
}

function matches(labels: Record<string, string>, r: Requirement): boolean {
  const has = Object.prototype.hasOwnProperty.call(labels, r.key);
  const v = labels[r.key];
  switch (r.op) {
    case "=":
      return has && v === r.values[0];
    case "!=":
      return !has || v !== r.values[0];
    case "in":
      return has && r.values.includes(v);
    case "notin":
      return !has || !r.values.includes(v);
    case "exists":
      return has;
    case "!exists":
      return !has;
  }
}

/** 해석하지 못한 필터는 거르지 않는다(화면이 오류를 따로 보여 준다) */
export function matchesFilter(row: K8sRow, f: Filter): boolean {
  if (f.kind === "name") return row.name.toLowerCase().includes(f.text);
  if (f.kind === "selector") return f.reqs.every((r) => matches(row.labels, r));
  return true;
}
```

Create `src/k8s/format.ts`:

```ts
/** 밀리코어를 kubectl처럼: 1코어 밑은 m, 위는 코어 수(소수 한 자리) */
export function formatCpu(milli: number): string {
  if (milli < 1000) return `${milli}m`.replace(/^0m$/, "0");
  const cores = milli / 1000;
  return Number.isInteger(cores) ? `${cores}` : cores.toFixed(1);
}

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];

export function formatBytes(n: number): string {
  let v = n;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const shown = Number.isInteger(v) ? `${v}` : v.toFixed(1);
  return `${shown} ${UNITS[i]}`;
}

export function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "–";
}

/** kubectl의 AGE처럼 짧게: 초, 분, 시간(48시간까지), 일 */
export function age(iso: string | null, now: number): string {
  if (!iso) return "";
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
```

Create `src/k8s/columns.tsx`:

```tsx
import type { ListColumn } from "../iam/ListTable";
import { age } from "./format";
import { BUILTIN, sameKind } from "./kinds";
import { kindKey } from "./targets";
import { COL_AGE, COL_NAME, COL_NAMESPACE, COL_PROBLEMS, COLUMN_LABELS, PROBLEM_LABELS } from "./text";
import type { K8sKindRef, K8sProblem, K8sRow } from "./types";

/** 종류별 값 열. 키는 백엔드 read/values.rs가 채우는 키다. */
const KIND_COLUMNS: Record<string, string[]> = {
  "/v1/pods": ["ready", "status", "restarts", "node", "ip"],
  "apps/v1/deployments": ["ready", "upToDate", "available"],
  "apps/v1/statefulsets": ["ready"],
  "apps/v1/daemonsets": ["desired", "current", "ready", "upToDate", "available"],
  "apps/v1/replicasets": ["desired", "current", "ready"],
  "batch/v1/jobs": ["completions", "status"],
  "batch/v1/cronjobs": ["schedule", "suspend", "active", "lastSchedule"],
  "/v1/services": ["type", "clusterIp", "externalIp", "ports"],
  "networking.k8s.io/v1/ingresses": ["class", "hosts", "address"],
  "networking.k8s.io/v1/networkpolicies": ["podSelector", "policyTypes"],
  "/v1/endpoints": ["endpoints"],
  "/v1/configmaps": ["keys"],
  "/v1/secrets": ["type", "keys"],
  "/v1/serviceaccounts": ["roleArn"],
  "/v1/persistentvolumeclaims": ["status", "volume", "capacity", "accessModes", "storageClass"],
  "/v1/persistentvolumes": ["capacity", "accessModes", "reclaimPolicy", "status", "claim", "storageClass"],
  "storage.k8s.io/v1/storageclasses": ["provisioner", "reclaimPolicy", "volumeBindingMode", "default"],
  "/v1/namespaces": ["status"],
  "/v1/nodes": ["status", "version", "instanceType", "zone", "group"],
};

/** 내장 종류는 표대로, 그 밖의 종류(사용자 정의)는 Ready 조건 하나 */
export function valueKeys(kind: K8sKindRef): string[] {
  const known = KIND_COLUMNS[kindKey(kind)];
  if (known) return known;
  return BUILTIN.some((b) => sameKind(b, kind)) ? [] : ["ready"];
}

export function Problems({ problems }: { problems: K8sProblem[] }) {
  if (problems.length === 0) return null;
  return (
    <span className="k8s-problems">
      {problems.map((p) => (
        <span key={p} className="k8s-problem">
          {PROBLEM_LABELS[p]}
        </span>
      ))}
    </span>
  );
}

export function columnsFor(kind: K8sKindRef, showNamespace: boolean, now: number): ListColumn<K8sRow>[] {
  const cols: ListColumn<K8sRow>[] = [{ key: "name", label: COL_NAME, render: (r) => <span className="mono">{r.name}</span>, sort: (r) => r.name }];
  if (showNamespace && kind.namespaced) cols.push({ key: "namespace", label: COL_NAMESPACE, render: (r) => r.namespace ?? "", sort: (r) => r.namespace ?? "" });
  for (const key of valueKeys(kind)) {
    cols.push({ key: `v:${key}`, label: COLUMN_LABELS[key] ?? key, render: (r) => r.values[key] ?? "", sort: (r) => r.values[key] ?? null });
  }
  cols.push({ key: "problems", label: COL_PROBLEMS, render: (r) => <Problems problems={r.problems} />, sort: (r) => r.problems.length });
  cols.push({ key: "age", label: COL_AGE, render: (r) => age(r.createdAt, now), sort: (r) => (r.createdAt ? Date.parse(r.createdAt) : null) });
  return cols;
}
```

Append to `src/styles.css` (after the K1 `.k8s-*` rules):

```css
.k8s-problems { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.k8s-problem { background: #ff453a26; color: var(--red); border-radius: 9px; padding: 0 7px; font-size: 11px; white-space: nowrap; }
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run src/k8s && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/k8s/kinds.ts src/k8s/kinds.test.ts src/k8s/selector.ts src/k8s/selector.test.ts src/k8s/format.ts src/k8s/format.test.ts src/k8s/columns.tsx src/k8s/columns.test.tsx src/styles.css
git commit -m "feat(k8s): kind catalog, label selector filter, list columns and number formats

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task K2-F3: Kind tree and object list

**Files:**
- Create: `src/k8s/KindTree.tsx`, `src/k8s/KindTree.test.tsx`, `src/k8s/ObjectList.tsx`, `src/k8s/ObjectList.test.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: Task K2-F2 (`KindCategory`, `sameKind`, `parseFilter`, `matchesFilter`, `columnsFor`), `ListTable` (`src/iam/ListTable.tsx`), K2-F1 strings.
- Produces:
  - `function KindTree(props: { categories: KindCategory[]; selected: K8sKindRef; onSelect: (k: K8sKindRef) => void }): JSX.Element`
  - `function ObjectList(props: { kind: K8sKindRef; rows: K8sRow[]; status: "loading" | "ready" | "error"; showNamespace: boolean; selectedUid: string | null; onSelect: (row: K8sRow) => void; now?: number }): JSX.Element` (presentational: the watch lives in `WorkloadsView`, Task K2-F5)

- [ ] **Step 1: Write the failing tests**

Create `src/k8s/KindTree.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { KindTree } from "./KindTree";
import { CATEGORIES, DEPLOYMENTS, PODS } from "./kinds";
import { CAT_WORKLOADS, KIND_TREE_LABEL } from "./text";

test("shows categories, marks the selected kind, and selects on click", () => {
  const onSelect = vi.fn();
  render(<KindTree categories={CATEGORIES} selected={PODS} onSelect={onSelect} />);
  expect(screen.getByRole("navigation", { name: KIND_TREE_LABEL })).toBeInTheDocument();
  expect(screen.getByText(CAT_WORKLOADS)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Pod" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("button", { name: "Deployment" })).not.toHaveAttribute("aria-current");
  fireEvent.click(screen.getByRole("button", { name: "Deployment" }));
  expect(onSelect).toHaveBeenCalledWith(DEPLOYMENTS);
});
```

Create `src/k8s/ObjectList.test.tsx`:

```tsx
import { fireEvent, render, screen, within } from "@testing-library/react";
import { DEPLOYMENTS, PODS } from "./kinds";
import { ObjectList } from "./ObjectList";
import { BAD_SELECTOR, COL_NAMESPACE, FILTER_PLACEHOLDER, LIST_EMPTY, LIST_NO_MATCH, LOADING, ONLY_PROBLEMS, PROBLEM_LABELS } from "./text";
import type { K8sProblem, K8sRow } from "./types";

const row = (name: string, labels: Record<string, string> = {}, problems: K8sProblem[] = []): K8sRow => ({
  uid: `u-${name}`, name, namespace: "web", resourceVersion: "1", createdAt: null, labels, values: { ready: "1/1", status: "Running" }, problems,
});
const rows = [row("api", { app: "api" }), row("worker", { app: "worker" }, ["crashLoopBackOff"])];

function setup(over: Partial<Parameters<typeof ObjectList>[0]> = {}) {
  const onSelect = vi.fn();
  render(<ObjectList kind={PODS} rows={rows} status="ready" showNamespace={false} selectedUid={null} onSelect={onSelect} now={0} {...over} />);
  return { onSelect };
}
const names = () => screen.queryAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[0].textContent);
const filter = (text: string) => fireEvent.change(screen.getByRole("searchbox", { name: FILTER_PLACEHOLDER }), { target: { value: text } });

test("lists rows with the kind's columns and problem badges", () => {
  setup();
  expect(names()).toEqual(["api", "worker"]);
  expect(screen.getAllByText("Running")).toHaveLength(2);
  expect(screen.getByText(PROBLEM_LABELS.crashLoopBackOff)).toBeInTheDocument();
  expect(screen.queryByRole("columnheader", { name: new RegExp(COL_NAMESPACE) })).toBeNull();
});

test("namespace column only when all namespaces are shown", () => {
  setup({ showNamespace: true, kind: DEPLOYMENTS });
  expect(screen.getByRole("columnheader", { name: new RegExp(COL_NAMESPACE) })).toBeInTheDocument();
});

test("filters by name, by label selector, and by problems", () => {
  setup();
  filter("WORK");
  expect(names()).toEqual(["worker"]);
  filter("app=api");
  expect(names()).toEqual(["api"]);
  filter("");
  fireEvent.click(screen.getByRole("checkbox", { name: ONLY_PROBLEMS }));
  expect(names()).toEqual(["worker"]);
});

test("a bad selector is reported and does not hide rows", () => {
  setup();
  filter("app=");
  expect(screen.getByText(BAD_SELECTOR)).toBeInTheDocument();
  expect(names()).toEqual(["api", "worker"]);
});

test("empty and no-match messages", () => {
  setup({ rows: [] });
  expect(screen.getByText(LIST_EMPTY)).toBeInTheDocument();
});

test("no match message when the filter hides everything", () => {
  setup();
  filter("nothing-like-this");
  expect(screen.getByText(LIST_NO_MATCH)).toBeInTheDocument();
});

test("loading and selection", () => {
  const { onSelect } = setup({ status: "loading", rows: [] });
  expect(screen.getByText(LOADING)).toBeInTheDocument();
  expect(onSelect).not.toHaveBeenCalled();
});

test("clicking a row selects it", () => {
  const { onSelect } = setup({ selectedUid: "u-api" });
  fireEvent.click(screen.getByText("worker"));
  expect(onSelect).toHaveBeenCalledWith(rows[1]);
  expect(screen.getByText("api").closest("tr")).toHaveAttribute("aria-selected", "true");
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run src/k8s/KindTree.test.tsx src/k8s/ObjectList.test.tsx`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

Create `src/k8s/KindTree.tsx`:

```tsx
import type { KindCategory } from "./kinds";
import { sameKind } from "./kinds";
import { kindKey } from "./targets";
import { KIND_TREE_LABEL } from "./text";
import type { K8sKindRef } from "./types";

interface Props {
  categories: KindCategory[];
  selected: K8sKindRef;
  onSelect: (k: K8sKindRef) => void;
}

/** 워크로드 화면 왼쪽의 종류 트리. 내장 분류 뒤에 사용자 정의 리소스 그룹이 붙는다. */
export function KindTree({ categories, selected, onSelect }: Props) {
  return (
    <nav className="k8s-tree" aria-label={KIND_TREE_LABEL}>
      {categories.map((c) => (
        <div key={c.id} className="k8s-tree-group">
          <div className="k8s-tree-title">{c.label}</div>
          {c.kinds.map((k) => {
            const on = sameKind(k, selected);
            return (
              <button key={kindKey(k)} className={`k8s-tree-item${on ? " on" : ""}`} aria-current={on ? "page" : undefined} onClick={() => onSelect(k)}>
                {k.kind}
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
```

Create `src/k8s/ObjectList.tsx`:

```tsx
import { useMemo, useState } from "react";
import { ListTable } from "../iam/ListTable";
import { columnsFor } from "./columns";
import { matchesFilter, parseFilter } from "./selector";
import { BAD_SELECTOR, FILTER_PLACEHOLDER, LIST_EMPTY, LIST_NO_MATCH, LOADING, ONLY_PROBLEMS } from "./text";
import type { K8sKindRef, K8sRow } from "./types";

interface Props {
  kind: K8sKindRef;
  rows: K8sRow[];
  status: "loading" | "ready" | "error";
  /** 모든 네임스페이스를 보는 중이면 네임스페이스 열을 보인다 */
  showNamespace: boolean;
  selectedUid: string | null;
  onSelect: (row: K8sRow) => void;
  /** 나이 계산 기준(시험용). 없으면 그리는 시각 */
  now?: number;
}

/** 감시로 받은 행을 이름·레이블 셀렉터·이상 여부로 걸러 보여 준다 */
export function ObjectList({ kind, rows, status, showNamespace, selectedUid, onSelect, now }: Props) {
  const [query, setQuery] = useState("");
  const [onlyProblems, setOnlyProblems] = useState(false);
  const filter = parseFilter(query);
  const shown = rows.filter((r) => matchesFilter(r, filter) && (!onlyProblems || r.problems.length > 0));
  const at = now ?? Date.now();
  const columns = useMemo(() => columnsFor(kind, showNamespace, at), [kind, showNamespace, at]);
  const select = (uid: string) => {
    const r = rows.find((x) => x.uid === uid);
    if (r) onSelect(r);
  };
  return (
    <div className="k8s-list">
      <div className="k8s-list-bar">
        <input type="search" className="k8s-filter" aria-label={FILTER_PLACEHOLDER} placeholder={FILTER_PLACEHOLDER} value={query} onChange={(e) => setQuery(e.target.value)} />
        <label className="k8s-check">
          <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
          {ONLY_PROBLEMS}
        </label>
      </div>
      {filter.kind === "invalid" && <p className="err k8s-hint">{BAD_SELECTOR}</p>}
      {status === "loading" ? (
        <div className="empty">{LOADING}</div>
      ) : (
        <ListTable label={kind.kind} rows={shown} columns={columns} rowKey={(r) => r.uid} selectedId={selectedUid} onSelect={select} onOpen={select} empty={rows.length === 0 ? LIST_EMPTY : LIST_NO_MATCH} />
      )}
    </div>
  );
}
```

(`now ?? Date.now()` changes every render; that only re-creates the column definitions. If the linter objects, keep it, the cost is negligible.)

Append to `src/styles.css`:

```css
.k8s-tree { width: 190px; flex: none; overflow: auto; border-right: 1px solid var(--line); padding: 6px; display: flex; flex-direction: column; gap: 8px; }
.k8s-tree-title { color: var(--dim); font-size: 11px; padding: 2px 6px; }
.k8s-tree-item { display: block; width: 100%; text-align: left; padding: 3px 8px; background: none; border: 0; border-radius: 5px; color: inherit; cursor: pointer; }
.k8s-tree-item:hover { background: #ffffff0d; }
.k8s-tree-item.on { background: #ffffff1a; }
.k8s-list { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.k8s-list-bar { display: flex; align-items: center; gap: 10px; padding: 6px 10px; border-bottom: 1px solid var(--line); }
.k8s-filter { flex: 1; min-width: 0; }
.k8s-check { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; white-space: nowrap; }
.k8s-hint { margin: 4px 10px; font-size: 12px; }
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run src/k8s && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/k8s/KindTree.tsx src/k8s/KindTree.test.tsx src/k8s/ObjectList.tsx src/k8s/ObjectList.test.tsx src/styles.css
git commit -m "feat(k8s): kind tree and filterable object list

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task K2-F4: Secret keys and per-key values (component state only)

**Files:**
- Create: `src/k8s/SecretKeys.tsx`, `src/k8s/SecretKeys.test.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `k8sApi.secretValue` (K2-F1), `targetKey`, `ErrorState` (`src/components/ErrorState.tsx`), strings `H_KEY, H_SIZE, H_VALUE, byteSize, SHOW_VALUE, HIDE_VALUE, BASE64_NOTE, NO_SECRET_PERMISSION, SEC_SECRET_KEYS`.
- Produces: `function SecretKeys(props: { target: K8sTarget; ssoProfile: string; namespace: string; name: string; keys: K8sSecretKey[]; canRead: "yes" | "no" | "unknown" }): JSX.Element`

Rules (Global Constraints, Secrets): values live only in this component's `useState`; switching target/namespace/name clears them and bumps a generation counter so a late response for the previous Secret is dropped; unmount drops them; nothing is written to React Query. `canRead === "no"` disables "값 보기" with the title `NO_SECRET_PERMISSION`; `"unknown"` leaves it enabled.

- [ ] **Step 1: Write the failing tests**

Create `src/k8s/SecretKeys.test.tsx`:

```tsx
import { act, fireEvent, render, screen } from "@testing-library/react";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../test/utils";
import { k8sApi } from "./api";
import { SecretKeys } from "./SecretKeys";
import { BASE64_NOTE, HIDE_VALUE, NO_SECRET_PERMISSION, SHOW_VALUE, byteSize } from "./text";
import type { K8sSecretValue } from "./types";

vi.mock("./api", () => ({ k8sApi: { secretValue: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
const m = vi.mocked(k8sApi);

const T = { profile: "app", region: "r", cluster: "c" };
const KEYS = [{ key: "password", size: 7 }, { key: "blob", size: 2 }];

function setup(props: Partial<Parameters<typeof SecretKeys>[0]> = {}) {
  const qc = newQueryClient();
  const ui = (p: Partial<Parameters<typeof SecretKeys>[0]>) =>
    withClientAndSso(<SecretKeys target={T} ssoProfile="prod-ro" namespace="web" name="db" keys={KEYS} canRead="yes" {...props} {...p} />, qc, ssoLoginStub());
  const r = render(ui({}));
  return { qc, rerender: (p: Partial<Parameters<typeof SecretKeys>[0]>) => r.rerender(ui(p)), unmount: r.unmount };
}
const showButtons = () => screen.getAllByRole("button", { name: SHOW_VALUE });

beforeEach(() => vi.clearAllMocks());

test("lists keys with sizes and reads a value only when asked", async () => {
  m.secretValue.mockResolvedValue({ text: "hunter2", encoding: "utf8" });
  setup();
  expect(screen.getByText("password")).toBeInTheDocument();
  expect(screen.getByText(byteSize(7))).toBeInTheDocument();
  expect(m.secretValue).not.toHaveBeenCalled();
  fireEvent.click(showButtons()[0]);
  expect(await screen.findByText("hunter2")).toBeInTheDocument();
  expect(m.secretValue).toHaveBeenCalledWith(T, "web", "db", "password", "prod-ro");
  fireEvent.click(screen.getByRole("button", { name: HIDE_VALUE }));
  expect(screen.queryByText("hunter2")).toBeNull();
});

test("binary values come with a base64 note", async () => {
  m.secretValue.mockResolvedValue({ text: "//4=", encoding: "base64" });
  setup();
  fireEvent.click(showButtons()[1]);
  expect(await screen.findByText("//4=")).toBeInTheDocument();
  expect(screen.getByText(BASE64_NOTE)).toBeInTheDocument();
});

test("values never reach the query cache", async () => {
  m.secretValue.mockResolvedValue({ text: "hunter2", encoding: "utf8" });
  const { qc } = setup();
  fireEvent.click(showButtons()[0]);
  await screen.findByText("hunter2");
  const cached = JSON.stringify(qc.getQueryCache().getAll().map((q) => q.state.data));
  expect(cached).not.toContain("hunter2");
});

test("switching to another Secret drops shown values and ignores a late answer", async () => {
  let resolve!: (v: K8sSecretValue) => void;
  m.secretValue.mockReturnValueOnce(new Promise((r) => (resolve = r)));
  m.secretValue.mockResolvedValueOnce({ text: "first", encoding: "utf8" });
  const { rerender } = setup();
  fireEvent.click(showButtons()[0]); // 느린 요청
  rerender({ name: "other" });
  await act(async () => resolve({ text: "late-secret", encoding: "utf8" }));
  expect(screen.queryByText("late-secret")).toBeNull();
  rerender({ name: "db" });
  fireEvent.click(showButtons()[0]);
  expect(await screen.findByText("first")).toBeInTheDocument();
  rerender({ namespace: "other-ns" });
  expect(screen.queryByText("first")).toBeNull();
});

test("unmounting forgets the value", async () => {
  m.secretValue.mockResolvedValue({ text: "hunter2", encoding: "utf8" });
  const first = setup();
  fireEvent.click(showButtons()[0]);
  await screen.findByText("hunter2");
  first.unmount();
  setup();
  expect(screen.queryByText("hunter2")).toBeNull();
});

test("no permission disables the button with a reason", () => {
  setup({ canRead: "no" });
  for (const b of showButtons()) {
    expect(b).toBeDisabled();
    expect(b).toHaveAttribute("title", NO_SECRET_PERMISSION);
  }
});

test("an error is shown next to the key and can be retried", async () => {
  m.secretValue.mockRejectedValueOnce({ kind: "network", message: "끊겼어요" });
  m.secretValue.mockResolvedValueOnce({ text: "hunter2", encoding: "utf8" });
  setup();
  fireEvent.click(showButtons()[0]);
  expect(await screen.findByText(/끊겼어요/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  expect(await screen.findByText("hunter2")).toBeInTheDocument();
});

test("access denied shows the permission error without a retry", async () => {
  m.secretValue.mockRejectedValueOnce({ kind: "accessDenied", action: "get secrets" });
  setup();
  fireEvent.click(showButtons()[0]);
  expect(await screen.findByText("권한 없음 (get secrets)")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "다시 시도" })).toBeNull();
});
```

("다시 시도" and "권한 없음 (…)" are `ErrorState`/`errorMessage` text from before K2.)

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run src/k8s/SecretKeys.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `src/k8s/SecretKeys.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { ErrorState } from "../components/ErrorState";
import { k8sApi } from "./api";
import { targetKey } from "./targets";
import { BASE64_NOTE, H_KEY, H_SIZE, H_VALUE, HIDE_VALUE, NO_SECRET_PERMISSION, SEC_SECRET_KEYS, SHOW_VALUE, byteSize } from "./text";
import type { K8sSecretKey, K8sSecretValue, K8sTarget } from "./types";

interface Props {
  target: K8sTarget;
  ssoProfile: string;
  namespace: string;
  name: string;
  keys: K8sSecretKey[];
  /** 이 Secret을 get 할 수 있는지(내 권한 규칙으로 미리 본 것). unknown이면 버튼을 켜 두고 서버가 판단한다 */
  canRead: "yes" | "no" | "unknown";
}

/**
 * Secret 키 목록. 값은 "값 보기"를 누를 때 그 키만 읽어 이 컴포넌트 상태에만 둔다(쿼리 캐시에 넣지 않는다).
 * 다른 Secret으로 바뀌거나 화면을 떠나면 버리고, 그 뒤에 도착한 답은 쓰지 않는다.
 */
export function SecretKeys({ target, ssoProfile, namespace, name, keys, canRead }: Props) {
  const identity = `${targetKey(target)}|${namespace}|${name}`;
  const [shown, setShown] = useState<Record<string, K8sSecretValue>>({});
  const [errors, setErrors] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    generation.current++;
    setShown({});
    setErrors({});
    setBusy(null);
  }, [identity]);

  const reveal = async (key: string) => {
    const gen = generation.current;
    setBusy(key);
    setErrors(({ [key]: _, ...rest }) => rest);
    try {
      const value = await k8sApi.secretValue(target, namespace, name, key, ssoProfile);
      if (generation.current === gen) setShown((s) => ({ ...s, [key]: value }));
    } catch (e) {
      if (generation.current === gen) setErrors((s) => ({ ...s, [key]: e }));
    } finally {
      if (generation.current === gen) setBusy(null);
    }
  };
  const hide = (key: string) => setShown(({ [key]: _, ...rest }) => rest);

  return (
    <section className="k8s-sect">
      <h4>{SEC_SECRET_KEYS}</h4>
      <table className="k8s-table">
        <thead>
          <tr>
            <th>{H_KEY}</th>
            <th>{H_SIZE}</th>
            <th>{H_VALUE}</th>
          </tr>
        </thead>
        <tbody>
          {keys.map(({ key, size }) => {
            const value = shown[key];
            return (
              <tr key={key}>
                <td className="mono">{key}</td>
                <td>{byteSize(size)}</td>
                <td>
                  {value ? (
                    <div className="k8s-secret">
                      <pre className="mono">{value.text}</pre>
                      {value.encoding === "base64" && <p className="dim">{BASE64_NOTE}</p>}
                      <button className="btn" onClick={() => hide(key)}>
                        {HIDE_VALUE}
                      </button>
                    </div>
                  ) : (
                    <button
                      className="btn"
                      disabled={canRead === "no" || busy === key}
                      title={canRead === "no" ? NO_SECRET_PERMISSION : undefined}
                      onClick={() => void reveal(key)}
                    >
                      {SHOW_VALUE}
                    </button>
                  )}
                  {errors[key] !== undefined && <ErrorState error={errors[key]} profile={ssoProfile} compact onRetry={() => void reveal(key)} />}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
```

Append to `src/styles.css`:

```css
.k8s-sect { margin: 12px 0; }
.k8s-sect h4 { margin: 0 0 6px; font-size: 12px; color: var(--dim); font-weight: 600; }
.k8s-secret pre { margin: 0 0 4px; padding: 6px 8px; background: #00000040; border-radius: 6px; white-space: pre-wrap; word-break: break-all; user-select: text; }
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run src/k8s && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/k8s/SecretKeys.tsx src/k8s/SecretKeys.test.tsx src/styles.css
git commit -m "feat(k8s): per-key Secret values kept only in component state

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task K2-F5: Object detail and the workloads view (back stack, ownership navigation)

**Files:**
- Create: `src/k8s/ObjectDetail.tsx`, `src/k8s/ObjectDetail.test.tsx`, `src/k8s/WorkloadsView.tsx`, `src/k8s/WorkloadsView.test.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `useK8sObject`, `useK8sRules` (K1), `can` (K1 `can.ts`), `useK8sWatch` (K1), `K8sError` (K1), `ErrorState`, Tasks K2-F2 (`CATEGORIES`, `customCategories`, `resolveLink`, `sameKind`, `isSecret`, `isPod`, `isServiceAccount`, `NODES`, `PODS`, `valueKeys`, `Problems`, `age`), K2-F3 (`KindTree`, `ObjectList`), K2-F4 (`SecretKeys`).
- Produces:
  - `function ObjectDetail(props: { target: K8sTarget; context: string; ssoProfile: string; live: boolean; objectRef: ObjectRef; resourceVersion: string | null; kinds: K8sKind[]; onOpen: (ref: ObjectRef) => void; onBack: (() => void) | null; onClose: () => void; onOpenIam?: (arn: string) => void; now?: number }): JSX.Element`
  - `interface WorkloadsFocus { ref: ObjectRef; nonce: number }`
  - `function WorkloadsView(props: { target: K8sTarget; context: string; sessionEpoch: number; ssoProfile: string; live: boolean; namespace: string | null; kinds: K8sKind[]; focus: WorkloadsFocus | null; onOpenIam?: (arn: string) => void }): JSX.Element` (`namespace: null` = all namespaces)

Behavior: the list starts on Pods. Clicking a row opens its detail (stack of one). Owner/child/node links push onto the stack; "← 뒤로" pops; "닫기" clears; picking another kind clears. A new `focus.nonce` switches to the focused object's kind and opens it. The detail's `resourceVersion` is the watched row's when the top of the stack is in the current list (so the detail refreshes when the object changes), else `null`. The detail component is keyed by object so its tab and Secret values reset per object. For Secrets, "값 보기" is pre-checked with `can(rules, { verb: "get", group: "", resource: "secrets", name })` from the Secret's namespace rules (`unknown` until rules load).

- [ ] **Step 1: Write the failing tests**

Create `src/k8s/ObjectDetail.test.tsx`:

```tsx
import { fireEvent, render, screen, within } from "@testing-library/react";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../test/utils";
import { k8sApi } from "./api";
import { DEPLOYMENTS, NODES, PODS, SECRETS, SERVICE_ACCOUNTS } from "./kinds";
import { ObjectDetail } from "./ObjectDetail";
import {
  BACK, CHILDREN_TRUNCATED, CLOSE, NO_RECENT_EVENTS, NO_SECRET_PERMISSION, OPEN_IN_IAM, SEC_CHILDREN, SEC_OWNERS, SHOW_VALUE,
  TAB_YAML, YAML_SECRET_NOTE, openNode,
} from "./text";
import type { K8sKind, K8sObjectView, K8sRow } from "./types";

vi.mock("./api", () => ({ k8sApi: { get: vi.fn(), rules: vi.fn(), secretValue: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
const m = vi.mocked(k8sApi);
const T = { profile: "app", region: "r", cluster: "c" };

const row = (over: Partial<K8sRow> = {}): K8sRow => ({ uid: "u1", name: "web-1", namespace: "prod", resourceVersion: "1", createdAt: "2026-10-30T11:00:00Z", labels: { app: "web" }, values: {}, problems: [], ...over });
const view = (over: Partial<K8sObjectView> = {}): K8sObjectView => ({
  kind: PODS, row: row(), annotations: {}, owners: [], children: [], childrenTruncated: false, childrenError: null,
  containers: [], conditions: [], events: [], eventsError: null, yaml: "apiVersion: v1\nkind: Pod\n", secretKeys: null, ...over,
});
const widgetKind: K8sKind = { group: "mm.example.com", version: "v1", kind: "Widget", plural: "widgets", namespaced: true, verbs: ["list", "watch"], custom: true };

function setup(props: Partial<Parameters<typeof ObjectDetail>[0]> = {}) {
  const handlers = { onOpen: vi.fn(), onBack: vi.fn(), onClose: vi.fn(), onOpenIam: vi.fn() };
  render(
    withClientAndSso(
      <ObjectDetail target={T} context="ctx" ssoProfile="p" live objectRef={{ kind: PODS, namespace: "prod", name: "web-1" }} resourceVersion="1" kinds={[widgetKind]} now={Date.parse("2026-10-30T12:00:00Z")} {...handlers} {...props} />,
      newQueryClient(),
      ssoLoginStub(),
    ),
  );
  return handlers;
}

beforeEach(() => vi.clearAllMocks());

test("summary: values, owners, children, containers, conditions, events", async () => {
  m.get.mockResolvedValue(
    view({
      row: row({ values: { status: "CrashLoopBackOff", node: "ip-1" }, problems: ["crashLoopBackOff"] }),
      owners: [
        { group: "apps", version: "v1", kind: "ReplicaSet", name: "web-5d", namespace: "prod", uid: "rs1", controller: true, problems: [] },
        { group: "x.io", version: "v1", kind: "Thing", name: "t", namespace: "prod", uid: "t1", controller: false, problems: [] },
      ],
      children: [{ group: "mm.example.com", version: "v1", kind: "Widget", name: "w1", namespace: "prod", uid: "w", controller: false, problems: ["notReady"] }],
      childrenTruncated: true,
      containers: [{ name: "app", image: "nginx", init: false, state: "waiting", ready: false, restarts: 4, reason: "CrashLoopBackOff", message: null, lastTermination: { reason: "OOMKilled", exitCode: 137, finishedAt: null } }],
      conditions: [{ type: "Ready", status: "False", reason: "ContainersNotReady", message: null, lastTransition: null }],
      events: [{ type: "Warning", reason: "BackOff", message: "Back-off restarting", count: 3, lastSeen: "2026-10-30T11:59:00Z", source: "kubelet", object: "Pod/web-1" }],
    }),
  );
  const h = setup();
  expect(await screen.findByText("CrashLoopBackOff", { selector: "dd" })).toBeInTheDocument();
  expect(m.get).toHaveBeenCalledWith(T, PODS, "prod", "web-1", "p");
  const owners = screen.getByRole("region", { name: SEC_OWNERS });
  fireEvent.click(within(owners).getByRole("button", { name: "ReplicaSet/web-5d" }));
  expect(h.onOpen).toHaveBeenCalledWith({ kind: expect.objectContaining({ kind: "ReplicaSet", plural: "replicasets" }), namespace: "prod", name: "web-5d" });
  expect(within(owners).getByText("Thing/t").tagName).not.toBe("BUTTON");
  const children = screen.getByRole("region", { name: SEC_CHILDREN });
  fireEvent.click(within(children).getByRole("button", { name: "Widget/w1" }));
  expect(h.onOpen).toHaveBeenLastCalledWith({ kind: { group: "mm.example.com", version: "v1", kind: "Widget", plural: "widgets", namespaced: true }, namespace: "prod", name: "w1" });
  expect(screen.getByText(CHILDREN_TRUNCATED)).toBeInTheDocument();
  expect(screen.getByText("OOMKilled (137)")).toBeInTheDocument();
  expect(screen.getByText("ContainersNotReady")).toBeInTheDocument();
  expect(screen.getByText("Back-off restarting")).toBeInTheDocument();
});

test("pod node link and back/close", async () => {
  m.get.mockResolvedValue(view({ row: row({ values: { node: "ip-1" } }) }));
  const h = setup();
  fireEvent.click(await screen.findByRole("button", { name: openNode("ip-1") }));
  expect(h.onOpen).toHaveBeenCalledWith({ kind: NODES, namespace: null, name: "ip-1" });
  fireEvent.click(screen.getByRole("button", { name: BACK }));
  expect(h.onBack).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: CLOSE }));
  expect(h.onClose).toHaveBeenCalled();
});

test("no back button at the bottom of the stack; no events message", async () => {
  m.get.mockResolvedValue(view());
  setup({ onBack: null });
  expect(await screen.findByText(NO_RECENT_EVENTS)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: BACK })).toBeNull();
});

test("service account role opens IAM", async () => {
  m.get.mockResolvedValue(view({ kind: SERVICE_ACCOUNTS, row: row({ name: "web", values: { roleArn: "arn:aws:iam::1:role/web" } }) }));
  const h = setup({ objectRef: { kind: SERVICE_ACCOUNTS, namespace: "prod", name: "web" } });
  fireEvent.click(await screen.findByRole("button", { name: OPEN_IN_IAM }));
  expect(h.onOpenIam).toHaveBeenCalledWith("arn:aws:iam::1:role/web");
});

test("YAML tab", async () => {
  m.get.mockResolvedValue(view());
  setup();
  fireEvent.click(await screen.findByRole("tab", { name: TAB_YAML }));
  expect(screen.getByText(/kind: Pod/)).toBeInTheDocument();
});

test("secret: keys with a permission pre-check and a masked YAML note", async () => {
  m.get.mockResolvedValue(view({ kind: SECRETS, row: row({ name: "db" }), secretKeys: [{ key: "password", size: 7 }], yaml: "data:\n  password: ••••\n" }));
  m.rules.mockResolvedValue({ namespace: "prod", incomplete: false, nonResourceRules: [], resourceRules: [{ verbs: ["list"], apiGroups: [""], resources: ["secrets"], resourceNames: [] }] });
  setup({ objectRef: { kind: SECRETS, namespace: "prod", name: "db" } });
  const button = await screen.findByRole("button", { name: SHOW_VALUE });
  await vi.waitFor(() => expect(button).toBeDisabled());
  expect(button).toHaveAttribute("title", NO_SECRET_PERMISSION);
  expect(m.rules).toHaveBeenCalledWith(T, "prod", "p");
  fireEvent.click(screen.getByRole("tab", { name: TAB_YAML }));
  expect(screen.getByText(YAML_SECRET_NOTE)).toBeInTheDocument();
});

test("a failed read shows the error", async () => {
  m.get.mockRejectedValue({ kind: "other", message: "pods \"web-1\" not found" });
  setup({ objectRef: { kind: DEPLOYMENTS, namespace: "prod", name: "x" } });
  expect(await screen.findByText(/not found/)).toBeInTheDocument();
});
```

Create `src/k8s/WorkloadsView.test.tsx`:

```tsx
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../test/utils";
import { k8sApi } from "./api";
import { DEPLOYMENTS, NODES, PODS } from "./kinds";
import { BACK, CAT_CUSTOM, KIND_TREE_LABEL } from "./text";
import type { K8sKind, K8sObjectView, K8sRow, K8sWatchMessage } from "./types";
import { WorkloadsView, type WorkloadsFocus } from "./WorkloadsView";

vi.mock("./api", () => ({ k8sApi: { watch: vi.fn(), unwatch: vi.fn(), get: vi.fn(), rules: vi.fn(), secretValue: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
const m = vi.mocked(k8sApi);
let n = 0;
let T = { profile: "app", region: "r", cluster: "c" };

const row = (name: string): K8sRow => ({ uid: `u-${name}`, name, namespace: "prod", resourceVersion: "7", createdAt: null, labels: {}, values: {}, problems: [] });
const view = (name: string, over: Partial<K8sObjectView> = {}): K8sObjectView => ({
  kind: PODS, row: row(name), annotations: {}, owners: [], children: [], childrenTruncated: false, childrenError: null,
  containers: [], conditions: [], events: [], eventsError: null, yaml: "", secretKeys: null, ...over,
});
const emits = new Map<string, (msg: K8sWatchMessage) => void>();

beforeEach(() => {
  vi.clearAllMocks();
  T = { ...T, cluster: `c${n++}` };
  m.unwatch.mockResolvedValue(null);
  m.watch.mockImplementation(async (_t, kind, _ns, _p, onMessage) => {
    emits.set(kind.plural, onMessage);
    return 1;
  });
});

function setup(props: Partial<Parameters<typeof WorkloadsView>[0]> = {}) {
  const ui = (p: Partial<Parameters<typeof WorkloadsView>[0]>) =>
    withClientAndSso(<WorkloadsView target={T} context="ctx" sessionEpoch={1} ssoProfile="p" live namespace="prod" kinds={[]} focus={null} {...props} {...p} />, qc, ssoLoginStub());
  const qc = newQueryClient();
  const r = render(ui({}));
  return { rerender: (p: Partial<Parameters<typeof WorkloadsView>[0]>) => r.rerender(ui(p)) };
}
const send = (plural: string, msg: K8sWatchMessage) => act(() => emits.get(plural)!(msg));

test("starts on pods, opens a row, follows an owner, and goes back", async () => {
  m.get.mockImplementation(async (_t, kind, _ns, name) =>
    kind.plural === "pods" ? view(name, { owners: [{ group: "apps", version: "v1", kind: "ReplicaSet", name: "rs1", namespace: "prod", uid: "r", controller: true, problems: [] }] }) : view(name, { kind }),
  );
  setup();
  await vi.waitFor(() => expect(m.watch).toHaveBeenCalledWith(T, PODS, "prod", "p", expect.any(Function)));
  send("pods", { type: "reset", rows: [row("web-1")] });
  fireEvent.click(screen.getByText("web-1"));
  await vi.waitFor(() => expect(m.get).toHaveBeenCalledWith(T, PODS, "prod", "web-1", "p"));
  fireEvent.click(await screen.findByRole("button", { name: "ReplicaSet/rs1" }));
  await vi.waitFor(() => expect(m.get).toHaveBeenLastCalledWith(T, expect.objectContaining({ plural: "replicasets" }), "prod", "rs1", "p"));
  fireEvent.click(screen.getByRole("button", { name: BACK }));
  expect(await screen.findByRole("button", { name: "ReplicaSet/rs1" })).toBeInTheDocument();
});

test("changing kind watches that kind and closes the detail", async () => {
  m.get.mockResolvedValue(view("web-1"));
  setup({ namespace: null });
  await vi.waitFor(() => expect(m.watch).toHaveBeenCalled());
  send("pods", { type: "reset", rows: [row("web-1")] });
  fireEvent.click(screen.getByText("web-1"));
  await vi.waitFor(() => expect(m.get).toHaveBeenCalled());
  fireEvent.click(within(screen.getByRole("navigation", { name: KIND_TREE_LABEL })).getByRole("button", { name: "Deployment" }));
  await vi.waitFor(() => expect(m.watch).toHaveBeenCalledWith(T, DEPLOYMENTS, null, "p", expect.any(Function)));
  expect(screen.queryByRole("tab")).toBeNull();
});

test("cluster-scoped kinds watch all namespaces", async () => {
  setup({ focus: { ref: { kind: NODES, namespace: null, name: "ip-1" }, nonce: 1 } });
  await vi.waitFor(() => expect(m.watch).toHaveBeenCalledWith(T, NODES, null, "p", expect.any(Function)));
});

test("a new focus opens that object", async () => {
  m.get.mockResolvedValue(view("ip-1", { kind: NODES }));
  const { rerender } = setup();
  const focus: WorkloadsFocus = { ref: { kind: NODES, namespace: null, name: "ip-1" }, nonce: 1 };
  rerender({ focus });
  await vi.waitFor(() => expect(m.get).toHaveBeenCalledWith(T, NODES, null, "ip-1", "p"));
});

test("custom kinds appear in the tree", async () => {
  const widget: K8sKind = { group: "mm.example.com", version: "v1", kind: "Widget", plural: "widgets", namespaced: true, verbs: ["list", "watch"], custom: true };
  setup({ kinds: [widget] });
  expect(screen.getByText("mm.example.com")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Widget" }));
  await vi.waitFor(() => expect(m.watch).toHaveBeenCalledWith(T, { group: "mm.example.com", version: "v1", kind: "Widget", plural: "widgets", namespaced: true }, "prod", "p", expect.any(Function)));
  expect(screen.getByText(CAT_CUSTOM)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run src/k8s/ObjectDetail.test.tsx src/k8s/WorkloadsView.test.tsx`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

Create `src/k8s/ObjectDetail.tsx`:

```tsx
import { useState, type ReactNode } from "react";
import { ErrorState } from "../components/ErrorState";
import { can } from "./can";
import { Problems, valueKeys } from "./columns";
import { age } from "./format";
import { NODES, isPod, isSecret, isServiceAccount, resolveLink } from "./kinds";
import { useK8sObject, useK8sRules } from "./queries";
import { SecretKeys } from "./SecretKeys";
import {
  BACK, CHILDREN_TRUNCATED, CLOSE, COL_NAME, COLUMN_LABELS, CREATED_AT, DETAIL_LABEL, H_IMAGE, H_KIND, H_LAST_TERMINATION, H_MESSAGE,
  H_REASON, H_RESTARTS, H_STATE, INIT_MARK, LOADING, NO_RECENT_EVENTS, OPEN_IN_IAM, SEC_ANNOTATIONS, SEC_CHILDREN, SEC_CONDITIONS,
  SEC_CONTAINERS, SEC_EVENTS, SEC_LABELS, SEC_OWNERS, TAB_SUMMARY, TAB_YAML, YAML_SECRET_NOTE, H_TIME, H_COUNT, openNode,
} from "./text";
import type { K8sContainer, K8sKind, K8sLink, K8sObjectView, K8sTarget, ObjectRef } from "./types";

interface Props {
  target: K8sTarget;
  context: string;
  ssoProfile: string;
  live: boolean;
  objectRef: ObjectRef;
  /** 목록에 있는 객체면 그 resourceVersion(바뀌면 다시 읽는다), 아니면 null */
  resourceVersion: string | null;
  kinds: K8sKind[];
  onOpen: (ref: ObjectRef) => void;
  onBack: (() => void) | null;
  onClose: () => void;
  onOpenIam?: (arn: string) => void;
  now?: number;
}

function Links({ title, links, kinds, onOpen }: { title: string; links: K8sLink[]; kinds: K8sKind[]; onOpen: (ref: ObjectRef) => void }) {
  return (
    <section className="k8s-sect" aria-label={title}>
      <h4>{title}</h4>
      <ul className="k8s-links">
        {links.map((l) => {
          const kind = resolveLink(l, kinds);
          const label = `${l.kind}/${l.name}`;
          return (
            <li key={l.uid}>
              {kind ? (
                <button className="link" onClick={() => onOpen({ kind, namespace: kind.namespaced ? l.namespace : null, name: l.name })}>
                  {label}
                </button>
              ) : (
                <span className="mono">{label}</span>
              )}{" "}
              <Problems problems={l.problems} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const stateText = (c: K8sContainer) => (c.state === "template" ? "" : c.reason ? `${c.state}: ${c.reason}` : c.state);

function Summary({ view, now, kinds, onOpen, onOpenIam, children }: { view: K8sObjectView; now: number; kinds: K8sKind[]; onOpen: (ref: ObjectRef) => void; onOpenIam?: (arn: string) => void; children?: ReactNode }) {
  const { row } = view;
  const node = isPod(view.kind) ? row.values.node : undefined;
  const role = isServiceAccount(view.kind) ? row.values.roleArn : undefined;
  return (
    <div>
      <Problems problems={row.problems} />
      <dl className="kv">
        {valueKeys(view.kind)
          .filter((k) => row.values[k] !== undefined)
          .map((k) => (
            <div key={k} className="k8s-kv">
              <dt>{COLUMN_LABELS[k] ?? k}</dt>
              <dd>{row.values[k]}</dd>
            </div>
          ))}
        <div className="k8s-kv">
          <dt>{CREATED_AT}</dt>
          <dd title={row.createdAt ?? ""}>{age(row.createdAt, now)}</dd>
        </div>
      </dl>
      <div className="k8s-actions">
        {node && (
          <button className="btn" onClick={() => onOpen({ kind: NODES, namespace: null, name: node })}>
            {openNode(node)}
          </button>
        )}
        {role && onOpenIam && (
          <button className="btn" onClick={() => onOpenIam(role)}>
            {OPEN_IN_IAM}
          </button>
        )}
      </div>
      {view.owners.length > 0 && <Links title={SEC_OWNERS} links={view.owners} kinds={kinds} onOpen={onOpen} />}
      {(view.children.length > 0 || view.childrenError) && (
        <>
          <Links title={SEC_CHILDREN} links={view.children} kinds={kinds} onOpen={onOpen} />
          {view.childrenTruncated && <p className="dim">{CHILDREN_TRUNCATED}</p>}
          {view.childrenError && <p className="err">{(view.childrenError as { message?: string }).message ?? ""}</p>}
        </>
      )}
      {children}
      {view.containers.length > 0 && (
        <section className="k8s-sect">
          <h4>{SEC_CONTAINERS}</h4>
          <table className="k8s-table">
            <thead>
              <tr><th>{COL_NAME}</th><th>{H_IMAGE}</th><th>{H_STATE}</th><th>{H_RESTARTS}</th><th>{H_LAST_TERMINATION}</th></tr>
            </thead>
            <tbody>
              {view.containers.map((c) => (
                <tr key={`${c.init}|${c.name}`}>
                  <td className="mono">{c.name}{c.init && <span className="k8s-chip">{INIT_MARK}</span>}</td>
                  <td className="mono">{c.image}</td>
                  <td title={c.message ?? ""}>{stateText(c)}</td>
                  <td>{c.state === "template" ? "" : c.restarts}</td>
                  <td>{c.lastTermination ? `${c.lastTermination.reason ?? ""} (${c.lastTermination.exitCode})` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {view.conditions.length > 0 && (
        <section className="k8s-sect">
          <h4>{SEC_CONDITIONS}</h4>
          <table className="k8s-table">
            <thead>
              <tr><th>{H_KIND}</th><th>{H_STATE}</th><th>{H_REASON}</th><th>{H_MESSAGE}</th></tr>
            </thead>
            <tbody>
              {view.conditions.map((c) => (
                <tr key={c.type}><td>{c.type}</td><td>{c.status}</td><td>{c.reason ?? ""}</td><td>{c.message ?? ""}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <section className="k8s-sect">
        <h4>{SEC_EVENTS}</h4>
        {view.eventsError ? (
          <p className="err">{(view.eventsError as { message?: string }).message ?? ""}</p>
        ) : view.events.length === 0 ? (
          <p className="dim">{NO_RECENT_EVENTS}</p>
        ) : (
          <table className="k8s-table">
            <thead>
              <tr><th>{H_TIME}</th><th>{H_KIND}</th><th>{H_REASON}</th><th>{H_MESSAGE}</th><th>{H_COUNT}</th></tr>
            </thead>
            <tbody>
              {view.events.map((e, i) => (
                <tr key={i} className={e.type === "Warning" ? "k8s-warn" : undefined}>
                  <td title={e.lastSeen ?? ""}>{age(e.lastSeen, now)}</td><td>{e.type}</td><td>{e.reason}</td><td>{e.message}</td><td>{e.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {Object.keys(row.labels).length > 0 && (
        <section className="k8s-sect">
          <h4>{SEC_LABELS}</h4>
          {Object.entries(row.labels).map(([k, v]) => <span key={k} className="tag">{k}={v}</span>)}
        </section>
      )}
      {Object.keys(view.annotations).length > 0 && (
        <section className="k8s-sect">
          <h4>{SEC_ANNOTATIONS}</h4>
          <dl className="kv">
            {Object.entries(view.annotations).map(([k, v]) => (
              <div key={k} className="k8s-kv"><dt className="mono">{k}</dt><dd className="mono k8s-wrap">{v}</dd></div>
            ))}
          </dl>
        </section>
      )}
    </div>
  );
}

/** 객체 하나의 상세(요약·YAML). 소유자·자식·노드 링크는 onOpen으로 상세 스택에 쌓는다. */
export function ObjectDetail({ target, context, ssoProfile, live, objectRef, resourceVersion, kinds, onOpen, onBack, onClose, onOpenIam, now }: Props) {
  const [tab, setTab] = useState<"summary" | "yaml">("summary");
  const q = useK8sObject(target, context, objectRef, resourceVersion, ssoProfile, live);
  const secret = isSecret(objectRef.kind);
  const rules = useK8sRules(target, context, objectRef.namespace, ssoProfile, live && secret && objectRef.namespace !== null);
  const canRead = rules.data ? can(rules.data, { verb: "get", group: "", resource: "secrets", name: objectRef.name }) : "unknown";
  const at = now ?? Date.now();
  return (
    <aside className="k8s-detail" aria-label={DETAIL_LABEL}>
      <div className="k8s-detail-head">
        {onBack && <button className="btn" onClick={onBack}>{BACK}</button>}
        <b>{objectRef.kind.kind}</b>
        <span className="mono k8s-wrap">{objectRef.namespace ? `${objectRef.namespace}/` : ""}{objectRef.name}</span>
        <button className="btn k8s-push" onClick={onClose}>{CLOSE}</button>
      </div>
      <div role="tablist" className="k8s-tabs">
        <button role="tab" aria-selected={tab === "summary"} onClick={() => setTab("summary")}>{TAB_SUMMARY}</button>
        <button role="tab" aria-selected={tab === "yaml"} onClick={() => setTab("yaml")}>{TAB_YAML}</button>
      </div>
      <div className="k8s-detail-body">
        {q.isError ? (
          <ErrorState error={q.error} profile={ssoProfile} compact onRetry={() => void q.refetch()} />
        ) : !q.data ? (
          <div className="empty">{LOADING}</div>
        ) : tab === "summary" ? (
          <Summary view={q.data} now={at} kinds={kinds} onOpen={onOpen} onOpenIam={onOpenIam}>
            {q.data.secretKeys && objectRef.namespace && (
              <SecretKeys target={target} ssoProfile={ssoProfile} namespace={objectRef.namespace} name={objectRef.name} keys={q.data.secretKeys} canRead={canRead} />
            )}
          </Summary>
        ) : (
          <>
            {secret && <p className="dim">{YAML_SECRET_NOTE}</p>}
            <pre className="k8s-yaml mono">{q.data.yaml}</pre>
          </>
        )}
      </div>
    </aside>
  );
}
```

(`useK8sRules` takes `namespace: string | null` and stays disabled while null, as in K1. Use `errorMessage` from `../api/errors` for `childrenError`/`eventsError` instead of the `.message` cast if it reads better; both render the same text for `other` errors.)

Create `src/k8s/WorkloadsView.tsx`:

```tsx
import { useEffect, useMemo, useState } from "react";
import { K8sError } from "./K8sError";
import { KindTree } from "./KindTree";
import { CATEGORIES, PODS, customCategories, sameKind } from "./kinds";
import { ObjectDetail } from "./ObjectDetail";
import { ObjectList } from "./ObjectList";
import { kindKey } from "./targets";
import { CAT_CUSTOM } from "./text";
import type { K8sKind, K8sKindRef, K8sTarget, ObjectRef } from "./types";
import { useK8sWatch } from "./useK8sWatch";

export interface WorkloadsFocus {
  ref: ObjectRef;
  /** 같은 객체를 다시 열 때도 바뀌는 값 */
  nonce: number;
}

interface Props {
  target: K8sTarget;
  context: string;
  sessionEpoch: number;
  ssoProfile: string;
  live: boolean;
  /** null이면 모든 네임스페이스 */
  namespace: string | null;
  kinds: K8sKind[];
  focus: WorkloadsFocus | null;
  onOpenIam?: (arn: string) => void;
}

/** 종류 트리 + 감시 목록 + 상세 스택 */
export function WorkloadsView({ target, context, sessionEpoch, ssoProfile, live, namespace, kinds, focus, onOpenIam }: Props) {
  const [kind, setKind] = useState<K8sKindRef>(PODS);
  const [stack, setStack] = useState<ObjectRef[]>([]);

  useEffect(() => {
    if (!focus) return;
    setKind(focus.ref.kind);
    setStack([focus.ref]);
    // nonce가 바뀔 때만 연다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  const watch = useK8sWatch(target, context, sessionEpoch, ssoProfile, kind, kind.namespaced ? namespace : null, live);
  const custom = useMemo(() => customCategories(kinds), [kinds]);
  const categories = useMemo(() => (custom.length === 0 ? CATEGORIES : [...CATEGORIES, { id: "custom", label: CAT_CUSTOM, kinds: [] }, ...custom]), [custom]);
  const top = stack.length > 0 ? stack[stack.length - 1] : null;
  const topRow = top && sameKind(top.kind, kind) ? watch.rows.find((r) => r.name === top.name && r.namespace === top.namespace) : undefined;

  const pickKind = (k: K8sKindRef) => {
    setKind(k);
    setStack([]);
  };
  return (
    <div className="k8s-workloads">
      <KindTree categories={categories} selected={kind} onSelect={pickKind} />
      <div className="k8s-list-pane">
        {watch.error && <K8sError error={watch.error} target={target} ssoProfile={ssoProfile} compact />}
        <ObjectList
          kind={kind}
          rows={watch.rows}
          status={watch.status}
          showNamespace={namespace === null}
          selectedUid={topRow?.uid ?? null}
          onSelect={(r) => setStack([{ kind, namespace: r.namespace, name: r.name }])}
        />
      </div>
      {top && (
        <ObjectDetail
          key={`${kindKey(top.kind)}|${top.namespace}|${top.name}`}
          target={target}
          context={context}
          ssoProfile={ssoProfile}
          live={live}
          objectRef={top}
          resourceVersion={topRow?.resourceVersion ?? null}
          kinds={kinds}
          onOpen={(ref) => setStack((s) => [...s, ref])}
          onBack={stack.length > 1 ? () => setStack((s) => s.slice(0, -1)) : null}
          onClose={() => setStack([])}
          onOpenIam={onOpenIam}
        />
      )}
    </div>
  );
}
```

(The empty `custom` category renders the "사용자 정의 리소스" heading with no buttons; the API-group categories follow it.)

Append to `src/styles.css`:

```css
.k8s-workloads { flex: 1; min-height: 0; display: flex; }
.k8s-list-pane { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.k8s-detail { width: 46%; min-width: 360px; flex: none; display: flex; flex-direction: column; border-left: 1px solid var(--line); background: var(--panel); }
.k8s-detail-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--line); }
.k8s-push { margin-left: auto; }
.k8s-tabs { display: flex; gap: 2px; padding: 4px 12px 0; border-bottom: 1px solid var(--line); }
.k8s-tabs [role="tab"] { background: none; border: 0; border-bottom: 2px solid transparent; color: var(--dim); padding: 4px 10px; cursor: pointer; }
.k8s-tabs [aria-selected="true"] { color: inherit; border-bottom-color: var(--accent, #0a84ff); }
.k8s-detail-body { flex: 1; overflow: auto; padding: 10px 12px; }
.k8s-kv { display: contents; }
.k8s-links { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.k8s-yaml { margin: 0; white-space: pre; font-size: 12px; user-select: text; }
.k8s-wrap { word-break: break-all; }
.k8s-warn td { color: var(--orange, #ff9f0a); }
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run src/k8s && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/k8s/ObjectDetail.tsx src/k8s/ObjectDetail.test.tsx src/k8s/WorkloadsView.tsx src/k8s/WorkloadsView.test.tsx src/styles.css
git commit -m "feat(k8s): workloads view with object detail, ownership navigation and YAML

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task K2-F6: Events view

**Files:**
- Create: `src/k8s/EventsView.tsx`, `src/k8s/EventsView.test.tsx`

**Interfaces:**
- Consumes: `useK8sWatch` (K1), `K8sError` (K1), `EVENTS` (K2-F2), `age` (K2-F2), event row values from Task K2-B3 (`type`, `reason`, `object`, `message`, `count`, `lastSeen`), strings `WARNINGS_ONLY, H_TIME, H_KIND, H_REASON, H_OBJECT, H_MESSAGE, H_COUNT, NO_EVENTS, LOADING, NAV_EVENTS`.
- Produces: `function EventsView(props: { target: K8sTarget; context: string; sessionEpoch: number; ssoProfile: string; live: boolean; namespace: string | null; now?: number }): JSX.Element`

Rows are sorted by `values.lastSeen`, newest first (RFC 3339 strings at second precision sort as text). With all namespaces the 대상 cell is `namespace/Kind/name`.

- [ ] **Step 1: Write the failing tests**

Create `src/k8s/EventsView.test.tsx`:

```tsx
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../test/utils";
import { k8sApi } from "./api";
import { EventsView } from "./EventsView";
import { EVENTS } from "./kinds";
import { LOADING, NO_EVENTS, WARNINGS_ONLY } from "./text";
import type { K8sRow, K8sWatchMessage } from "./types";

vi.mock("./api", () => ({ k8sApi: { watch: vi.fn(), unwatch: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
const m = vi.mocked(k8sApi);
let n = 0;
let T = { profile: "app", region: "r", cluster: "c" };
let emit: (msg: K8sWatchMessage) => void = () => {};

const ev = (name: string, type: string, lastSeen: string, ns = "prod"): K8sRow => ({
  uid: name, name, namespace: ns, resourceVersion: "1", createdAt: null, labels: {}, problems: [],
  values: { type, reason: `R-${name}`, object: `Pod/${name}`, message: `m-${name}`, count: "2", lastSeen },
});

beforeEach(() => {
  vi.clearAllMocks();
  T = { ...T, cluster: `c${n++}` };
  m.unwatch.mockResolvedValue(null);
  m.watch.mockImplementation(async (_t, _k, _ns, _p, onMessage) => {
    emit = onMessage;
    return 1;
  });
});

function setup(namespace: string | null = "prod") {
  render(withClientAndSso(<EventsView target={T} context="ctx" sessionEpoch={1} ssoProfile="p" live namespace={namespace} now={Date.parse("2026-10-30T12:00:00Z")} />, newQueryClient(), ssoLoginStub()));
}
const messages = () => screen.queryAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[4].textContent);

test("watches events in the namespace and shows newest first", async () => {
  setup();
  expect(screen.getByText(LOADING)).toBeInTheDocument();
  await vi.waitFor(() => expect(m.watch).toHaveBeenCalledWith(T, EVENTS, "prod", "p", expect.any(Function)));
  act(() => emit({ type: "reset", rows: [ev("a", "Normal", "2026-10-30T11:00:00Z"), ev("b", "Warning", "2026-10-30T11:58:00Z")] }));
  expect(messages()).toEqual(["m-b", "m-a"]);
  expect(screen.getByText("2m")).toBeInTheDocument();
  expect(screen.getByText("Pod/b")).toBeInTheDocument();
});

test("Warning only", async () => {
  setup();
  await vi.waitFor(() => expect(m.watch).toHaveBeenCalled());
  act(() => emit({ type: "reset", rows: [ev("a", "Normal", "2026-10-30T11:00:00Z"), ev("b", "Warning", "2026-10-30T11:58:00Z")] }));
  fireEvent.click(screen.getByRole("checkbox", { name: WARNINGS_ONLY }));
  expect(messages()).toEqual(["m-b"]);
});

test("all namespaces watches cluster-wide and names the namespace", async () => {
  setup(null);
  await vi.waitFor(() => expect(m.watch).toHaveBeenCalledWith(T, EVENTS, null, "p", expect.any(Function)));
  act(() => emit({ type: "reset", rows: [ev("a", "Normal", "2026-10-30T11:00:00Z", "kube-system")] }));
  expect(screen.getByText("kube-system/Pod/a")).toBeInTheDocument();
});

test("empty", async () => {
  setup();
  await vi.waitFor(() => expect(m.watch).toHaveBeenCalled());
  act(() => emit({ type: "reset", rows: [] }));
  expect(screen.getByText(NO_EVENTS)).toBeInTheDocument();
});

test("a watch error is shown", async () => {
  setup();
  await vi.waitFor(() => expect(m.watch).toHaveBeenCalled());
  act(() => emit({ type: "error", error: { kind: "accessDenied", action: "list events" }, fatal: true }));
  expect(screen.getByText("권한 없음 (list events)")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run src/k8s/EventsView.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `src/k8s/EventsView.tsx`:

```tsx
import { useMemo, useState } from "react";
import { age } from "./format";
import { K8sError } from "./K8sError";
import { EVENTS } from "./kinds";
import { H_COUNT, H_KIND, H_MESSAGE, H_OBJECT, H_REASON, H_TIME, LOADING, NAV_EVENTS, NO_EVENTS, WARNINGS_ONLY } from "./text";
import type { K8sTarget } from "./types";
import { useK8sWatch } from "./useK8sWatch";

interface Props {
  target: K8sTarget;
  context: string;
  sessionEpoch: number;
  ssoProfile: string;
  live: boolean;
  /** null이면 모든 네임스페이스 */
  namespace: string | null;
  now?: number;
}

/** 네임스페이스(또는 클러스터 전체)의 이벤트를 감시해 최근 것부터 보여 준다 */
export function EventsView({ target, context, sessionEpoch, ssoProfile, live, namespace, now }: Props) {
  const w = useK8sWatch(target, context, sessionEpoch, ssoProfile, EVENTS, namespace, live);
  const [warningsOnly, setWarningsOnly] = useState(false);
  const rows = useMemo(
    () => w.rows.filter((r) => !warningsOnly || r.values.type === "Warning").sort((a, b) => (b.values.lastSeen ?? "").localeCompare(a.values.lastSeen ?? "")),
    [w.rows, warningsOnly],
  );
  const at = now ?? Date.now();
  return (
    <div className="k8s-events">
      {w.error && <K8sError error={w.error} target={target} ssoProfile={ssoProfile} compact />}
      <div className="k8s-list-bar">
        <label className="k8s-check">
          <input type="checkbox" checked={warningsOnly} onChange={(e) => setWarningsOnly(e.target.checked)} />
          {WARNINGS_ONLY}
        </label>
      </div>
      {w.status === "loading" ? (
        <div className="empty">{LOADING}</div>
      ) : rows.length === 0 && !w.error ? (
        <div className="empty">{NO_EVENTS}</div>
      ) : (
        <table className="k8s-table" aria-label={NAV_EVENTS}>
          <thead>
            <tr><th>{H_TIME}</th><th>{H_KIND}</th><th>{H_REASON}</th><th>{H_OBJECT}</th><th>{H_MESSAGE}</th><th>{H_COUNT}</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.uid} className={r.values.type === "Warning" ? "k8s-warn" : undefined}>
                <td title={r.values.lastSeen ?? ""}>{age(r.values.lastSeen ?? null, at)}</td>
                <td>{r.values.type ?? ""}</td>
                <td>{r.values.reason ?? ""}</td>
                <td className="mono">{namespace === null && r.namespace ? `${r.namespace}/${r.values.object ?? ""}` : r.values.object ?? ""}</td>
                <td>{r.values.message ?? ""}</td>
                <td>{r.values.count ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

Append to `src/styles.css`: `.k8s-events { display: flex; flex-direction: column; gap: 6px; }`

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run src/k8s && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/k8s/EventsView.tsx src/k8s/EventsView.test.tsx src/styles.css
git commit -m "feat(k8s): live events view with a Warning filter

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task K2-F7: Overview view

**Files:**
- Create: `src/k8s/OverviewView.tsx`, `src/k8s/OverviewView.test.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `useK8sOverview` (K2-F1), `ErrorState`, `formatCpu`, `formatBytes`, `percent` (K2-F2), overview strings (K2-F1).
- Produces: `function OverviewView(props: { target: K8sTarget; context: string; ssoProfile: string; live: boolean; onOpenNode: (name: string) => void }): JSX.Element`

Gaps render next to their section as `gapText(SECTION_LABELS[section])` plus an `ErrorState` (compact) whose retry and after-login action refetch the overview. The login profile for a gap is `target.profile` for EKS sections (`cluster`, `nodegroups`, `fargate`, `addons`, `insights`) and the exec profile for Kubernetes sections (`nodes`, `metrics`, `nodePools`, `removedApis`). A failed `k8s_overview` itself (not connected, app AWS profile/SSO) shows `ErrorState` with `target.profile`.

Node status cell: `Ready` or `NotReady`, then ` · 스케줄 중지` when cordoned, then ` · ` + pressures joined by `, `. Request cells: `${formatCpu(requested)} / ${formatCpu(allocatable)} (${percent})` and the same with `formatBytes`. Usage cells only when `metrics`; otherwise the note `NO_METRICS` under the table. Karpenter section only when `nodePools !== null`. Add-on 최신 버전 cell: `UP_TO_DATE` when `latest === version`, else `latest ?? ""`. Removed-API block only when `nextVersion` is set.

- [ ] **Step 1: Write the failing tests**

Create `src/k8s/OverviewView.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../test/utils";
import { k8sApi } from "./api";
import { OverviewView } from "./OverviewView";
import {
  CORDONED, NO_METRICS, NO_SKEW, OFF, ON, REFRESH, REQUESTS_PARTIAL, SECTION_LABELS, SEC_NODEPOOLS, UP_TO_DATE, gapText, noRemoved, removedTitle, skewText,
} from "./text";
import type { K8sNodeView, K8sOverview } from "./types";

vi.mock("./api", () => ({ k8sApi: { overview: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
const m = vi.mocked(k8sApi);
const T = { profile: "app", region: "r", cluster: "c" };

const node = (over: Partial<K8sNodeView> = {}): K8sNodeView => ({
  name: "ip-1", ready: true, unschedulable: false, pressures: [], instanceType: "m6i.large", zone: "ap-northeast-2a", groupKind: "managed", group: "ng-1",
  kubeletVersion: "v1.31.4", allocatable: { cpuMilli: 2000, memoryBytes: 8 * 1024 ** 3, pods: 29 }, requested: { cpuMilli: 500, memoryBytes: 2 * 1024 ** 3, pods: 5 }, usage: null, ...over,
});
const overview = (over: Partial<K8sOverview> = {}): K8sOverview => ({
  cluster: { version: "1.31", platformVersion: "eks.12", status: "ACTIVE", endpointPublic: true, endpointPrivate: false, publicCidrs: ["0.0.0.0/0"], logging: [], secretsEncrypted: true, oidcIssuer: null, authenticationMode: "API" },
  nodes: [node()], requestsPartial: false, metrics: false, nodegroups: [], fargateProfiles: [], nodePools: null,
  addons: [{ name: "coredns", version: "v1", latest: "v1", status: "ACTIVE", issues: [] }, { name: "vpc-cni", version: "v1", latest: "v2", status: "ACTIVE", issues: ["X: y"] }],
  insights: [], removedApis: [], nextVersion: "1.32", skew: [], gaps: [], ...over,
});

function setup() {
  const onOpenNode = vi.fn();
  render(withClientAndSso(<OverviewView target={T} context="ctx" ssoProfile="exec" live onOpenNode={onOpenNode} />, newQueryClient(), ssoLoginStub()));
  return { onOpenNode };
}

beforeEach(() => vi.clearAllMocks());

test("cluster, nodes, add-ons and upgrade checks", async () => {
  m.overview.mockResolvedValue(overview({ skew: [{ node: "ip-1", kubeletVersion: "v1.29.0", minorsBehind: 2 }] }));
  const { onOpenNode } = setup();
  expect(await screen.findByText("eks.12")).toBeInTheDocument();
  expect(screen.getByText(ON)).toBeInTheDocument(); // Secret 암호화
  expect(screen.getByText(OFF)).toBeInTheDocument(); // 로깅 없음
  expect(screen.getByText("500m / 2 (25%)")).toBeInTheDocument();
  expect(screen.getByText("2 GiB / 8 GiB (25%)")).toBeInTheDocument();
  expect(screen.getByText(NO_METRICS)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "ip-1" }));
  expect(onOpenNode).toHaveBeenCalledWith("ip-1");
  expect(screen.getByText(UP_TO_DATE)).toBeInTheDocument();
  expect(screen.getByText("v2")).toBeInTheDocument();
  expect(screen.getByText("X: y")).toBeInTheDocument();
  expect(screen.getByText(noRemoved("1.32"))).toBeInTheDocument();
  expect(screen.getByText(skewText(2), { exact: false })).toBeInTheDocument();
  expect(screen.queryByText(SEC_NODEPOOLS)).toBeNull();
  expect(m.overview).toHaveBeenCalledWith(T);
});

test("cordon, pressure, usage, partial requests, node pools, removed APIs, no skew", async () => {
  m.overview.mockResolvedValue(
    overview({
      nodes: [node({ unschedulable: true, pressures: ["MemoryPressure"], usage: { cpuMilli: 1000, memoryBytes: 1024 ** 3 } })],
      metrics: true, requestsPartial: true, nodePools: ["default"],
      removedApis: [{ kind: "FlowSchema", apiVersion: "flowcontrol.apiserver.k8s.io/v1beta3", replacement: "flowcontrol.apiserver.k8s.io/v1", removedIn: "1.32", namespace: null, name: "fs" }],
    }),
  );
  setup();
  expect(await screen.findByText(`Ready · ${CORDONED} · MemoryPressure`)).toBeInTheDocument();
  expect(screen.getByText("1 / 2 (50%)")).toBeInTheDocument();
  expect(screen.queryByText(NO_METRICS)).toBeNull();
  expect(screen.getByText(REQUESTS_PARTIAL)).toBeInTheDocument();
  expect(screen.getByText(SEC_NODEPOOLS)).toBeInTheDocument();
  expect(screen.getByText("default")).toBeInTheDocument();
  expect(screen.getByText(removedTitle("1.32"))).toBeInTheDocument();
  expect(screen.getByText("flowcontrol.apiserver.k8s.io/v1beta3")).toBeInTheDocument();
  expect(screen.getByText(NO_SKEW)).toBeInTheDocument();
});

test("gaps show next to their section and refresh refetches", async () => {
  m.overview.mockResolvedValue(overview({ addons: null, gaps: [{ section: "addons", error: { kind: "accessDenied", action: "eks:ListAddons" } }] }));
  setup();
  expect(await screen.findByText(gapText(SECTION_LABELS.addons))).toBeInTheDocument();
  expect(screen.getByText("권한 없음 (eks:ListAddons)")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: REFRESH }));
  await vi.waitFor(() => expect(m.overview).toHaveBeenCalledTimes(2));
});

test("a failed overview shows the error", async () => {
  m.overview.mockRejectedValue({ kind: "other", message: "먼저 연결해 주세요" });
  setup();
  expect(await screen.findByText("먼저 연결해 주세요")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run src/k8s/OverviewView.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `src/k8s/OverviewView.tsx`:

```tsx
import type { ReactNode } from "react";
import { ErrorState } from "../components/ErrorState";
import { formatBytes, formatCpu, percent } from "./format";
import { useK8sOverview } from "./queries";
import {
  COL_NAME, CORDONED, GROUP_KIND_LABELS, H_ADDON, H_CAPACITY_TYPE, H_CHECK, H_CPU_REQUESTED, H_CPU_USED, H_CURRENT_API, H_CURRENT_VERSION,
  H_INSTANCE_TYPE, H_ISSUES, H_KIND, H_KUBELET, H_LATEST_VERSION, H_MEMORY_REQUESTED, H_MEMORY_USED, H_NEW_API, H_NODEGROUP, H_REASON,
  H_SIZE_RANGE, H_STATE, H_VERSION, H_ZONE, L_AUTH_MODE, L_CIDRS, L_ENDPOINT, L_LOGGING, L_OIDC, L_PLATFORM, L_PRIVATE, L_PUBLIC,
  L_SECRETS_ENCRYPTION, L_STATUS, L_VERSION, LOADING, NO_INSIGHTS, NO_METRICS, NO_SKEW, NONE, OFF, ON, REFRESH, REQUESTS_PARTIAL,
  SECTION_LABELS, SEC_ADDONS, SEC_CLUSTER, SEC_FARGATE, SEC_NODEGROUPS, SEC_NODEPOOLS, SEC_NODES, SEC_UPGRADE, SUB_INSIGHTS, SUB_REMOVED,
  SUB_SKEW, UP_TO_DATE, gapText, noRemoved, removedTitle, skewText,
} from "./text";
import type { K8sNodeView, K8sOverview, K8sOverviewSection, K8sTarget } from "./types";

interface Props {
  target: K8sTarget;
  context: string;
  ssoProfile: string;
  live: boolean;
  onOpenNode: (name: string) => void;
}

/** EKS API 쪽 구역. 로그인할 프로필이 앱의 프로필이다(나머지는 kubeconfig의 exec 프로필). */
const EKS_SECTIONS = new Set<K8sOverviewSection>(["cluster", "nodegroups", "fargate", "addons", "insights"]);

const Sect = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="k8s-sect" aria-label={title}>
    <h4>{title}</h4>
    {children}
  </section>
);

function nodeStatus(n: K8sNodeView): string {
  return [n.ready ? "Ready" : "NotReady", n.unschedulable ? CORDONED : null, n.pressures.length > 0 ? n.pressures.join(", ") : null].filter(Boolean).join(" · ");
}

export function OverviewView({ target, context, ssoProfile, live, onOpenNode }: Props) {
  const q = useK8sOverview(target, context, ssoProfile, live);
  const refetch = () => void q.refetch();
  if (q.isError) return <ErrorState error={q.error} profile={target.profile} onRetry={refetch} onLoggedIn={refetch} />;
  if (!q.data) return <div className="empty">{LOADING}</div>;
  const o: K8sOverview = q.data;
  const gaps = (...sections: K8sOverviewSection[]) =>
    o.gaps
      .filter((g) => sections.includes(g.section))
      .map((g, i) => (
        <div key={`${g.section}-${i}`} className="k8s-gap">
          <p className="dim">{gapText(SECTION_LABELS[g.section])}</p>
          <ErrorState error={g.error} profile={EKS_SECTIONS.has(g.section) ? target.profile : ssoProfile} compact onRetry={refetch} onLoggedIn={refetch} />
        </div>
      ));
  const c = o.cluster;
  return (
    <div className="k8s-overview">
      <div className="k8s-actions">
        <button className="btn" onClick={refetch} disabled={q.isFetching}>{REFRESH}</button>
      </div>
      <Sect title={SEC_CLUSTER}>
        {gaps("cluster")}
        {c && (
          <dl className="kv">
            <dt>{L_VERSION}</dt><dd>{c.version}</dd>
            <dt>{L_PLATFORM}</dt><dd>{c.platformVersion ?? NONE}</dd>
            <dt>{L_STATUS}</dt><dd>{c.status ?? NONE}</dd>
            <dt>{L_ENDPOINT}</dt><dd>{[c.endpointPublic ? L_PUBLIC : null, c.endpointPrivate ? L_PRIVATE : null].filter(Boolean).join(", ")}</dd>
            <dt>{L_CIDRS}</dt><dd className="mono">{c.publicCidrs.join(", ") || NONE}</dd>
            <dt>{L_LOGGING}</dt><dd>{c.logging.length > 0 ? c.logging.join(", ") : OFF}</dd>
            <dt>{L_SECRETS_ENCRYPTION}</dt><dd>{c.secretsEncrypted ? ON : OFF}</dd>
            <dt>{L_OIDC}</dt><dd className="mono k8s-wrap">{c.oidcIssuer ?? NONE}</dd>
            <dt>{L_AUTH_MODE}</dt><dd>{c.authenticationMode ?? NONE}</dd>
          </dl>
        )}
      </Sect>
      <Sect title={SEC_NODES}>
        {gaps("nodes", "metrics")}
        {o.nodes && (
          <table className="k8s-table">
            <thead>
              <tr>
                <th>{COL_NAME}</th><th>{H_STATE}</th><th>{H_INSTANCE_TYPE}</th><th>{H_ZONE}</th><th>{H_NODEGROUP}</th><th>{H_KUBELET}</th>
                <th>{H_CPU_REQUESTED}</th><th>{H_MEMORY_REQUESTED}</th>
                {o.metrics && <><th>{H_CPU_USED}</th><th>{H_MEMORY_USED}</th></>}
              </tr>
            </thead>
            <tbody>
              {o.nodes.map((n) => (
                <tr key={n.name} className={n.ready ? undefined : "k8s-warn"}>
                  <td><button className="link mono" onClick={() => onOpenNode(n.name)}>{n.name}</button></td>
                  <td>{nodeStatus(n)}</td>
                  <td>{n.instanceType ?? ""}</td>
                  <td>{n.zone ?? ""}</td>
                  <td>{GROUP_KIND_LABELS[n.groupKind]}{n.group ? ` ${n.group}` : ""}</td>
                  <td className="mono">{n.kubeletVersion}</td>
                  <td>{`${formatCpu(n.requested.cpuMilli)} / ${formatCpu(n.allocatable.cpuMilli)} (${percent(n.requested.cpuMilli, n.allocatable.cpuMilli)})`}</td>
                  <td>{`${formatBytes(n.requested.memoryBytes)} / ${formatBytes(n.allocatable.memoryBytes)} (${percent(n.requested.memoryBytes, n.allocatable.memoryBytes)})`}</td>
                  {o.metrics && (
                    <>
                      <td>{n.usage ? `${formatCpu(n.usage.cpuMilli)} / ${formatCpu(n.allocatable.cpuMilli)} (${percent(n.usage.cpuMilli, n.allocatable.cpuMilli)})` : ""}</td>
                      <td>{n.usage ? `${formatBytes(n.usage.memoryBytes)} / ${formatBytes(n.allocatable.memoryBytes)} (${percent(n.usage.memoryBytes, n.allocatable.memoryBytes)})` : ""}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {o.nodes && !o.metrics && <p className="dim">{NO_METRICS}</p>}
        {o.requestsPartial && <p className="dim">{REQUESTS_PARTIAL}</p>}
      </Sect>
      <Sect title={SEC_NODEGROUPS}>
        {gaps("nodegroups")}
        {o.nodegroups && o.nodegroups.length > 0 && (
          <table className="k8s-table">
            <thead>
              <tr><th>{COL_NAME}</th><th>{H_STATE}</th><th>{H_VERSION}</th><th>{H_INSTANCE_TYPE}</th><th>{H_CAPACITY_TYPE}</th><th>{H_SIZE_RANGE}</th></tr>
            </thead>
            <tbody>
              {o.nodegroups.map((g) => (
                <tr key={g.name}>
                  <td className="mono">{g.name}</td><td>{g.status ?? ""}</td><td>{g.version ?? ""}</td><td>{g.instanceTypes.join(", ")}</td>
                  <td>{g.capacityType ?? ""}</td><td>{`${g.min ?? "-"} / ${g.desired ?? "-"} / ${g.max ?? "-"}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Sect>
      {(o.fargateProfiles?.length ?? 0) > 0 || o.gaps.some((g) => g.section === "fargate") ? (
        <Sect title={SEC_FARGATE}>
          {gaps("fargate")}
          <ul className="k8s-links">{o.fargateProfiles?.map((p) => <li key={p} className="mono">{p}</li>)}</ul>
        </Sect>
      ) : null}
      {(o.nodePools !== null || o.gaps.some((g) => g.section === "nodePools")) && (
        <Sect title={SEC_NODEPOOLS}>
          {gaps("nodePools")}
          <ul className="k8s-links">{o.nodePools?.map((p) => <li key={p} className="mono">{p}</li>)}</ul>
        </Sect>
      )}
      <Sect title={SEC_ADDONS}>
        {gaps("addons")}
        {o.addons && (
          <table className="k8s-table">
            <thead>
              <tr><th>{H_ADDON}</th><th>{H_CURRENT_VERSION}</th><th>{H_LATEST_VERSION}</th><th>{H_STATE}</th><th>{H_ISSUES}</th></tr>
            </thead>
            <tbody>
              {o.addons.map((a) => (
                <tr key={a.name}>
                  <td className="mono">{a.name}</td><td className="mono">{a.version ?? ""}</td>
                  <td className="mono">{a.latest !== null && a.latest === a.version ? UP_TO_DATE : a.latest ?? ""}</td>
                  <td>{a.status ?? ""}</td>
                  <td>{a.issues.map((i) => <div key={i}>{i}</div>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Sect>
      <Sect title={SEC_UPGRADE}>
        <h5>{SUB_INSIGHTS}</h5>
        {gaps("insights")}
        {o.insights &&
          (o.insights.length === 0 ? (
            <p className="dim">{NO_INSIGHTS}</p>
          ) : (
            <table className="k8s-table">
              <thead>
                <tr><th>{H_CHECK}</th><th>{H_STATE}</th><th>{H_REASON}</th></tr>
              </thead>
              <tbody>
                {o.insights.map((i) => (
                  <tr key={i.name} title={i.description ?? ""}><td>{i.name}</td><td>{i.status ?? ""}</td><td>{i.reason ?? ""}</td></tr>
                ))}
              </tbody>
            </table>
          ))}
        <h5>{SUB_REMOVED}</h5>
        {gaps("removedApis")}
        {o.nextVersion && o.removedApis && (
          o.removedApis.length === 0 ? (
            <p className="dim">{noRemoved(o.nextVersion)}</p>
          ) : (
            <>
              <p>{removedTitle(o.nextVersion)}</p>
              <table className="k8s-table">
                <thead>
                  <tr><th>{H_KIND}</th><th>{COL_NAME}</th><th>{H_CURRENT_API}</th><th>{H_NEW_API}</th></tr>
                </thead>
                <tbody>
                  {o.removedApis.map((r) => (
                    <tr key={`${r.kind}|${r.namespace}|${r.name}`}>
                      <td>{r.kind}</td><td className="mono">{r.namespace ? `${r.namespace}/${r.name}` : r.name}</td>
                      <td className="mono">{r.apiVersion}</td><td className="mono">{r.replacement}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )
        )}
        <h5>{SUB_SKEW}</h5>
        {o.skew.length === 0 ? (
          <p className="dim">{NO_SKEW}</p>
        ) : (
          <ul className="k8s-links">
            {o.skew.map((s) => (
              <li key={s.node}><span className="mono">{s.node}</span> ({s.kubeletVersion}): {skewText(s.minorsBehind)}</li>
            ))}
          </ul>
        )}
      </Sect>
    </div>
  );
}
```

Note: the `L_LOGGING` cell shows `OFF` when no log type is enabled; the first test expects exactly one `ON` (Secret 암호화) and one `OFF` (logging). If `skewText` sits inside a `<li>` with other text, the test uses `{ exact: false }`.

Append to `src/styles.css`:

```css
.k8s-overview { display: flex; flex-direction: column; }
.k8s-overview h5 { margin: 10px 0 4px; font-size: 12px; font-weight: 600; }
.k8s-gap { margin: 4px 0; }
.k8s-gap p { margin: 0 0 2px; font-size: 12px; }
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run src/k8s && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/k8s/OverviewView.tsx src/k8s/OverviewView.test.tsx src/styles.css
git commit -m "feat(k8s): overview of cluster, nodes, node groups, add-ons and upgrade checks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task K2-F8: Navigation, tab wiring, IAM link from the app

**Files:**
- Create: `src/k8s/K8sNav.tsx`, `src/k8s/K8sNav.test.tsx`
- Modify: `src/k8s/K8sTab.tsx`, `src/k8s/K8sTab.test.tsx`, `src/App.tsx`, `src/styles.css`

**Interfaces:**
- Consumes: Tasks K2-F1 (`useK8sKinds`), K2-F5 (`WorkloadsView`, `WorkloadsFocus`), K2-F6 (`EventsView`), K2-F7 (`OverviewView`), K2-F2 (`NODES`), K1 `K8sTab` internals, App's `openIam(focus: string | null)`.
- Produces:
  - `type K8sView = "overview" | "workloads" | "events" | "myRules"`
  - `function K8sNav(props: { view: K8sView; onSelect: (v: K8sView) => void }): JSX.Element` (uses the IAM nav classes; aria-label `NAV_LABEL`)
  - `K8sTab` props gain `onOpenIam?: (arn: string) => void`; default view `overview`.

- [ ] **Step 1: Write the failing tests**

Create `src/k8s/K8sNav.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { K8sNav } from "./K8sNav";
import { NAV_EVENTS, NAV_LABEL, NAV_MY_PERMISSIONS, NAV_OVERVIEW, NAV_WORKLOADS } from "./text";

test("four items in order, marks the current one, selects on click", () => {
  const onSelect = vi.fn();
  render(<K8sNav view="workloads" onSelect={onSelect} />);
  const nav = screen.getByRole("navigation", { name: NAV_LABEL });
  expect(Array.from(nav.querySelectorAll("button")).map((b) => b.textContent?.replace(/^\S+\s*/u, ""))).toEqual([NAV_OVERVIEW, NAV_WORKLOADS, NAV_EVENTS, NAV_MY_PERMISSIONS]);
  expect(screen.getByRole("button", { name: NAV_WORKLOADS })).toHaveAttribute("aria-current", "page");
  fireEvent.click(screen.getByRole("button", { name: NAV_EVENTS }));
  expect(onSelect).toHaveBeenCalledWith("events");
});
```

In `src/k8s/K8sTab.test.tsx`:
- Extend the `vi.mock("./api", …)` factory with `kinds: vi.fn(), get: vi.fn(), secretValue: vi.fn(), overview: vi.fn()`.
- In `beforeEach`, add `m.kinds.mockResolvedValue([]);` and `m.overview.mockResolvedValue(emptyOverview);` with

```ts
const emptyOverview = {
  cluster: null, nodes: [], requestsPartial: false, metrics: false, nodegroups: [], fargateProfiles: [], nodePools: null,
  addons: [], insights: [], removedApis: null, nextVersion: null, skew: [], gaps: [],
};
const openMyRules = () => fireEvent.click(screen.getByRole("button", { name: NAV_MY_PERMISSIONS }));
```

- Every existing test that asserts on 내 권한 content (the rules table, `CORE_GROUP`, `WILDCARD`, `RULES_INCOMPLETE`, `ALL_NAMESPACES_NOTE`, a rules error, `m.rules` calls) calls `openMyRules()` once the tab shows `STATE_CONNECTED`, before those assertions. Tests about context choice, the top bar, reconnect, and session errors are unchanged.
- Add (import `NAV_MY_PERMISSIONS, NAV_WORKLOADS, NAV_EVENTS, SEC_NODES` from `./text`, `EVENTS, NODES, PODS` from `./kinds`):

```ts
test("opens on the overview once connected", async () => {
  m.context.mockResolvedValue(info([cand("ctx")]));
  setup();
  await screen.findByText(STATE_CONNECTED);
  await waitFor(() => expect(m.overview).toHaveBeenCalledWith(target));
  expect(await screen.findByText(SEC_NODES)).toBeInTheDocument();
  expect(m.rules).not.toHaveBeenCalled();
  await waitFor(() => expect(m.kinds).toHaveBeenCalledWith(target, target.profile));
});

test("the nav switches to workloads (pods) and events", async () => {
  m.context.mockResolvedValue(info([cand("ctx")]));
  setup();
  await screen.findByText(STATE_CONNECTED);
  fireEvent.click(screen.getByRole("button", { name: NAV_WORKLOADS }));
  await waitFor(() => expect(watchCalls().some((c) => c[1].plural === PODS.plural)).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: NAV_EVENTS }));
  await waitFor(() => expect(watchCalls().some((c) => c[1].plural === EVENTS.plural)).toBe(true));
});

test("a node name in the overview opens its detail in workloads", async () => {
  m.context.mockResolvedValue(info([cand("ctx")]));
  m.overview.mockResolvedValue({ ...emptyOverview, nodes: [{
    name: "ip-1", ready: true, unschedulable: false, pressures: [], instanceType: null, zone: null, groupKind: "self", group: null, kubeletVersion: "v1.31.0",
    allocatable: { cpuMilli: 1000, memoryBytes: 1, pods: 1 }, requested: { cpuMilli: 0, memoryBytes: 0, pods: 0 }, usage: null,
  }] });
  m.get.mockResolvedValue({ kind: NODES, row: ns("ip-1"), annotations: {}, owners: [], children: [], childrenTruncated: false, childrenError: null, containers: [], conditions: [], events: [], eventsError: null, yaml: "", secretKeys: null });
  setup();
  fireEvent.click(await screen.findByRole("button", { name: "ip-1" }));
  await waitFor(() => expect(m.get).toHaveBeenCalledWith(target, NODES, null, "ip-1", target.profile));
  expect(screen.getByRole("button", { name: NAV_WORKLOADS })).toHaveAttribute("aria-current", "page");
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run src/k8s/K8sNav.test.tsx src/k8s/K8sTab.test.tsx`
Expected: FAIL (no `K8sNav`, the tab still shows only 내 권한).

- [ ] **Step 3: Implement**

Create `src/k8s/K8sNav.tsx`:

```tsx
import { NAV_EVENTS, NAV_LABEL, NAV_MY_PERMISSIONS, NAV_OVERVIEW, NAV_WORKLOADS } from "./text";

export type K8sView = "overview" | "workloads" | "events" | "myRules";

// 모양은 IAM·PG 메뉴(.iam-nav)를 그대로 쓴다. 이후 단계가 접근, 보안 점검 등을 더한다.
const ITEMS: { view: K8sView; icon: string; label: string; gap?: boolean }[] = [
  { view: "overview", icon: "📊", label: NAV_OVERVIEW },
  { view: "workloads", icon: "📦", label: NAV_WORKLOADS },
  { view: "events", icon: "🔔", label: NAV_EVENTS },
  { view: "myRules", icon: "🔑", label: NAV_MY_PERMISSIONS, gap: true },
];

export function K8sNav({ view, onSelect }: { view: K8sView; onSelect: (v: K8sView) => void }) {
  return (
    <nav className="iam-nav" aria-label={NAV_LABEL}>
      {ITEMS.map((item) => {
        const current = item.view === view;
        return (
          <button key={item.view} className={`iam-nav-item${current ? " on" : ""}${item.gap ? " gap" : ""}`} aria-current={current ? "page" : undefined} onClick={() => onSelect(item.view)}>
            <span className="iam-nav-ico" aria-hidden="true">{item.icon}</span>
            <span className="iam-nav-label">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
```

In `src/k8s/K8sTab.tsx`:
- Props: add `onOpenIam?: (arn: string) => void;` and destructure it.
- Imports: `K8sNav, type K8sView` from `./K8sNav`; `OverviewView`; `WorkloadsView, type WorkloadsFocus`; `EventsView`; `NODES` from `./kinds`; `useK8sKinds` from `./queries`. Drop the now-unused `NAV_MY_PERMISSIONS` import.
- State after `userNs`: 

```tsx
  const [view, setView] = useState<K8sView>("overview");
  const [focus, setFocus] = useState<WorkloadsFocus | null>(null);
```

- After `rules`:

```tsx
  const kinds = useK8sKinds(target, chosen, ssoProfile, live);
  const nsOrAll = namespace === ALL ? null : namespace;
  const openNode = (name: string) => {
    setFocus((f) => ({ ref: { kind: NODES, namespace: null, name }, nonce: (f?.nonce ?? 0) + 1 }));
    setView("workloads");
  };
```

- Replace the `<nav className="iam-nav" …>…</nav>` block with `<K8sNav view={view} onSelect={setView} />`, and the body with:

```tsx
        <div className={`k8s-body${view === "workloads" ? " flush" : ""}`}>
          {session.isError ? (
            <K8sError error={session.error} target={target} ssoProfile={ssoProfile} />
          ) : view === "overview" ? (
            <OverviewView target={target} context={chosen} ssoProfile={ssoProfile} live={live} onOpenNode={openNode} />
          ) : view === "workloads" ? (
            <WorkloadsView target={target} context={chosen} sessionEpoch={session.dataUpdatedAt} ssoProfile={ssoProfile} live={live} namespace={nsOrAll} kinds={kinds.data ?? []} focus={focus} onOpenIam={onOpenIam} />
          ) : view === "events" ? (
            <EventsView target={target} context={chosen} sessionEpoch={session.dataUpdatedAt} ssoProfile={ssoProfile} live={live} namespace={nsOrAll} />
          ) : rules.isError ? (
            <K8sError error={rules.error} target={target} ssoProfile={ssoProfile} />
          ) : rules.data ? (
            <MyRules rules={rules.data} allNamespaces={namespace === ALL} />
          ) : (
            <div className="empty">{STATE_CONNECTING}</div>
          )}
        </div>
```

- Read rules only on the 내 권한 view: pass `live && view === "myRules"` as `useK8sRules`'s `enabled` (the Secret pre-check in `ObjectDetail` asks for its own namespace).

In `src/App.tsx`, pass the IAM opener: `<K8sTab target={t.target} active={activeTab === t.id} onOpenIam={openIam} />`.

Append to `src/styles.css`: `.k8s-body.flush { padding: 0; display: flex; overflow: hidden; }`

- [ ] **Step 4: Run all checks**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: the whole suite passes (including `App.test.tsx`, which renders the real `K8sTab` with a connection that never finishes, so no overview call happens), type check and build succeed.

- [ ] **Step 5: Commit**

```bash
git add src/k8s/K8sNav.tsx src/k8s/K8sNav.test.tsx src/k8s/K8sTab.tsx src/k8s/K8sTab.test.tsx src/App.tsx src/styles.css
git commit -m "feat(k8s): tab navigation for overview, workloads, events and my permissions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task K2R: Whole-K2 review

**Files:** none (review only; fixes go to follow-up tasks on the same branch).

- [ ] **Step 1: Verify the branch**

Run: `cd src-tauri && cargo test --lib && cargo clippy --all-targets -- -D warnings`, then `npx vitest run && npx tsc --noEmit && npm run build`, then `scripts/k8s-live-test.sh`.
Expected: all green; live 18/18 on `v1.33.1` and `v1.35.0`.

- [ ] **Step 2: Review against the spec and this plan** (one reviewer, fresh context, given the spec sections in Global Constraints and the diff from the K1 tip `929781b`):
  - Spec coverage: 개요 (cluster settings, nodes with group kinds, requests vs allocatable, metrics-server usage, add-ons current/latest/issues, Upgrade Insights, removed-API table, version skew); 워크로드 (tree with CRDs, per-kind columns, problem flags, name/label filters, "문제 있는 것만", detail summary, ownership up/down, containers with last termination, related events, YAML, node link, IAM role link); 이벤트 (namespace/cluster, time order, Warning only); Secret 값 (list/detail show keys, type, sizes only; YAML masked; per-key read on click; component state only; dropped on leave).
  - Secrets: grep the backend for every place a Secret object is serialized (`row_of`, `view_of`, YAML, errors, `Debug`) and the frontend for any path that could cache a value (React Query, the watch registry, settings, `console`).
  - Time limits: every kube call goes through `bounded`, every EKS call through `eks::call`; every list has a page cap.
  - Hygiene: allow list unchanged; no write call in `read/`.
  - Query keys include the context; reconnect (`refreshK8s`) drops K2 data; watches resubscribe on `sessionEpoch`.
  - M1: after a non-fatal watch error the banner clears on the next `reset`.
  - Exact strings match Global Constraints and are compared through constants in tests.
- [ ] **Step 3: Record findings in `.superpowers/sdd/progress.md`** under a "Phase 10: EKS K2" heading, dispatch fix tasks for Important findings, and re-review until "Ready for K3".

