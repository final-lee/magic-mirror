# EKS 쿠버네티스 K1(연결) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Double-clicking an EKS cluster (or picking one from the sidebar) opens a `☸️ <cluster>` tab. The tab finds the cluster's kubeconfig context, connects through the context's exec plugin (`aws eks get-token`), and shows the identity the cluster sees, a namespace selector fed by a live watch, and "내 권한" (what this identity can do in the chosen namespace). Nothing is written to the cluster.

**Architecture:**
- **Backend:** a new `src-tauri/src/k8s/` module with:
  - `target.rs`: `DescribeCluster` → endpoint, ARN, version, endpoint access;
  - `kubeconfig.rs`: load and merge kubeconfig files, match contexts to the cluster, find the exec profile, inject `PATH` (pure);
  - `path.rs`: the login-shell `PATH` (read once);
  - `failure.rs`: classify connection failures into fixed Korean messages (pure);
  - `connect.rs`: build a `kube::Client` from the chosen context;
  - `review.rs`: `SelfSubjectReview` and `SelfSubjectRulesReview` (the only module allowed to call `create`);
  - `rows.rs`: turn a `DynamicObject` into a list row (pure);
  - `watch.rs`: one watcher task per subscription that streams batched rows to a Tauri `Channel`;
  - `hygiene.rs`: test that only allowed files call write APIs.
  - `k8s_commands.rs` holds `K8sState` and the Tauri commands.
- **Frontend:** a new `src/k8s/` tab. It reuses `ErrorState` (SSO login button), the settings hook, and the tab plumbing in `App.tsx`. A shared watch registry keeps one backend watch per (target, kind, namespace) and keeps it alive for 30 s after the last subscriber leaves.

**Tech Stack:** Tauri 2, Rust 1.96 (tokio, `kube` 4.2 + `kube-runtime`, `k8s-openapi` 0.28 (the version kube 4.2 depends on; 0.29 conflicts) with feature `v1_33`, rustls aws-lc-rs, aws-sdk-eks), React 18 + TS, TanStack Query, Vitest; Docker + kind for the live tests.

## Global Constraints
- Spec: `docs/superpowers/specs/2026-10-30-eks-kubernetes-design.md` (sections "대상과 탭", "접속", and the K1 row of "단계"). Branch: `feat/eks-k8s` (create from `main` before the first task). No release at the end of K1: the release happens after KR.
- **No writes:** K1 writes nothing to any cluster. Under `src-tauri/src/k8s/` and `src-tauri/src/k8s_commands.rs`, only `k8s/review.rs` may call `Api::create`, and only for `SelfSubjectReview` and `SelfSubjectRulesReview`. Nothing calls `patch`, `replace`, `delete`, `delete_collection`, `create_subresource`, `patch_subresource`, `replace_subresource`, `evict`, `exec`, `attach`, or `portforward`, and nothing builds a raw `POST`/`PUT`/`PATCH`/`DELETE` request. `k8s/hygiene.rs` (Task KB1) enforces this; later phases add `k8s/exec.rs`, `k8s/shell.rs`, `k8s/forward.rs` to its allow list.
- **Secrets:** bearer tokens, client keys, and exec credential output never go into logs, errors, settings, or command results. Error messages may quote the first line of the exec plugin's stderr only after `redact_secrets` (Task KB2) removes anything that looks like a token.
- **TLS:** `kube` with `rustls-tls` + `aws-lc-rs`, `default-features = false` (no `ring`, no `openssl`). Never set `accept_invalid_certs`, never strip `certificate-authority-data`.
- **Identity:** connect only through the kubeconfig context's own auth (exec plugin, token, or client cert). The app never mints tokens itself.
- **UI copy:** Korean 해요체. Code identifiers and commit messages are in English. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Exact strings** (Rust constants in `k8s/failure.rs` and `k8s/kubeconfig.rs`, TS constants in `src/k8s/text.ts`; tests compare to these constants, not to retyped literals):
  - No kubeconfig file: `kubeconfig 파일이 없어요(${paths joined with ", "}). 터미널에서 아래 명령을 실행한 뒤 다시 열어 주세요`
  - Unreadable kubeconfig: `kubeconfig를 읽지 못했어요(${path}): ${reason}`
  - No matching context: "kubeconfig에 이 클러스터의 context가 없어요. 터미널에서 아래 명령을 실행한 뒤 다시 열어 주세요"
  - Update command: `aws eks update-kubeconfig --name ${cluster} --region ${region} --profile ${profile}`
  - Several contexts: "이 클러스터를 가리키는 context가 여러 개예요. 접속할 context를 골라 주세요"
  - Saved context gone (shown above the picker): `저장해 둔 context ${name}이(가) kubeconfig에 없어요. 다시 골라 주세요`
  - Exec command missing: `kubeconfig의 인증 명령(${command})을 찾지 못했어요. aws CLI가 설치돼 있는지 확인해 주세요`
  - Exec failed: `kubeconfig의 인증 명령이 실패했어요: ${first stderr line, redacted, max 300 chars}`
  - Unreachable, private only: "클러스터 엔드포인트에 연결하지 못했어요. 프라이빗 엔드포인트라서 Tailscale 연결을 확인해 주세요"
  - Unreachable, public only: "클러스터 엔드포인트에 연결하지 못했어요. 엔드포인트의 허용 CIDR에 이 컴퓨터의 IP가 있는지 확인해 주세요"
  - Unreachable, both: "클러스터 엔드포인트에 연결하지 못했어요. Tailscale 연결이나 엔드포인트의 허용 CIDR을 확인해 주세요"
  - TLS: "클러스터 인증서를 확인하지 못했어요"
  - 401: "클러스터가 이 신원을 알아보지 못했어요. EKS access entry나 aws-auth ConfigMap에 등록돼 있는지 확인해 주세요"
  - 403: `AppError::AccessDenied { action }` with action `"${verb} ${resource}"` (for example `"list namespaces"`, `"create selfsubjectrulesreviews"`); the existing UI renders `권한 없음 (list namespaces)`.
  - SSO expired in exec output: `AppError::SsoExpired` (the frontend reports the context's exec profile, see KF1).
  - Not opened yet: "먼저 연결해 주세요"
  - Identity fallback note: "이 클러스터에서는 신원을 물어볼 수 없어 kubeconfig의 사용자 이름을 보여줘요"
  - Profile mismatch: `kubeconfig는 프로필 ${execProfile}로 접속해요(앱에서 고른 프로필: ${profile})`
  - Rules incomplete: "이 네임스페이스의 권한 목록이 완전하지 않아요. 버튼은 켜 두고 실제 요청에서 서버가 판단해요"
  - Tab title: `☸️ ${cluster}`; sidebar row: "☸️ 클러스터 관리"; picker title "EKS 클러스터"; picker empty: "이 리전에 EKS 클러스터가 없어요"
  - Top bar labels: "context", "신원", "그룹", "네임스페이스", option "모든 네임스페이스", button "다시 연결"
  - Connection states: "연결 중…", "연결됨", "연결 안 됨"
  - Nav (K1 has one view): "내 권한"
  - Rules table headers: "동작", "API 그룹", "리소스", "이름"; core group shown as "(core)"; `*` shown as "모두"
  - Copy button: "복사", after copying: "복사했어요"; recheck button: "다시 확인"
  - Settings field label: "kubeconfig 경로", placeholder "비우면 KUBECONFIG 또는 ~/.kube/config"
- **Limits:** connect timeout 10 s; exec plugin and review requests 30 s; login-shell `PATH` read 3 s; watch batches flush every 100 ms or at 500 rows; watch list page size 500; watch linger after last subscriber 30 s.
- **Fallback PATH** (when the login shell read fails): `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`.

## Contract (Tauri commands)
Rust types are `#[serde(rename_all = "camelCase")]`. TS mirrors live in `src/k8s/types.ts`.

```ts
type K8sTarget = { profile: string; region: string; cluster: string };

interface K8sContextCandidate {
  name: string;               // context name
  cluster: string;            // kubeconfig cluster entry name
  user: string;               // kubeconfig user entry name
  namespace: string | null;   // context default namespace
  execProfile: string | null; // `--profile` arg or AWS_PROFILE of the exec plugin
}
interface K8sContextInfo {
  arn: string;
  endpoint: string;
  version: string;
  endpointPublic: boolean;
  endpointPrivate: boolean;
  publicCidrs: string[];
  kubeconfigPaths: string[];         // files that were read, in merge order
  candidates: K8sContextCandidate[]; // contexts pointing at this cluster, kubeconfig order
  chosen: string | null;             // saved context if still a candidate, else the only candidate, else null
  savedMissing: string | null;       // the saved context name when it is no longer a candidate
  updateCommand: string;
}
interface K8sIdentity { username: string; groups: string[]; arn: string | null; source: "selfSubjectReview" | "kubeconfig" }
interface K8sSession { context: string; execProfile: string | null; identity: K8sIdentity; serverVersion: string }
interface K8sResourceRule { verbs: string[]; apiGroups: string[]; resources: string[]; resourceNames: string[] }
interface K8sNonResourceRule { verbs: string[]; nonResourceUrls: string[] }
interface K8sRules { namespace: string; resourceRules: K8sResourceRule[]; nonResourceRules: K8sNonResourceRule[]; incomplete: boolean }
interface K8sKindRef { group: string; version: string; kind: string; plural: string; namespaced: boolean }
interface K8sRow {
  uid: string; name: string; namespace: string | null; resourceVersion: string;
  createdAt: string | null; labels: Record<string, string>; values: Record<string, string>;
}
type K8sWatchMessage =
  | { type: "reset"; rows: K8sRow[] }
  | { type: "changes"; upserts: K8sRow[]; deletes: string[] }   // deletes are uids
  | { type: "error"; error: AppError; fatal: boolean };

k8s_context(target, kubeconfig: string | null, saved: string | null): K8sContextInfo   // reads files + DescribeCluster; never runs exec
k8s_open(target, kubeconfig: string | null, context: string): K8sSession              // connects, identity
k8s_close(target): void
k8s_rules(target, namespace: string): K8sRules
k8s_watch(target, kind: K8sKindRef, namespace: string | null, onEvent: Channel<K8sWatchMessage>): number
k8s_unwatch(watchId: number): void
```
- Every `k8s_*` call except `k8s_context` passes a top-level `profile` equal to `session.execProfile ?? candidate.execProfile ?? target.profile` in addition to `target`. Tauri ignores the extra key; `src/api/invoke.ts` reads top-level `profile` first, so an SSO expiry inside the exec plugin triggers the login for the profile the exec plugin uses.
- Fields are only ever added in later phases.

## File map
- Create `src-tauri/src/k8s/{mod.rs,target.rs,kubeconfig.rs,path.rs,failure.rs,connect.rs,review.rs,rows.rs,watch.rs,hygiene.rs,live_tests.rs}`, `src-tauri/src/k8s_commands.rs`, `scripts/k8s-live-test.sh`.
- Modify `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src-tauri/src/settings.rs`.
- Create `src/k8s/{types.ts,text.ts,api.ts,targets.ts,queries.ts,can.ts,watchRegistry.ts,useK8sWatch.ts,K8sTab.tsx,K8sError.tsx,ContextPicker.tsx,NoContext.tsx,TopBar.tsx,MyRules.tsx,ClusterPicker.tsx}` with tests next to them.
- Modify `src/App.tsx`, `src/components/{MainArea.tsx,ResourceArea.tsx,Sidebar.tsx,ServiceSettings.tsx}`, `src/api/types.ts`, `src/styles.css`.

---

### Task KB1: Dependencies, module skeleton, kubeconfig matching, hygiene

**Files:**
- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`
- Create: `src-tauri/src/k8s/mod.rs`, `src-tauri/src/k8s/kubeconfig.rs`, `src-tauri/src/k8s/hygiene.rs`

**Interfaces:**
- Produces:
  - `pub struct Loaded { pub config: kube::config::Kubeconfig, pub paths: Vec<PathBuf> }`
  - `pub fn kubeconfig_paths(setting: Option<&str>, env: Option<&str>, home: Option<&Path>) -> Vec<PathBuf>`
  - `pub fn load(paths: &[PathBuf]) -> Result<Loaded, AppError>`
  - `pub fn candidates(config: &Kubeconfig, arn: &str, endpoint: &str) -> Vec<Candidate>` where `Candidate` is the Rust twin of `K8sContextCandidate` (`#[derive(Debug, Clone, PartialEq, Serialize)] #[serde(rename_all = "camelCase")]`)
  - `pub fn choose(candidates: &[Candidate], saved: Option<&str>) -> (Option<String>, Option<String>)` → `(chosen, saved_missing)`
  - `pub fn exec_profile(user: &kube::config::AuthInfo) -> Option<String>`
  - `pub fn with_path(config: &Kubeconfig, context: &str, path: &str) -> Kubeconfig` (adds `PATH` to the exec env of the context's user when the exec env has no `PATH`)
  - `pub fn update_command(cluster: &str, region: &str, profile: &str) -> String`
  - Constants `NO_KUBECONFIG`, `UNREADABLE_KUBECONFIG`, `NO_CONTEXT`, `SEVERAL_CONTEXTS` per Global Constraints (format via small fns where they take values).

- [ ] **Step 1: Create the branch and add dependencies**

```bash
git switch -c feat/eks-k8s main
```
In `src-tauri/Cargo.toml` `[dependencies]`, after `aws-sdk-eks = "1"`:
```toml
# EKS 탭: kubeconfig의 exec 플러그인으로 접속하는 쿠버네티스 클라이언트. TLS는 앱의 다른 곳처럼 rustls + aws-lc-rs만 쓴다
kube = { version = "4.2", default-features = false, features = ["client", "config", "runtime", "rustls-tls", "aws-lc-rs"] }
k8s-openapi = { version = "0.29", features = ["v1_33"] }
```
Run: `cd src-tauri && cargo build` — Expected: builds. If `kube` 4.2's feature names differ, run `cargo info kube@4.2` and use the listed names; keep `default-features = false`.

- [ ] **Step 2: Module skeleton**

`src-tauri/src/k8s/mod.rs`:
```rust
//! EKS 탭. kubeconfig의 context로 접속해 클러스터를 읽는다. K1은 클러스터에 아무것도 쓰지 않는다(`hygiene`이 지킨다).
pub mod kubeconfig;

#[cfg(test)]
mod hygiene;
```
In `src-tauri/src/lib.rs` add `mod k8s;` after `mod jsonl;` (keep alphabetical order of the existing list).

- [ ] **Step 3: Write failing tests for kubeconfig matching**

`src-tauri/src/k8s/kubeconfig.rs` test module (`#[cfg(test)] mod tests`), with a fixture shaped exactly like `aws eks update-kubeconfig` output:
```rust
const ARN: &str = "arn:aws:eks:ap-northeast-2:111111111111:cluster/prod";
const ENDPOINT: &str = "https://ABCDEF.gr7.ap-northeast-2.eks.amazonaws.com";
const FIXTURE: &str = r#"
apiVersion: v1
kind: Config
clusters:
- name: arn:aws:eks:ap-northeast-2:111111111111:cluster/prod
  cluster: { server: "https://ABCDEF.gr7.ap-northeast-2.eks.amazonaws.com", certificate-authority-data: "Zm9v" }
- name: prod-alias
  cluster: { server: "https://abcdef.gr7.ap-northeast-2.eks.amazonaws.com/" }
- name: other
  cluster: { server: "https://OTHER.eks.amazonaws.com" }
contexts:
- name: arn:aws:eks:ap-northeast-2:111111111111:cluster/prod
  context: { cluster: "arn:aws:eks:ap-northeast-2:111111111111:cluster/prod", user: "arn-user" }
- name: prod-admin
  context: { cluster: prod-alias, user: admin-user, namespace: ops }
- name: other
  context: { cluster: other, user: arn-user }
users:
- name: arn-user
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws
      args: ["--region", "ap-northeast-2", "eks", "get-token", "--cluster-name", "prod", "--output", "json", "--profile", "prod-ro"]
- name: admin-user
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws
      args: ["eks", "get-token", "--cluster-name", "prod"]
      env: [{ name: AWS_PROFILE, value: prod-admin }]
"#;

fn fixture() -> Kubeconfig { serde_yaml::from_str(FIXTURE).unwrap() }

#[test]
fn matches_by_arn_name_or_endpoint_case_and_slash_insensitively() {
    let c = candidates(&fixture(), ARN, ENDPOINT);
    let names: Vec<_> = c.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, [ARN, "prod-admin"]);
    assert_eq!(c[1].namespace.as_deref(), Some("ops"));
}

#[test]
fn exec_profile_from_args_or_env() {
    let c = candidates(&fixture(), ARN, ENDPOINT);
    assert_eq!(c[0].exec_profile.as_deref(), Some("prod-ro"));
    assert_eq!(c[1].exec_profile.as_deref(), Some("prod-admin"));
}

#[test]
fn exec_profile_equals_form_and_missing() {
    let user: AuthInfo = serde_yaml::from_str(r#"exec: { apiVersion: client.authentication.k8s.io/v1beta1, command: aws, args: ["--profile=dev"] }"#).unwrap();
    assert_eq!(exec_profile(&user).as_deref(), Some("dev"));
    let user: AuthInfo = serde_yaml::from_str(r#"exec: { apiVersion: client.authentication.k8s.io/v1beta1, command: aws, args: ["eks", "get-token"] }"#).unwrap();
    assert_eq!(exec_profile(&user), None);
    let user: AuthInfo = serde_yaml::from_str(r#"token: abc"#).unwrap();
    assert_eq!(exec_profile(&user), None);
}

#[test]
fn choose_saved_only_or_none() {
    let c = candidates(&fixture(), ARN, ENDPOINT);
    assert_eq!(choose(&c, Some("prod-admin")), (Some("prod-admin".into()), None));
    assert_eq!(choose(&c, Some("gone")), (None, Some("gone".into())));
    assert_eq!(choose(&c, None), (None, None));
    assert_eq!(choose(&c[..1], None), (Some(ARN.into()), None));
    assert_eq!(choose(&c[..1], Some("gone")), (Some(ARN.into()), Some("gone".into())));
}

#[test]
fn paths_setting_then_env_then_home() {
    let home = Path::new("/Users/me");
    assert_eq!(kubeconfig_paths(Some("/x/kc"), Some("/a:/b"), Some(home)), [PathBuf::from("/x/kc")]);
    assert_eq!(kubeconfig_paths(Some("  "), Some("/a::/b"), Some(home)), [PathBuf::from("/a"), PathBuf::from("/b")]);
    assert_eq!(kubeconfig_paths(None, None, Some(home)), [PathBuf::from("/Users/me/.kube/config")]);
    assert_eq!(kubeconfig_paths(Some("~/kc"), None, Some(home)), [PathBuf::from("/Users/me/kc")]);
}

#[test]
fn load_merges_first_wins_and_skips_missing_files() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a");
    std::fs::write(&a, FIXTURE).unwrap();
    let b = dir.path().join("b");
    std::fs::write(&b, "apiVersion: v1\nkind: Config\ncontexts:\n- name: other\n  context: { cluster: x, user: y }\n- name: extra\n  context: { cluster: x, user: y }\n").unwrap();
    let loaded = load(&[dir.path().join("missing"), a.clone(), b.clone()]).unwrap();
    assert_eq!(loaded.paths, [a, b]);
    let other = loaded.config.contexts.iter().find(|c| c.name == "other").unwrap();
    assert_eq!(other.context.as_ref().unwrap().cluster, "other");
    assert!(loaded.config.contexts.iter().any(|c| c.name == "extra"));
}

#[test]
fn load_errors() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("missing");
    assert_eq!(load(&[missing.clone()]).unwrap_err(), AppError::other(no_kubeconfig(&[missing])));
    let bad = dir.path().join("bad");
    std::fs::write(&bad, "{not yaml").unwrap();
    let AppError::Other { message } = load(&[bad.clone()]).unwrap_err() else { panic!() };
    assert!(message.starts_with(&format!("kubeconfig를 읽지 못했어요({})", bad.display())), "{message}");
}

#[test]
fn with_path_adds_path_once() {
    let kc = with_path(&fixture(), "prod-admin", "/opt/homebrew/bin:/usr/bin");
    let user = kc.auth_infos.iter().find(|u| u.name == "admin-user").unwrap();
    let env = user.auth_info.as_ref().unwrap().exec.as_ref().unwrap().env.clone().unwrap();
    assert!(env.iter().any(|e| e.get("name").map(String::as_str) == Some("PATH")));
    let again = with_path(&kc, "prod-admin", "/other");
    let env2 = again.auth_infos.iter().find(|u| u.name == "admin-user").unwrap().auth_info.as_ref().unwrap().exec.as_ref().unwrap().env.clone().unwrap();
    assert_eq!(env2.iter().filter(|e| e.get("name").map(String::as_str) == Some("PATH")).count(), 1);
    // 다른 사용자는 건드리지 않는다
    let arn_user = kc.auth_infos.iter().find(|u| u.name == "arn-user").unwrap();
    assert!(arn_user.auth_info.as_ref().unwrap().exec.as_ref().unwrap().env.is_none());
}

#[test]
fn update_command_text() {
    assert_eq!(update_command("prod", "ap-northeast-2", "prod-ro"), "aws eks update-kubeconfig --name prod --region ap-northeast-2 --profile prod-ro");
}
```
The `ExecConfig.env` field type in kube 4.2 is `Option<Vec<HashMap<String, String>>>`; if docs.rs shows another shape, adjust the test helpers, not the behavior. Add `serde_yaml` only as a dev-dependency if `kube::config::Kubeconfig::from_yaml` is not public; prefer `Kubeconfig::from_yaml(FIXTURE)` when it exists.

Run: `cd src-tauri && cargo test --lib k8s::kubeconfig` — Expected: FAIL (functions not defined).

- [ ] **Step 4: Implement `kubeconfig.rs`**

```rust
//! kubeconfig 읽기와 이 클러스터를 가리키는 context 찾기. 순수 함수만 있다(파일 읽기는 `load` 하나).
//! 인증 정보(토큰, 키, 인증서)는 읽은 그대로 `kube`에 넘기고 어디에도 꺼내 쓰지 않는다.

use std::path::{Path, PathBuf};

use kube::config::{AuthInfo, Kubeconfig};
use serde::Serialize;

use crate::error::AppError;

pub const NO_CONTEXT: &str = "kubeconfig에 이 클러스터의 context가 없어요. 터미널에서 아래 명령을 실행한 뒤 다시 열어 주세요";
pub const SEVERAL_CONTEXTS: &str = "이 클러스터를 가리키는 context가 여러 개예요. 접속할 context를 골라 주세요";

pub fn no_kubeconfig(paths: &[PathBuf]) -> String {
    let list: Vec<String> = paths.iter().map(|p| p.display().to_string()).collect();
    format!("kubeconfig 파일이 없어요({}). 터미널에서 아래 명령을 실행한 뒤 다시 열어 주세요", list.join(", "))
}

pub fn unreadable_kubeconfig(path: &Path, reason: &str) -> String {
    format!("kubeconfig를 읽지 못했어요({}): {reason}", path.display())
}

pub fn update_command(cluster: &str, region: &str, profile: &str) -> String {
    format!("aws eks update-kubeconfig --name {cluster} --region {region} --profile {profile}")
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub name: String,
    pub cluster: String,
    pub user: String,
    pub namespace: Option<String>,
    pub exec_profile: Option<String>,
}

pub struct Loaded {
    pub config: Kubeconfig,
    pub paths: Vec<PathBuf>,
}

/// 읽을 파일들: 앱 설정 → `KUBECONFIG`(콜론으로 나눈 목록, 빈 칸은 건너뜀) → `~/.kube/config`. 설정의 `~/`는 홈으로 바꾼다.
pub fn kubeconfig_paths(setting: Option<&str>, env: Option<&str>, home: Option<&Path>) -> Vec<PathBuf> {
    let expand = |p: &str| match (p.strip_prefix("~/"), home) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(p),
    };
    if let Some(s) = setting.map(str::trim).filter(|s| !s.is_empty()) {
        return vec![expand(s)];
    }
    if let Some(list) = env.filter(|e| !e.trim().is_empty()) {
        return list.split(':').map(str::trim).filter(|p| !p.is_empty()).map(expand).collect();
    }
    home.map(|h| vec![h.join(".kube").join("config")]).unwrap_or_default()
}

/// 있는 파일만 읽어 합친다(kubectl처럼 같은 이름은 앞 파일이 이긴다). 하나도 없으면 `no_kubeconfig`, 읽다가 깨지면 `unreadable_kubeconfig`.
pub fn load(paths: &[PathBuf]) -> Result<Loaded, AppError> {
    let mut merged: Option<Kubeconfig> = None;
    let mut read = Vec::new();
    for path in paths {
        if !path.is_file() {
            continue;
        }
        let kc = Kubeconfig::read_from(path).map_err(|e| AppError::other(unreadable_kubeconfig(path, &e.to_string())))?;
        merged = Some(match merged {
            None => kc,
            Some(m) => m.merge(kc).map_err(|e| AppError::other(unreadable_kubeconfig(path, &e.to_string())))?,
        });
        read.push(path.clone());
    }
    merged.map(|config| Loaded { config, paths: read }).ok_or_else(|| AppError::other(no_kubeconfig(paths)))
}

fn same_server(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.trim().trim_end_matches('/').to_ascii_lowercase();
    norm(a) == norm(b)
}

/// 이 클러스터를 가리키는 context들(kubeconfig 순서). context의 클러스터 이름이 ARN이거나 그 클러스터의 server가 엔드포인트와 같으면 맞다.
pub fn candidates(config: &Kubeconfig, arn: &str, endpoint: &str) -> Vec<Candidate> {
    config
        .contexts
        .iter()
        .filter_map(|named| {
            let ctx = named.context.as_ref()?;
            let server = config.clusters.iter().find(|c| c.name == ctx.cluster).and_then(|c| c.cluster.as_ref()).and_then(|c| c.server.clone());
            let hit = ctx.cluster == arn || server.is_some_and(|s| same_server(&s, endpoint));
            if !hit {
                return None;
            }
            let user = ctx.user.clone().unwrap_or_default();
            let exec_profile = config.auth_infos.iter().find(|u| u.name == user).and_then(|u| u.auth_info.as_ref()).and_then(exec_profile);
            Some(Candidate { name: named.name.clone(), cluster: ctx.cluster.clone(), user, namespace: ctx.namespace.clone(), exec_profile })
        })
        .collect()
}

/// 저장해 둔 context가 아직 후보면 그것, 아니면 후보가 하나일 때 그것. 두 번째 값은 사라진 저장값(안내용).
pub fn choose(candidates: &[Candidate], saved: Option<&str>) -> (Option<String>, Option<String>) {
    if let Some(saved) = saved {
        if candidates.iter().any(|c| c.name == saved) {
            return (Some(saved.to_string()), None);
        }
    }
    let missing = saved.map(str::to_string);
    match candidates {
        [only] => (Some(only.name.clone()), missing),
        _ => (None, missing),
    }
}

/// exec 플러그인이 쓰는 AWS 프로필: `--profile x`, `--profile=x`, 그다음 env의 `AWS_PROFILE`.
pub fn exec_profile(user: &AuthInfo) -> Option<String> {
    let exec = user.exec.as_ref()?;
    let args = exec.args.clone().unwrap_or_default();
    for (i, arg) in args.iter().enumerate() {
        if let Some(v) = arg.strip_prefix("--profile=") {
            return Some(v.to_string());
        }
        if arg == "--profile" {
            if let Some(v) = args.get(i + 1) {
                return Some(v.clone());
            }
        }
    }
    exec.env.as_ref()?.iter().find(|e| e.get("name").map(String::as_str) == Some("AWS_PROFILE")).and_then(|e| e.get("value").cloned())
}

/// macOS 앱은 셸의 PATH를 물려받지 않는다. context 사용자의 exec env에 PATH가 없으면 넣은 사본을 돌려준다.
pub fn with_path(config: &Kubeconfig, context: &str, path: &str) -> Kubeconfig {
    let mut kc = config.clone();
    let Some(user) = kc.contexts.iter().find(|c| c.name == context).and_then(|c| c.context.as_ref()).and_then(|c| c.user.clone()) else {
        return kc;
    };
    if let Some(exec) = kc.auth_infos.iter_mut().find(|u| u.name == user).and_then(|u| u.auth_info.as_mut()).and_then(|a| a.exec.as_mut()) {
        let env = exec.env.get_or_insert_with(Vec::new);
        if !env.iter().any(|e| e.get("name").map(String::as_str) == Some("PATH")) {
            env.push([("name".to_string(), "PATH".to_string()), ("value".to_string(), path.to_string())].into_iter().collect());
        }
    }
    kc
}
```
Add `pub mod kubeconfig;` (done in Step 2). Adapt field access (`context.user` may be `Option<String>` or `String` in kube 4.2) so the code compiles; keep behavior identical.

- [ ] **Step 5: Run tests**

Run: `cd src-tauri && cargo test --lib k8s::kubeconfig` — Expected: PASS.

- [ ] **Step 6: Hygiene test**

`src-tauri/src/k8s/hygiene.rs`:
```rust
//! 클러스터에 쓰는 호출이 허용된 파일 밖에 없는지 글자로 확인한다(PG의 `pg::hygiene`과 같은 방식).
//! K1에서 허용되는 것은 `review.rs`의 `create`(SelfSubjectReview, SelfSubjectRulesReview) 하나다. 이후 단계가 `exec.rs`, `shell.rs`, `forward.rs`를 더한다.

use std::fs;
use std::path::{Path, PathBuf};

const WRITE_CALLS: &[&str] = &[
    ".create(", ".patch(", ".replace(", ".delete(", ".delete_collection(", ".create_subresource(", ".patch_subresource(",
    ".replace_subresource(", ".evict(", ".exec(", ".attach(", ".portforward(", "Method::POST", "Method::PUT", "Method::PATCH",
    "Method::DELETE", "Request::post", "Request::put", "Request::patch", "Request::delete",
];
/// (파일, 허용하는 호출)
const ALLOWED: &[(&str, &[&str])] = &[("k8s/review.rs", &[".create("])];

fn sources() -> Vec<PathBuf> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut out = vec![root.join("k8s_commands.rs")];
    let mut stack = vec![root.join("k8s")];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|e| e == "rs") && !path.ends_with("hygiene.rs") {
                out.push(path);
            }
        }
    }
    out.into_iter().filter(|p| p.exists()).collect()
}

/// 테스트 모듈(`#[cfg(test)]` 아래)은 빼고 본다: 그 줄부터 파일 끝까지 버린다. 테스트는 이 파일 맨 끝의 `mod tests;`나 `mod tests { … }`에만 둔다.
fn production_part(text: &str) -> &str {
    text.find("#[cfg(test)]").map_or(text, |at| &text[..at])
}

#[test]
fn only_allowed_files_call_write_apis() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut bad = Vec::new();
    for path in sources() {
        let rel = path.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/");
        let allowed: &[&str] = ALLOWED.iter().find(|(f, _)| *f == rel).map_or(&[], |(_, calls)| *calls);
        let text = fs::read_to_string(&path).unwrap();
        for call in WRITE_CALLS.iter().filter(|c| !allowed.contains(c)) {
            if production_part(&text).contains(call) {
                bad.push(format!("{rel}: {call}"));
            }
        }
    }
    assert!(bad.is_empty(), "쓰기 호출은 허용된 파일에서만: {bad:?}");
}

#[test]
fn the_scan_sees_k8s_files() {
    assert!(sources().iter().any(|p| p.ends_with("kubeconfig.rs")));
}
```
Every K8s module keeps its tests either in a trailing `#[cfg(test)] mod tests { … }` block or a `#[cfg(test)] mod tests;` line at the end of the file, so `production_part` stays correct. The `#[cfg(test)] mod hygiene;` line in `mod.rs` is at the end of that file for the same reason.

Run: `cd src-tauri && cargo test --lib k8s::` — Expected: PASS. Then `cargo clippy --all-targets -- -D warnings` — Expected: clean (mark unused-for-now items `pub(crate)` and use them in tests, or allow nothing; do not add `#[allow]`).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/src/k8s
git commit -m "feat(k8s): kubeconfig loading and context matching

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task KB2: Login-shell PATH and failure classification

**Files:**
- Create: `src-tauri/src/k8s/path.rs`, `src-tauri/src/k8s/failure.rs`
- Modify: `src-tauri/src/k8s/mod.rs`

**Interfaces:**
- Consumes: nothing from KB1 except `AppError`.
- Produces:
  - `pub const FALLBACK_PATH: &str`
  - `pub fn merge_path(shell: Option<&str>) -> String` (pure)
  - `pub async fn login_path() -> &'static str` (reads once with `tokio::sync::OnceCell`, 3 s timeout)
  - `pub enum Failure { ExecMissing { command: String }, ExecFailed { stderr: String }, SsoExpired, Unreachable, Tls, Unauthorized, Forbidden { verb: String, resource: String }, Other(String) }`
  - `pub struct Endpoint { pub public: bool, pub private: bool }`
  - `pub fn describe(f: &Failure, endpoint: Endpoint) -> AppError`
  - `pub fn failure_of(e: &kube::Error, verb: &str, resource: &str) -> Failure`
  - `pub fn redact_secrets(text: &str) -> String`
  - String constants per Global Constraints.

- [ ] **Step 1: Failing tests for `merge_path`**

`path.rs` tests:
```rust
#[test]
fn shell_path_first_then_missing_fallback_entries() {
    assert_eq!(merge_path(Some("/Users/me/bin:/usr/bin\n")), "/Users/me/bin:/usr/bin:/opt/homebrew/bin:/usr/local/bin:/bin:/usr/sbin:/sbin");
    assert_eq!(merge_path(None), FALLBACK_PATH);
    assert_eq!(merge_path(Some("   ")), FALLBACK_PATH);
}
```
Run: `cargo test --lib k8s::path` — Expected: FAIL.

- [ ] **Step 2: Implement `path.rs`**

```rust
//! exec 플러그인(`aws`)을 찾을 PATH. Finder에서 켠 앱은 셸의 PATH를 물려받지 않아서 로그인 셸에 한 번 물어본다.
use std::time::Duration;

use tokio::process::Command;
use tokio::sync::OnceCell;

pub const FALLBACK_PATH: &str = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const SHELL_TIMEOUT: Duration = Duration::from_secs(3);

/// 셸이 알려 준 PATH 뒤에, 거기 없는 기본 경로를 붙인다.
pub fn merge_path(shell: Option<&str>) -> String {
    let mut parts: Vec<&str> = shell.unwrap_or("").trim().split(':').filter(|p| !p.is_empty()).collect();
    for p in FALLBACK_PATH.split(':') {
        if !parts.contains(&p) {
            parts.push(p);
        }
    }
    parts.join(":")
}

static LOGIN_PATH: OnceCell<String> = OnceCell::const_new();

pub async fn login_path() -> &'static str {
    LOGIN_PATH
        .get_or_init(|| async {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
            let run = Command::new(shell).args(["-lc", "printf %s \"$PATH\""]).kill_on_drop(true).output();
            let out = tokio::time::timeout(SHELL_TIMEOUT, run).await.ok().and_then(Result::ok).filter(|o| o.status.success());
            merge_path(out.as_ref().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).as_deref())
        })
        .await
}
```

- [ ] **Step 3: Failing tests for `failure.rs`**

Test the pure parts with constructed values. `failure_of` needs real `kube::Error` values: build them in tests (`kube::Error::Api(..)` with code 401/403; `kube::Error::Auth(kube::client::AuthError::AuthExec(..))`-style variants per kube 4.2 docs; an `io::Error` of kind `ConnectionRefused` wrapped the way `kube` wraps hyper connect errors — if that wrapping cannot be constructed in a test, cover it in the live test (KB5) and test the text-based fallback here).
```rust
const SSO_STDERR: &str = "\nError when retrieving token from sso: Token has expired and refresh failed\n";
const DENIED_STDERR: &str = "An error occurred (AccessDeniedException) when calling the AssumeRole operation: denied";

#[test]
fn exec_stderr_classification() {
    assert_eq!(exec_failure(SSO_STDERR), Failure::SsoExpired);
    assert_eq!(exec_failure("The SSO session associated with this profile has expired or is otherwise invalid."), Failure::SsoExpired);
    assert_eq!(exec_failure("Error loading SSO Token: Token for x does not exist"), Failure::SsoExpired);
    assert_eq!(exec_failure(DENIED_STDERR), Failure::ExecFailed { stderr: DENIED_STDERR.into() });
}

#[test]
fn describe_messages() {
    let both = Endpoint { public: true, private: true };
    assert_eq!(describe(&Failure::SsoExpired, both), AppError::SsoExpired);
    assert_eq!(describe(&Failure::Unreachable, Endpoint { public: false, private: true }), AppError::Network { message: UNREACHABLE_PRIVATE.into() });
    assert_eq!(describe(&Failure::Unreachable, Endpoint { public: true, private: false }), AppError::Network { message: UNREACHABLE_PUBLIC.into() });
    assert_eq!(describe(&Failure::Unreachable, both), AppError::Network { message: UNREACHABLE_BOTH.into() });
    assert_eq!(describe(&Failure::Tls, both), AppError::other(TLS_UNVERIFIED));
    assert_eq!(describe(&Failure::Unauthorized, both), AppError::other(UNAUTHORIZED));
    assert_eq!(describe(&Failure::Forbidden { verb: "list".into(), resource: "namespaces".into() }, both), AppError::AccessDenied { action: "list namespaces".into() });
    assert_eq!(describe(&Failure::ExecMissing { command: "aws".into() }, both), AppError::other(exec_missing("aws")));
    assert_eq!(describe(&Failure::ExecFailed { stderr: format!("\n  first line\nsecond") }, both), AppError::other(exec_failed("first line")));
}

#[test]
fn exec_failed_takes_first_non_empty_line_redacted_and_capped() {
    let long = "x".repeat(400);
    let AppError::Other { message } = describe(&Failure::ExecFailed { stderr: long }, Endpoint { public: true, private: true }) else { panic!() };
    assert_eq!(message, exec_failed(&"x".repeat(300)));
    assert_eq!(redact_secrets("token k8s-aws-v1.aHR0cHM6Ly9zdHM done"), "token [가림] done");
    assert_eq!(redact_secrets("Bearer abc.def"), "Bearer [가림]");
    assert_eq!(redact_secrets("eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.sig"), "[가림]");
}
```
Run: `cargo test --lib k8s::failure` — Expected: FAIL.

- [ ] **Step 4: Implement `failure.rs`**

```rust
//! 접속과 요청 실패를 사용자 문구로 가른다. 문구는 계획의 Global Constraints와 같다.
use crate::error::AppError;

pub const UNREACHABLE_PRIVATE: &str = "클러스터 엔드포인트에 연결하지 못했어요. 프라이빗 엔드포인트라서 Tailscale 연결을 확인해 주세요";
pub const UNREACHABLE_PUBLIC: &str = "클러스터 엔드포인트에 연결하지 못했어요. 엔드포인트의 허용 CIDR에 이 컴퓨터의 IP가 있는지 확인해 주세요";
pub const UNREACHABLE_BOTH: &str = "클러스터 엔드포인트에 연결하지 못했어요. Tailscale 연결이나 엔드포인트의 허용 CIDR을 확인해 주세요";
pub const TLS_UNVERIFIED: &str = "클러스터 인증서를 확인하지 못했어요";
pub const UNAUTHORIZED: &str = "클러스터가 이 신원을 알아보지 못했어요. EKS access entry나 aws-auth ConfigMap에 등록돼 있는지 확인해 주세요";
pub const NOT_OPENED: &str = "먼저 연결해 주세요";
const EXEC_LINE_MAX: usize = 300;

pub fn exec_missing(command: &str) -> String {
    format!("kubeconfig의 인증 명령({command})을 찾지 못했어요. aws CLI가 설치돼 있는지 확인해 주세요")
}
pub fn exec_failed(line: &str) -> String {
    format!("kubeconfig의 인증 명령이 실패했어요: {line}")
}

#[derive(Debug, Clone, PartialEq)]
pub enum Failure {
    ExecMissing { command: String },
    ExecFailed { stderr: String },
    SsoExpired,
    Unreachable,
    Tls,
    Unauthorized,
    Forbidden { verb: String, resource: String },
    Other(String),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Endpoint {
    pub public: bool,
    pub private: bool,
}

/// exec 플러그인의 stderr로 SSO 만료를 알아본다. 나머지는 실패 그대로.
pub fn exec_failure(stderr: &str) -> Failure {
    let lower = stderr.to_lowercase();
    let sso = lower.contains("token has expired")
        || (lower.contains("sso session") && (lower.contains("expired") || lower.contains("invalid")))
        || lower.contains("error loading sso token");
    if sso { Failure::SsoExpired } else { Failure::ExecFailed { stderr: stderr.to_string() } }
}

/// 토큰처럼 보이는 낱말을 가린다: EKS 토큰(`k8s-aws-v1.`), JWT(`eyJ`로 시작하고 점이 둘), `Bearer` 다음 낱말.
pub fn redact_secrets(text: &str) -> String {
    let mut out = Vec::new();
    let mut bearer = false;
    for word in text.split(' ') {
        let secret = bearer || word.starts_with("k8s-aws-v1.") || (word.starts_with("eyJ") && word.matches('.').count() >= 2);
        bearer = word.eq_ignore_ascii_case("bearer");
        out.push(if secret { "[가림]" } else { word });
    }
    out.join(" ")
}

pub fn describe(f: &Failure, endpoint: Endpoint) -> AppError {
    match f {
        Failure::SsoExpired => AppError::SsoExpired,
        Failure::Unreachable => AppError::Network {
            message: match (endpoint.public, endpoint.private) {
                (false, true) => UNREACHABLE_PRIVATE,
                (true, false) => UNREACHABLE_PUBLIC,
                _ => UNREACHABLE_BOTH,
            }
            .into(),
        },
        Failure::Tls => AppError::other(TLS_UNVERIFIED),
        Failure::Unauthorized => AppError::other(UNAUTHORIZED),
        Failure::Forbidden { verb, resource } => AppError::AccessDenied { action: format!("{verb} {resource}") },
        Failure::ExecMissing { command } => AppError::other(exec_missing(command)),
        Failure::ExecFailed { stderr } => {
            let line = stderr.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
            AppError::other(exec_failed(&redact_secrets(line).chars().take(EXEC_LINE_MAX).collect::<String>()))
        }
        Failure::Other(message) => AppError::other(redact_secrets(message)),
    }
}
```
Then `failure_of(e: &kube::Error, verb, resource) -> Failure`, in this order:
1. `kube::Error::Api(status)` with code 401 → `Unauthorized`; 403 → `Forbidden { verb, resource }`; other codes → `Other(status.message)`.
2. Auth errors from the exec plugin (kube 4.2 `kube::client::AuthError` / `kube::config::...` exec variants — look up the exact names on docs.rs for 4.2.0): spawn failure with `io::ErrorKind::NotFound` → `ExecMissing { command }` (command from the kubeconfig, pass it in by matching the variant's text if the variant does not carry it — keep the `aws` default); non-zero exit with output → `exec_failure(stderr)`.
3. Walk `std::error::Error::source()`: a `rustls::Error` or a hyper/io error whose text contains "certificate" / "UnknownIssuer" → `Tls`; an `io::Error` of kind `ConnectionRefused`, `TimedOut`, `ConnectionReset`, `HostUnreachable`, `NetworkUnreachable`, or a DNS failure, or `tokio::time::error::Elapsed` → `Unreachable`.
4. Anything else → `Other(e.to_string())`.

Add tests for 1 (construct `kube::Error::Api`) and for the text paths of 3 using a small helper `failure_of_chain(chain: &str) -> Option<Failure>` that the source walk calls with each cause's `to_string()` (so the text rules are unit-tested without building hyper errors).

- [ ] **Step 5: Run tests and clippy**

Run: `cd src-tauri && cargo test --lib k8s:: && cargo clippy --all-targets -- -D warnings` — Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/k8s
git commit -m "feat(k8s): login-shell PATH and connection failure messages

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task KB3: Target, connect, identity, rules, state and commands

**Files:**
- Create: `src-tauri/src/k8s/target.rs`, `src-tauri/src/k8s/connect.rs`, `src-tauri/src/k8s/review.rs`, `src-tauri/src/k8s_commands.rs`
- Modify: `src-tauri/src/k8s/mod.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/settings.rs`

**Interfaces:**
- Consumes: KB1 (`kubeconfig_paths`, `load`, `candidates`, `choose`, `with_path`, `update_command`, `NO_CONTEXT`), KB2 (`login_path`, `failure_of`, `describe`, `Endpoint`, `NOT_OPENED`).
- Produces:
  - `#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)] #[serde(rename_all = "camelCase")] pub struct K8sTarget { pub profile: String, pub region: String, pub cluster: String }`
  - `pub struct ClusterInfo { pub arn, endpoint, version: String, pub endpoint_public: bool, pub endpoint_private: bool, pub public_cidrs: Vec<String> }` and `pub async fn describe_cluster(cfg: &SdkConfig, name: &str) -> Result<ClusterInfo, AppError>`
  - `pub async fn connect(loaded: &Loaded, context: &str, endpoint: Endpoint) -> Result<kube::Client, AppError>`
  - `review.rs`: `pub async fn identity(client: &Client, kubeconfig_user: &str, endpoint: Endpoint) -> Result<Identity, AppError>`, `pub async fn rules(client: &Client, namespace: &str, endpoint: Endpoint) -> Result<Rules, AppError>`, pure `pub fn rules_of(status: &SubjectRulesReviewStatus, namespace: &str) -> Rules`, `pub fn identity_of(status: &SelfSubjectReviewStatus) -> Identity`
  - `pub struct K8sState` with `pub fn session(&self, target: &K8sTarget) -> Result<Arc<Session>, AppError>` and `pub struct Session { pub client: kube::Client, pub endpoint: Endpoint, pub context: String }` (used by KB4)
  - Commands `k8s_context`, `k8s_open`, `k8s_close`, `k8s_rules` per Contract.
  - Settings fields `k8s_contexts: BTreeMap<String, String>` (cluster ARN → context) and `kubeconfig_path: Option<String>`.

- [ ] **Step 1: Settings fields (test first)**

In `settings.rs` tests:
```rust
#[test]
fn k8s_fields_roundtrip_and_default() {
    let s = load_text(r#"{"k8sContexts":{"arn:aws:eks:r:1:cluster/a":"ctx-a"},"kubeconfigPath":"~/kc"}"#);
    assert_eq!(s.k8s_contexts.get("arn:aws:eks:r:1:cluster/a").map(String::as_str), Some("ctx-a"));
    assert_eq!(s.kubeconfig_path.as_deref(), Some("~/kc"));
    let d = load_text("{}");
    assert!(d.k8s_contexts.is_empty());
    assert_eq!(d.kubeconfig_path, None);
}
```
Run: FAIL. Then add to `Settings` and `RawSettings`:
```rust
    /// EKS 탭이 접속할 kubeconfig context: 클러스터 ARN → context 이름
    pub k8s_contexts: BTreeMap<String, String>,
    /// kubeconfig 경로. 비우면 KUBECONFIG 또는 ~/.kube/config
    pub kubeconfig_path: Option<String>,
```
and copy both in `load`. Run: PASS.

- [ ] **Step 2: `target.rs`**

```rust
//! 대상 클러스터: 프로필·리전·이름. EKS API로 ARN, 엔드포인트, 버전, 엔드포인트 공개 범위를 읽는다(클러스터에는 연결하지 않는다).
use aws_config::SdkConfig;
use serde::{Deserialize, Serialize};

use crate::error::{from_sdk, AppError};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct K8sTarget {
    pub profile: String,
    pub region: String,
    pub cluster: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ClusterInfo {
    pub arn: String,
    pub endpoint: String,
    pub version: String,
    pub endpoint_public: bool,
    pub endpoint_private: bool,
    pub public_cidrs: Vec<String>,
}

pub fn cluster_info(c: &aws_sdk_eks::types::Cluster) -> Result<ClusterInfo, AppError> {
    let vpc = c.resources_vpc_config();
    let endpoint = c.endpoint().filter(|e| !e.is_empty()).ok_or_else(|| AppError::other("클러스터 엔드포인트가 아직 없어요. 클러스터가 만들어지는 중인지 확인해 주세요"))?;
    Ok(ClusterInfo {
        arn: c.arn().unwrap_or_default().to_string(),
        endpoint: endpoint.to_string(),
        version: c.version().unwrap_or_default().to_string(),
        endpoint_public: vpc.is_some_and(|v| v.endpoint_public_access()),
        endpoint_private: vpc.is_some_and(|v| v.endpoint_private_access()),
        public_cidrs: vpc.map(|v| v.public_access_cidrs().to_vec()).unwrap_or_default(),
    })
}

pub async fn describe_cluster(cfg: &SdkConfig, name: &str) -> Result<ClusterInfo, AppError> {
    let out = aws_sdk_eks::Client::new(cfg).describe_cluster().name(name).send().await.map_err(|e| from_sdk(e, "eks:DescribeCluster"))?;
    let cluster = out.cluster().ok_or_else(|| AppError::other(format!("클러스터를 찾을 수 없어요: {name}")))?;
    cluster_info(cluster)
}
```
Add the exact "no endpoint" and "not found" strings to the Global Constraints list of the progress ledger when the task is reviewed. Test `cluster_info` with a `Cluster::builder()` value (public+private, CIDRs) and a cluster without endpoint (error).

- [ ] **Step 3: `connect.rs`**

```rust
//! kubeconfig context로 `kube::Client`를 만든다. 인증은 context의 것(exec 플러그인, 토큰, 클라이언트 인증서)을 그대로 쓴다.
use std::time::Duration;

use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Client, Config};

use super::failure::{describe, failure_of, Endpoint};
use super::kubeconfig::{with_path, Loaded};
use super::path::login_path;
use crate::error::AppError;

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

pub async fn client_for(config: &Kubeconfig, context: &str, endpoint: Endpoint) -> Result<Client, AppError> {
    let options = KubeConfigOptions { context: Some(context.to_string()), ..Default::default() };
    let mut cfg = Config::from_custom_kubeconfig(config.clone(), &options).await.map_err(|e| AppError::other(e.to_string()))?;
    cfg.connect_timeout = Some(CONNECT_TIMEOUT);
    Client::try_from(cfg).map_err(|e| describe(&failure_of(&e, "connect", "cluster"), endpoint))
}

pub async fn connect(loaded: &Loaded, context: &str, endpoint: Endpoint) -> Result<Client, AppError> {
    let config = with_path(&loaded.config, context, login_path().await);
    client_for(&config, context, endpoint).await
}
```
`client_for` takes a `Kubeconfig` so the live test (KB5) can point it at a kind cluster. Errors from `from_custom_kubeconfig` that are about the kubeconfig itself are shown as their text (they contain no secrets: kube's config errors name fields, not values).

- [ ] **Step 4: `review.rs` (test the pure parts first)**

```rust
#[test]
fn rules_of_maps_status() {
    let status: SubjectRulesReviewStatus = serde_json::from_value(serde_json::json!({
        "resourceRules": [{ "verbs": ["get","list"], "apiGroups": [""], "resources": ["pods","pods/log"] },
                          { "verbs": ["*"], "apiGroups": ["apps"], "resources": ["deployments"], "resourceNames": ["web"] }],
        "nonResourceRules": [{ "verbs": ["get"], "nonResourceURLs": ["/healthz"] }],
        "incomplete": true
    })).unwrap();
    let r = rules_of(&status, "ops");
    assert_eq!(r.namespace, "ops");
    assert!(r.incomplete);
    assert_eq!(r.resource_rules[1].resource_names, ["web"]);
    assert_eq!(r.non_resource_rules[0].non_resource_urls, ["/healthz"]);
}

#[test]
fn identity_of_reads_user_info_and_arn_extra() {
    let status: SelfSubjectReviewStatus = serde_json::from_value(serde_json::json!({
        "userInfo": { "username": "arn:aws:sts::1:assumed-role/Dev/jane", "groups": ["system:authenticated", "dev"],
                      "extra": { "arn": ["arn:aws:sts::1:assumed-role/Dev/jane"] } }
    })).unwrap();
    let id = identity_of(&status);
    assert_eq!(id.username, "arn:aws:sts::1:assumed-role/Dev/jane");
    assert_eq!(id.groups, ["system:authenticated", "dev"]);
    assert_eq!(id.arn.as_deref(), Some("arn:aws:sts::1:assumed-role/Dev/jane"));
    assert_eq!(id.source, IdentitySource::SelfSubjectReview);
}
```
Implementation:
```rust
//! 이 신원에 대해 서버에 묻는 요청: 나는 누구인가(SelfSubjectReview), 이 네임스페이스에서 무엇을 할 수 있나(SelfSubjectRulesReview).
//! 둘 다 POST지만 아무것도 바꾸지 않는다. 이 앱에서 `create`를 부를 수 있는 K1의 유일한 파일이다(`hygiene`이 지킨다).
use k8s_openapi::api::authentication::v1::{SelfSubjectReview, SelfSubjectReviewStatus};
use k8s_openapi::api::authorization::v1::{SelfSubjectRulesReview, SelfSubjectRulesReviewSpec, SubjectRulesReviewStatus};
use kube::api::PostParams;
use kube::{Api, Client};
use serde::Serialize;

use super::failure::{describe, failure_of, Endpoint};
use crate::error::AppError;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum IdentitySource { SelfSubjectReview, Kubeconfig }

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity { pub username: String, pub groups: Vec<String>, pub arn: Option<String>, pub source: IdentitySource }

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceRule { pub verbs: Vec<String>, pub api_groups: Vec<String>, pub resources: Vec<String>, pub resource_names: Vec<String> }

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NonResourceRule { pub verbs: Vec<String>, pub non_resource_urls: Vec<String> }

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rules { pub namespace: String, pub resource_rules: Vec<ResourceRule>, pub non_resource_rules: Vec<NonResourceRule>, pub incomplete: bool }

pub fn identity_of(status: &SelfSubjectReviewStatus) -> Identity { /* userInfo.username, groups, extra["arn"][0] */ }
pub fn rules_of(status: &SubjectRulesReviewStatus, namespace: &str) -> Rules { /* field copy, None → empty */ }

/// SelfSubjectReview(1.28+). 서버가 이 API를 모르면(404) kubeconfig 사용자 이름으로 대신한다.
pub async fn identity(client: &Client, kubeconfig_user: &str, endpoint: Endpoint) -> Result<Identity, AppError> {
    let api: Api<SelfSubjectReview> = Api::all(client.clone());
    match tokio::time::timeout(super::connect::REQUEST_TIMEOUT, api.create(&PostParams::default(), &SelfSubjectReview::default())).await {
        Err(_) => Err(describe(&super::failure::Failure::Unreachable, endpoint)),
        Ok(Ok(review)) => Ok(review.status.as_ref().map(identity_of).unwrap_or_else(|| fallback(kubeconfig_user))),
        Ok(Err(kube::Error::Api(status))) if status.code == 404 => Ok(fallback(kubeconfig_user)),
        Ok(Err(e)) => Err(describe(&failure_of(&e, "create", "selfsubjectreviews"), endpoint)),
    }
}

fn fallback(user: &str) -> Identity {
    Identity { username: user.to_string(), groups: vec![], arn: None, source: IdentitySource::Kubeconfig }
}

pub async fn rules(client: &Client, namespace: &str, endpoint: Endpoint) -> Result<Rules, AppError> {
    let api: Api<SelfSubjectRulesReview> = Api::all(client.clone());
    let review = SelfSubjectRulesReview { spec: SelfSubjectRulesReviewSpec { namespace: Some(namespace.to_string()) }, ..Default::default() };
    let out = tokio::time::timeout(super::connect::REQUEST_TIMEOUT, api.create(&PostParams::default(), &review))
        .await
        .map_err(|_| describe(&super::failure::Failure::Unreachable, endpoint))?
        .map_err(|e| describe(&failure_of(&e, "create", "selfsubjectrulesreviews"), endpoint))?;
    Ok(out.status.as_ref().map(|s| rules_of(s, namespace)).unwrap_or(Rules { namespace: namespace.into(), resource_rules: vec![], non_resource_rules: vec![], incomplete: true }))
}
```
Fill in the two pure functions; adapt the `kube::Error::Api` field (`status.code`) to kube 4.2.

- [ ] **Step 5: `K8sState` and commands (tests for state transitions first)**

`k8s_commands.rs`:
```rust
//! EKS 탭의 명령. 대상(프로필·리전·클러스터)마다 열린 연결 하나(`Session`)를 둔다.
//! 열기는 시작할 때 대상의 닫힌 횟수(`epoch`)를 읽어 두고, 끝날 때 그사이 닫혔으면 연결을 버린다(PG 탭과 같은 규칙).
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use tauri::State;

use crate::commands::AppState;
use crate::error::AppError;
use crate::k8s::connect;
use crate::k8s::failure::{Endpoint, NOT_OPENED};
use crate::k8s::kubeconfig::{self, Candidate};
use crate::k8s::review::{self, Identity, Rules};
use crate::k8s::target::{describe_cluster, K8sTarget};

pub struct Session {
    pub client: kube::Client,
    pub endpoint: Endpoint,
    pub context: String,
}

#[derive(Default)]
pub struct K8sState {
    sessions: Mutex<HashMap<K8sTarget, Arc<Session>>>,
    epochs: Mutex<HashMap<K8sTarget, u64>>,
    // KB4 adds: watches
}

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> { m.lock().unwrap_or_else(PoisonError::into_inner) }

impl K8sState {
    pub fn epoch(&self, t: &K8sTarget) -> u64 { *locked(&self.epochs).get(t).unwrap_or(&0) }
    /// 시작할 때의 `epoch`와 같을 때만 넣는다. 다르면(그사이 닫힘) false.
    pub fn keep(&self, t: &K8sTarget, started: u64, session: Session) -> bool {
        let epochs = locked(&self.epochs);
        if *epochs.get(t).unwrap_or(&0) != started { return false; }
        locked(&self.sessions).insert(t.clone(), Arc::new(session));
        true
    }
    pub fn close(&self, t: &K8sTarget) {
        let mut epochs = locked(&self.epochs);
        *epochs.entry(t.clone()).or_insert(0) += 1;
        locked(&self.sessions).remove(t);
    }
    pub fn session(&self, t: &K8sTarget) -> Result<Arc<Session>, AppError> {
        locked(&self.sessions).get(t).cloned().ok_or_else(|| AppError::other(NOT_OPENED))
    }
}
```
Lock order: `epochs` before `sessions`, everywhere (write this in the doc comment). Tests (in `k8s_commands.rs` trailing test module) use a `Session` built from a `kube::Client` pointed at an unused local URL (`Client::try_from(Config::new("http://127.0.0.1:9".parse().unwrap()))`) — no request is ever sent:
- `keep` after `close` with the old epoch returns false and `session` errors with `NOT_OPENED`;
- `keep` with the current epoch stores; `close` removes;
- two targets differing only by profile are independent.

Commands:
```rust
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct K8sContextInfo {
    pub arn: String, pub endpoint: String, pub version: String,
    pub endpoint_public: bool, pub endpoint_private: bool, pub public_cidrs: Vec<String>,
    pub kubeconfig_paths: Vec<String>, pub candidates: Vec<Candidate>,
    pub chosen: Option<String>, pub saved_missing: Option<String>, pub update_command: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct K8sSession { pub context: String, pub exec_profile: Option<String>, pub identity: Identity, pub server_version: String }

fn read_kubeconfig(setting: Option<&str>) -> Result<kubeconfig::Loaded, AppError> {
    let env = std::env::var("KUBECONFIG").ok();
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    kubeconfig::load(&kubeconfig::kubeconfig_paths(setting, env.as_deref(), home.as_deref()))
}
```
- `k8s_context(app, target, kubeconfig, saved)`: `cfg = app.ctx.config(&target.profile, &target.region)`, `info = describe_cluster`, then the kubeconfig. If none of the paths is a file, return a `K8sContextInfo` with empty `candidates` and `kubeconfig_paths` set to the tried paths, so the UI shows the update command (check `paths.iter().any(|p| p.is_file())` before calling `load`). Any other `load` error (unreadable or broken file) is returned as the error. Otherwise fill `candidates`, `choose(saved)`, and `update_command(&target.cluster, &target.region, &target.profile)`.
- `k8s_open(app, k8s, target, kubeconfig, context)`: `started = k8s.epoch(&target)`; `info = describe_cluster` (endpoint access for messages); `loaded = read_kubeconfig`; confirm `context` is among `candidates` (else `AppError::other(NO_CONTEXT)`); `client = connect::connect(&loaded, &context, endpoint)`; `identity = review::identity(&client, &candidate.user, endpoint)`; `server_version = client.apiserver_version().await` mapped with `failure_of(e, "get", "version")`; `keep(...)` — if false, return `AppError::other(NOT_OPENED)`; return `K8sSession { exec_profile: candidate.exec_profile, .. }`.
- `k8s_close(k8s, target)`: `k8s.close(&target)`.
- `k8s_rules(k8s, target, namespace)`: `s = k8s.session(&target)?; review::rules(&s.client, &namespace, s.endpoint)`.

Register in `lib.rs`: `mod k8s_commands;`, `app.manage(k8s_commands::K8sState::default());`, and the four commands in `generate_handler!`. Add `pub mod target; pub mod connect; pub mod review; pub mod failure; pub mod path;` to `k8s/mod.rs` (keep `#[cfg(test)] mod hygiene;` last).

- [ ] **Step 6: Run everything**

Run: `cd src-tauri && cargo test --lib && cargo clippy --all-targets -- -D warnings` — Expected: PASS, clean (the full suite, not only `k8s::`).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/k8s src-tauri/src/k8s_commands.rs src-tauri/src/lib.rs src-tauri/src/settings.rs
git commit -m "feat(k8s): describe cluster, connect through kubeconfig context, identity and rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task KB4: Watch streams

**Files:**
- Create: `src-tauri/src/k8s/rows.rs`, `src-tauri/src/k8s/watch.rs`
- Modify: `src-tauri/src/k8s/mod.rs`, `src-tauri/src/k8s_commands.rs`, `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: KB3 `K8sState::session`, `Session { client, endpoint }`, KB2 `failure_of`, `describe`.
- Produces:
  - `#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)] #[serde(rename_all = "camelCase")] pub struct KindRef { pub group: String, pub version: String, pub kind: String, pub plural: String, pub namespaced: bool }`
  - `#[derive(Debug, Clone, PartialEq, Serialize)] #[serde(rename_all = "camelCase")] pub struct Row { pub uid: String, pub name: String, pub namespace: Option<String>, pub resource_version: String, pub created_at: Option<String>, pub labels: BTreeMap<String, String>, pub values: BTreeMap<String, String> }`
  - `pub fn row_of(kind: &KindRef, obj: &DynamicObject) -> Row` (K1 fills `values["status"]` for `Namespace` from `status.phase`; later phases add kinds here)
  - `#[derive(Debug, Clone, PartialEq, Serialize)] #[serde(tag = "type", rename_all = "camelCase")] pub enum WatchMessage { Reset { rows: Vec<Row> }, Changes { upserts: Vec<Row>, deletes: Vec<String> }, Error { error: AppError, fatal: bool } }`
  - `pub struct Batcher` (pure): `fn on(&mut self, ev: watcher::Event<Row>) -> Option<WatchMessage>` (returns `Reset` at `InitDone`), `fn take(&mut self) -> Option<WatchMessage>` (pending changes), `fn full(&self) -> bool` (≥ 500 rows pending)
  - Commands `k8s_watch(k8s, target, kind, namespace, on_event: tauri::ipc::Channel<WatchMessage>) -> Result<u64, AppError>` and `k8s_unwatch(k8s, watch_id: u64)`; `K8sState::close` also aborts the target's watches.

- [ ] **Step 1: Failing tests for `row_of` and `Batcher`**

```rust
fn ns(name: &str, uid: &str, phase: &str) -> DynamicObject {
    serde_json::from_value(serde_json::json!({
        "apiVersion": "v1", "kind": "Namespace",
        "metadata": { "name": name, "uid": uid, "resourceVersion": "7", "creationTimestamp": "2026-10-30T01:02:03Z", "labels": { "team": "a" } },
        "status": { "phase": phase }
    })).unwrap()
}
const NAMESPACES: fn() -> KindRef = || KindRef { group: "".into(), version: "v1".into(), kind: "Namespace".into(), plural: "namespaces".into(), namespaced: false };

#[test]
fn namespace_row() {
    let r = row_of(&NAMESPACES(), &ns("ops", "u1", "Active"));
    assert_eq!((r.uid.as_str(), r.name.as_str(), r.namespace.as_deref()), ("u1", "ops", None));
    assert_eq!(r.created_at.as_deref(), Some("2026-10-30T01:02:03Z"));
    assert_eq!(r.labels.get("team").map(String::as_str), Some("a"));
    assert_eq!(r.values.get("status").map(String::as_str), Some("Active"));
}

#[test]
fn batcher_buffers_init_then_streams_changes() {
    let row = |n: &str, u: &str| row_of(&NAMESPACES(), &ns(n, u, "Active"));
    let mut b = Batcher::default();
    assert_eq!(b.on(Event::Init), None);
    assert_eq!(b.on(Event::InitApply(row("a", "1"))), None);
    assert_eq!(b.on(Event::InitApply(row("b", "2"))), None);
    let Some(WatchMessage::Reset { rows }) = b.on(Event::InitDone) else { panic!() };
    assert_eq!(rows.len(), 2);
    assert_eq!(b.take(), None);
    assert_eq!(b.on(Event::Apply(row("a", "1"))), None);
    assert_eq!(b.on(Event::Apply(row("a2", "1"))), None); // same uid: last wins
    assert_eq!(b.on(Event::Delete(row("b", "2"))), None);
    let Some(WatchMessage::Changes { upserts, deletes }) = b.take() else { panic!() };
    assert_eq!(upserts.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["a2"]);
    assert_eq!(deletes, ["2"]);
    // a delete after an upsert of the same uid cancels the upsert
    b.on(Event::Apply(row("c", "3")));
    b.on(Event::Delete(row("c", "3")));
    let Some(WatchMessage::Changes { upserts, deletes }) = b.take() else { panic!() };
    assert!(upserts.is_empty());
    assert_eq!(deletes, ["3"]);
    // a re-list (Init again) drops pending changes
    b.on(Event::Apply(row("d", "4")));
    b.on(Event::Init);
    assert_eq!(b.take(), None);
}

#[test]
fn full_at_500_pending() {
    let mut b = Batcher::default();
    b.on(Event::Init);
    b.on(Event::InitDone);
    for i in 0..499 { b.on(Event::Apply(row_of(&NAMESPACES(), &ns(&format!("n{i}"), &i.to_string(), "Active")))); }
    assert!(!b.full());
    b.on(Event::Apply(row_of(&NAMESPACES(), &ns("last", "x", "Active"))));
    assert!(b.full());
}

#[test]
fn messages_serialize_with_type_tag() {
    let v = serde_json::to_value(WatchMessage::Changes { upserts: vec![], deletes: vec!["u".into()] }).unwrap();
    assert_eq!(v, serde_json::json!({ "type": "changes", "upserts": [], "deletes": ["u"] }));
    let v = serde_json::to_value(WatchMessage::Error { error: AppError::other("x"), fatal: true }).unwrap();
    assert_eq!(v, serde_json::json!({ "type": "error", "error": { "kind": "other", "message": "x" }, "fatal": true }));
}
```
`Event` is `kube::runtime::watcher::Event<Row>` (map events with `Event::modify`/`map` from `Event<DynamicObject>` before feeding them, so the batcher is pure over rows). Run: FAIL.

- [ ] **Step 2: Implement `rows.rs` and the batcher**

`rows.rs`:
```rust
//! 목록 한 줄. 모든 종류에 공통인 메타데이터와, 종류별로 화면에 보일 값(`values`). 종류별 값은 단계마다 여기에 더한다.
use std::collections::BTreeMap;

use kube::api::DynamicObject;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KindRef { pub group: String, pub version: String, pub kind: String, pub plural: String, pub namespaced: bool }

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub uid: String,
    pub name: String,
    pub namespace: Option<String>,
    pub resource_version: String,
    pub created_at: Option<String>,
    pub labels: BTreeMap<String, String>,
    pub values: BTreeMap<String, String>,
}

pub fn row_of(kind: &KindRef, obj: &DynamicObject) -> Row {
    let m = &obj.metadata;
    let mut values = BTreeMap::new();
    if kind.group.is_empty() && kind.kind == "Namespace" {
        if let Some(phase) = obj.data.pointer("/status/phase").and_then(|v| v.as_str()) {
            values.insert("status".to_string(), phase.to_string());
        }
    }
    Row {
        uid: m.uid.clone().unwrap_or_default(),
        name: m.name.clone().unwrap_or_default(),
        namespace: m.namespace.clone(),
        resource_version: m.resource_version.clone().unwrap_or_default(),
        created_at: m.creation_timestamp.as_ref().map(|t| t.0.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
        labels: m.labels.clone().unwrap_or_default().into_iter().collect(),
        values,
    }
}
```
(`creation_timestamp`'s inner type in k8s-openapi 0.29 may be `jiff::Timestamp` instead of `chrono`; format it as RFC 3339 with whole seconds and a `Z` suffix using whichever type it is, matching the test.)

`watch.rs` batcher:
```rust
//! 목록 watch. 처음 목록(Init…InitDone)은 한 번에 `Reset`으로, 그 뒤 변경은 100ms 또는 500줄마다 `Changes`로 묶어 보낸다.
use std::collections::BTreeMap;

use kube::runtime::watcher::Event;

use super::rows::Row;
use crate::error::AppError;

pub const FLUSH_EVERY: std::time::Duration = std::time::Duration::from_millis(100);
pub const FLUSH_ROWS: usize = 500;
pub const PAGE_SIZE: u32 = 500;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WatchMessage {
    Reset { rows: Vec<Row> },
    Changes { upserts: Vec<Row>, deletes: Vec<String> },
    Error { error: AppError, fatal: bool },
}

#[derive(Default)]
pub struct Batcher {
    init: Option<Vec<Row>>,
    upserts: BTreeMap<String, Row>,
    deletes: Vec<String>,
}

impl Batcher {
    pub fn on(&mut self, ev: Event<Row>) -> Option<WatchMessage> {
        match ev {
            Event::Init => { self.init = Some(Vec::new()); self.upserts.clear(); self.deletes.clear(); None }
            Event::InitApply(row) => { self.init.get_or_insert_with(Vec::new).push(row); None }
            Event::InitDone => Some(WatchMessage::Reset { rows: self.init.take().unwrap_or_default() }),
            Event::Apply(row) => { self.deletes.retain(|u| *u != row.uid); self.upserts.insert(row.uid.clone(), row); None }
            Event::Delete(row) => { self.upserts.remove(&row.uid); if !self.deletes.contains(&row.uid) { self.deletes.push(row.uid); } None }
        }
    }
    pub fn take(&mut self) -> Option<WatchMessage> {
        if self.upserts.is_empty() && self.deletes.is_empty() { return None; }
        Some(WatchMessage::Changes { upserts: std::mem::take(&mut self.upserts).into_values().collect(), deletes: std::mem::take(&mut self.deletes) })
    }
    pub fn full(&self) -> bool { self.upserts.len() + self.deletes.len() >= FLUSH_ROWS }
}
```
Note: `upserts` is keyed by uid in a `BTreeMap`, so the order inside one `Changes` message is uid order; the frontend does not rely on order.

Run: `cargo test --lib k8s::rows k8s::watch` — Expected: PASS.

- [ ] **Step 3: The watch task**

In `watch.rs`:
```rust
/// 보내기가 실패하면(프론트가 채널을 버림) 끝난다. 403은 치명적이라 알리고 끝낸다. 다른 오류는 알리고 watcher의 재시도(backoff)에 맡긴다.
pub async fn run<F>(client: kube::Client, kind: KindRef, namespace: Option<String>, endpoint: Endpoint, mut send: F)
where
    F: FnMut(WatchMessage) -> bool + Send,
{
    use futures::StreamExt;
    use kube::api::{Api, ApiResource, DynamicObject, GroupVersionKind};
    use kube::runtime::{watcher, WatchStreamExt};

    let gvk = GroupVersionKind::gvk(&kind.group, &kind.version, &kind.kind);
    let ar = ApiResource::from_gvk_with_plural(&gvk, &kind.plural);
    let api: Api<DynamicObject> = match (&namespace, kind.namespaced) {
        (Some(ns), true) => Api::namespaced_with(client, ns, &ar),
        _ => Api::all_with(client, &ar),
    };
    let mut stream = watcher(api, watcher::Config::default().page_size(PAGE_SIZE)).default_backoff().boxed();
    let mut batch = Batcher::default();
    let mut tick = tokio::time::interval(FLUSH_EVERY);
    loop {
        tokio::select! {
            next = stream.next() => match next {
                None => return,
                Some(Ok(ev)) => {
                    let ev = ev.map(|o| row_of(&kind, &o)); // use the kube 4.2 mapping helper on Event
                    if let Some(msg) = batch.on(ev) { if !send(msg) { return; } }
                    if batch.full() { if let Some(msg) = batch.take() { if !send(msg) { return; } } }
                }
                Some(Err(e)) => {
                    let failure = watch_failure(&e, &kind);
                    let fatal = matches!(failure, Failure::Forbidden { .. } | Failure::Unauthorized);
                    if !send(WatchMessage::Error { error: describe(&failure, endpoint), fatal }) || fatal { return; }
                }
            },
            _ = tick.tick() => if let Some(msg) = batch.take() { if !send(msg) { return; } },
        }
    }
}
```
`watch_failure(e: &watcher::Error, kind)` unwraps the inner `kube::Error` of the watcher error variants (`InitialListFailed`, `WatchStartFailed`, `WatchError`, `WatchFailed` — check kube 4.2 names) and calls `failure_of(inner, "list"|"watch", &kind.plural)`; an `ErrorResponse`-style 403 from the watch body maps to `Forbidden`.

Commands in `k8s_commands.rs`:
```rust
struct WatchEntry { target: K8sTarget, handle: tokio::task::AbortHandle }
// K8sState gains: watches: Mutex<HashMap<u64, WatchEntry>>, next_watch: AtomicU64
```
- `k8s_watch`: `session = k8s.session(&target)?`; `id = next_watch.fetch_add(1) + 1`; spawn `watch::run(session.client.clone(), kind, namespace, session.endpoint, move |m| on_event.send(m).is_ok())` with `tauri::async_runtime::spawn`; store the abort handle under `id`; when the task ends by itself it removes its own entry (wrap the future: run, then `k8s.watches.remove(id)` — pass an `Arc<K8sState>`-free cleanup by using the `AppHandle` and `app.state::<K8sState>()`). Return `id`.
- `k8s_unwatch(id)`: remove and abort; unknown ids are ignored.
- `close(target)` also removes and aborts every entry whose `target` matches (lock order: `epochs` → `sessions` → `watches`).
Test (state only, no cluster): register two fake entries for two targets via a test-only `insert_watch(target, handle)` using `tokio::spawn(std::future::pending::<()>())` handles; `close(a)` aborts only `a`'s (`handle.is_finished()` after a yield) and `unwatch` of an unknown id is a no-op.

Register `k8s_commands::k8s_watch` and `k8s_commands::k8s_unwatch` in `lib.rs`.

- [ ] **Step 4: Run everything**

Run: `cd src-tauri && cargo test --lib && cargo clippy --all-targets -- -D warnings` — Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/k8s src-tauri/src/k8s_commands.rs src-tauri/src/lib.rs
git commit -m "feat(k8s): batched watch streams over Tauri channels

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task KB5: Live tests against kind

**Files:**
- Create: `scripts/k8s-live-test.sh`, `src-tauri/src/k8s/live_tests.rs`
- Modify: `src-tauri/src/k8s/mod.rs` (`#[cfg(test)] mod live_tests;` before `mod hygiene;`)

**Interfaces:**
- Consumes: `connect::client_for`, `review::identity`, `review::rules`, `watch::run`, `failure::*`, `kubeconfig::{load, candidates}`.
- Produces: `scripts/k8s-live-test.sh` (used again by later phases).

- [ ] **Step 1: The script**

```bash
#!/usr/bin/env bash
# kind 클러스터 두 버전을 띄우고 EKS 탭의 #[ignore] 시험(k8s::live_tests)을 돌린다. 평소 cargo test에서는 건너뛴다.
#   scripts/k8s-live-test.sh            # 기본 이미지 둘
#   KIND_IMAGES="kindest/node:v1.33.1" scripts/k8s-live-test.sh
# 필요: docker, kind (brew install kind)
set -euo pipefail
cd "$(dirname "$0")/.."
command -v kind >/dev/null || { echo "kind가 없어요: brew install kind" >&2; exit 1; }
IMAGES=${KIND_IMAGES:-"kindest/node:v1.33.1 kindest/node:v1.35.0"}
WORK=$(mktemp -d)
cleanup() { for c in $(kind get clusters 2>/dev/null | grep '^mm-live-' || true); do kind delete cluster --name "$c" >/dev/null 2>&1 || true; done; rm -rf "$WORK"; }
trap cleanup EXIT
for image in $IMAGES; do
  name="mm-live-$(echo "${image##*:}" | tr '.' '-')"
  kc="$WORK/$name.yaml"
  kind create cluster --name "$name" --image "$image" --kubeconfig "$kc" --wait 120s
  # exec 플러그인 시험용: kind의 클라이언트 인증서를 ExecCredential로 내보내는 가짜 플러그인, SSO 만료를 흉내 내는 플러그인
  cert=$(yq '.users[0].user.client-certificate-data' "$kc" | base64 -d)
  key=$(yq '.users[0].user.client-key-data' "$kc" | base64 -d)
  mkdir -p "$WORK/bin"
  jq -n --arg c "$cert" --arg k "$key" '{apiVersion:"client.authentication.k8s.io/v1beta1",kind:"ExecCredential",status:{clientCertificateData:$c,clientKeyData:$k}}' > "$WORK/cred.json"
  printf '#!/bin/sh\ncat %q\n' "$WORK/cred.json" > "$WORK/bin/fake-get-token"
  printf '#!/bin/sh\necho "Error when retrieving token from sso: Token has expired and refresh failed" >&2\nexit 255\n' > "$WORK/bin/expired-get-token"
  chmod +x "$WORK/bin/"*
  K8S_LIVE_KUBECONFIG="$kc" K8S_LIVE_BIN="$WORK/bin" \
    cargo test --manifest-path src-tauri/Cargo.toml --lib k8s::live_tests -- --ignored --test-threads=1
done
```
Make it executable (`chmod +x`). It needs `yq` and `jq`; the script checks `command -v yq jq` the same way it checks `kind`. Before relying on the default image tags, run `docker manifest inspect kindest/node:v1.33.1` and `…v1.35.0`; if a tag does not exist, pick the newest existing patch of that minor from the kind release notes and put it in the default.

- [ ] **Step 2: Live tests**

`live_tests.rs` (every test `#[tokio::test] #[ignore]`, reads `K8S_LIVE_KUBECONFIG` and `K8S_LIVE_BIN`):
1. `connects_with_the_kind_context_and_reads_identity`: load the kubeconfig, `client_for(&kc, "kind-<name>", endpoint)`, `identity` → `source == SelfSubjectReview` and `groups` contains `"system:masters"` or `"kubeadm:cluster-admins"`.
2. `exec_plugin_with_path_injection`: rewrite the user to `exec: { command: fake-get-token, apiVersion: client.authentication.k8s.io/v1beta1 }` (no absolute path), apply `with_path(&kc, ctx, &format!("{bin}:/usr/bin:/bin"))`, connect, `identity` succeeds. Without `with_path` (and with a `PATH` env that lacks `bin`), connecting fails with `exec_missing("fake-get-token")`.
3. `expired_sso_in_exec_output_is_sso_expired`: same with `expired-get-token` → `AppError::SsoExpired`.
4. `unreachable_endpoint_message`: point the cluster's `server` at `https://127.0.0.1:1` → `AppError::Network { message: UNREACHABLE_PRIVATE }` with `Endpoint { public: false, private: true }`, within 15 s.
5. `wrong_ca_is_tls`: replace `certificate-authority-data` with a freshly generated CA (`rcgen`) → `TLS_UNVERIFIED`.
6. `unknown_identity_is_unauthorized`: a user with `token: nope` → `UNAUTHORIZED`.
7. `rules_for_a_limited_service_account`: with the admin client create (via `kubectl` in the script before `cargo test`, not from Rust — the hygiene rule covers the code) a namespace `mm-live`, a ServiceAccount `reader`, a Role allowing `get,list,watch` on `pods`, and a RoleBinding; the script exports `K8S_LIVE_READER_TOKEN=$(kubectl create token reader -n mm-live)`. The test connects as that token: `rules(client, "mm-live")` contains a rule with `pods` and `list`, and not `delete`. Add those `kubectl` lines to the script after `kind create cluster`.
8. `watch_streams_reset_then_changes`: `watch::run` over namespaces with a collecting closure; after `Reset` arrives, the script-independent part creates nothing — instead, start the watch, then run `kubectl create namespace mm-live-watch --kubeconfig $kc` from the test with `std::process::Command` (test code, not production) and wait ≤ 10 s for a `Changes` message whose upserts contain `mm-live-watch`; then delete it and wait for its uid in `deletes`.
9. `watch_forbidden_is_fatal`: watching `secrets` across all namespaces as `reader` yields one `Error { fatal: true, error: AccessDenied { action: "list secrets" } }` and the run returns.

- [ ] **Step 3: Run**

Run: `brew list kind >/dev/null 2>&1 || brew install kind` (ask the controller first if `brew install` is not allowed), then `scripts/k8s-live-test.sh` — Expected: all live tests pass on both images. Also `cd src-tauri && cargo test --lib` — Expected: live tests reported as ignored.

- [ ] **Step 4: Commit**

```bash
git add scripts/k8s-live-test.sh src-tauri/src/k8s
git commit -m "test(k8s): live connection, exec, rules and watch tests on kind

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task KF1: Frontend data layer

**Files:**
- Create: `src/k8s/types.ts`, `src/k8s/text.ts`, `src/k8s/api.ts`, `src/k8s/targets.ts`, `src/k8s/queries.ts`, `src/k8s/can.ts`, `src/k8s/watchRegistry.ts`, `src/k8s/useK8sWatch.ts` and tests `src/k8s/{api,targets,can,watchRegistry,useK8sWatch,queries}.test.ts(x)`
- Modify: `src/api/types.ts` (`Settings.k8sContexts?: Record<string, string>`, `Settings.kubeconfigPath?: string | null`)

**Interfaces:**
- Consumes: Contract above (backend may not exist yet in a parallel run — tests mock `invoke` and `Channel`).
- Produces:
  - `k8sApi.context(target, kubeconfig, saved)`, `k8sApi.open(target, kubeconfig, context, ssoProfile)`, `k8sApi.close(target, ssoProfile)`, `k8sApi.rules(target, namespace, ssoProfile)`, `k8sApi.watch(target, kind, namespace, ssoProfile, onEvent) => Promise<number>`, `k8sApi.unwatch(id)`
  - `targetKey(t)`, `k8sTabId(t) = "k8s:" + region + ":" + cluster`, `NAMESPACES: K8sKindRef`
  - `k8sKeys`, `useK8sContext(target, kubeconfig, saved)`, `useK8sSession(target, kubeconfig, context, ssoProfile)`, `useK8sRules(target, namespace, ssoProfile, enabled)`, `closeK8s(qc, target, ssoProfile)`, `refreshK8s(qc, target)`
  - `can(rules, { verb, group, resource, subresource?, name? }): "yes" | "no" | "unknown"`
  - `watchRegistry`: `subscribe(key, start, listener) => unsubscribe` with 30 s linger; `useK8sWatch(target, ssoProfile, kind, namespace, enabled) => { rows: K8sRow[]; status: "loading" | "ready" | "error"; error: AppError | null }`

- [ ] **Step 1: Types and text**

`src/k8s/types.ts` mirrors the Contract exactly (copy the TS block, add `export`). `src/k8s/text.ts` exports every UI string from Global Constraints as constants and the functions `profileMismatch(execProfile, profile)`, `savedMissing(name)`, `tabTitle(cluster)`.

- [ ] **Step 2: Failing tests for `api.ts`**

```ts
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class { onmessage: ((m: unknown) => void) | null = null } }));
import { invoke } from "@tauri-apps/api/core";
const T = { profile: "app", region: "ap-northeast-2", cluster: "prod" };

test("open passes the exec profile at the top level for SSO reporting", async () => {
  vi.mocked(invoke).mockResolvedValue({});
  await k8sApi.open(T, null, "ctx", "prod-ro");
  expect(invoke).toHaveBeenCalledWith("k8s_open", { target: T, kubeconfig: null, context: "ctx", profile: "prod-ro" });
});

test("an ssoExpired from open reports the exec profile, not the app profile", async () => {
  vi.mocked(invoke).mockRejectedValue({ kind: "ssoExpired" });
  const seen: string[] = [];
  const off = onSsoExpired((p) => seen.push(p));
  await expect(k8sApi.open(T, null, "ctx", "prod-ro")).rejects.toEqual({ kind: "ssoExpired" });
  off();
  expect(seen).toEqual(["prod-ro"]);
});

test("context does not pass a top-level profile", async () => {
  vi.mocked(invoke).mockResolvedValue({});
  await k8sApi.context(T, "~/kc", "saved");
  expect(invoke).toHaveBeenCalledWith("k8s_context", { target: T, kubeconfig: "~/kc", saved: "saved" });
});

test("watch hands a Channel whose messages reach the callback", async () => {
  vi.mocked(invoke).mockResolvedValue(7);
  const got: unknown[] = [];
  const id = await k8sApi.watch(T, NAMESPACES, null, "prod-ro", (m) => got.push(m));
  expect(id).toBe(7);
  const args = vi.mocked(invoke).mock.calls.at(-1)![1] as { onEvent: { onmessage: (m: unknown) => void } };
  args.onEvent.onmessage({ type: "reset", rows: [] });
  expect(got).toEqual([{ type: "reset", rows: [] }]);
});
```
Run: `npx vitest run src/k8s/api.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement `api.ts`**

```ts
import { Channel } from "@tauri-apps/api/core";
import { invoke } from "../api/invoke";
import type { K8sContextInfo, K8sKindRef, K8sRules, K8sSession, K8sTarget, K8sWatchMessage } from "./types";

// 명령 이름과 인자 이름은 K1 계획의 Contract와 같아야 한다. target은 객체 하나로 넘긴다.
// k8s_context를 뺀 명령은 최상위 profile에 exec 플러그인의 프로필을 넣는다: invoke가 SSO 만료를 그 프로필로 알린다(src/api/invoke.ts).
export const k8sApi = {
  context: (target: K8sTarget, kubeconfig: string | null, saved: string | null) =>
    invoke<K8sContextInfo>("k8s_context", { target, kubeconfig, saved }),
  open: (target: K8sTarget, kubeconfig: string | null, context: string, ssoProfile: string) =>
    invoke<K8sSession>("k8s_open", { target, kubeconfig, context, profile: ssoProfile }),
  close: (target: K8sTarget, ssoProfile: string) => invoke<null>("k8s_close", { target, profile: ssoProfile }),
  rules: (target: K8sTarget, namespace: string, ssoProfile: string) => invoke<K8sRules>("k8s_rules", { target, namespace, profile: ssoProfile }),
  watch: (target: K8sTarget, kind: K8sKindRef, namespace: string | null, ssoProfile: string, onMessage: (m: K8sWatchMessage) => void) => {
    const onEvent = new Channel<K8sWatchMessage>();
    onEvent.onmessage = onMessage;
    return invoke<number>("k8s_watch", { target, kind, namespace, onEvent, profile: ssoProfile });
  },
  unwatch: (watchId: number) => invoke<null>("k8s_unwatch", { watchId }),
};
```
`ssoProfile` everywhere is `session?.execProfile ?? candidate?.execProfile ?? target.profile`; compute it once with `ssoProfileOf(target, candidate, session)` in `targets.ts` (tested: each fallback level).

- [ ] **Step 4: `can.ts` (tests first)**

```ts
const rules = (resourceRules: K8sRules["resourceRules"], incomplete = false): K8sRules => ({ namespace: "ops", resourceRules, nonResourceRules: [], incomplete });

test("exact, wildcard, subresource, and resourceNames", () => {
  const r = rules([
    { verbs: ["get", "list"], apiGroups: [""], resources: ["pods", "pods/log"], resourceNames: [] },
    { verbs: ["*"], apiGroups: ["apps"], resources: ["deployments"], resourceNames: ["web"] },
    { verbs: ["patch"], apiGroups: ["*"], resources: ["*"], resourceNames: [] },
  ]);
  expect(can(r, { verb: "list", group: "", resource: "pods" })).toBe("yes");
  expect(can(r, { verb: "get", group: "", resource: "pods", subresource: "log" })).toBe("yes");
  expect(can(r, { verb: "get", group: "", resource: "pods", subresource: "exec" })).toBe("no");
  expect(can(r, { verb: "delete", group: "apps", resource: "deployments", name: "web" })).toBe("yes");
  expect(can(r, { verb: "delete", group: "apps", resource: "deployments", name: "api" })).toBe("no");
  expect(can(r, { verb: "delete", group: "apps", resource: "deployments" })).toBe("no"); // resourceNames never match a collection
  expect(can(r, { verb: "patch", group: "batch", resource: "jobs" })).toBe("yes");
  expect(can(r, { verb: "create", group: "", resource: "pods", subresource: "exec" })).toBe("no");
});

test("resources '*' matches subresources too, 'pods/*' matches any pod subresource", () => {
  const r = rules([{ verbs: ["create"], apiGroups: [""], resources: ["pods/*"], resourceNames: [] }]);
  expect(can(r, { verb: "create", group: "", resource: "pods", subresource: "exec" })).toBe("yes");
  expect(can(r, { verb: "create", group: "", resource: "pods" })).toBe("no");
});

test("incomplete lists turn a no into unknown", () => {
  expect(can(rules([], true), { verb: "get", group: "", resource: "pods" })).toBe("unknown");
});
```
Implement with the RBAC matching rules: verb matches `*` or equal; group matches `*` or equal; resource matches `*`, equal to `resource` (no subresource) or `resource/subresource`, or `resource/*` when a subresource is asked; `resourceNames` empty or (name given and included). Result `yes` if any rule matches, else `unknown` when `incomplete`, else `no`.

- [ ] **Step 5: Watch registry and hook (tests first)**

Registry semantics (test each with fake timers):
- First `subscribe(key, start, listener)` calls `start(onMessage)` once (returns `Promise<number>`), later subscribers to the same key share it and immediately receive the current state.
- State per key: `{ rows: Map<uid, row>, status, error }`. `reset` replaces rows and sets `ready`; `changes` upserts/deletes; `error` with `fatal` sets `error` status and stops; non-fatal sets `error` but keeps rows and status `ready`.
- Last unsubscribe starts a 30 s timer; resubscribing within 30 s cancels it and keeps rows; after 30 s, `unwatch(id)` is called once and the key is dropped. If `start` has not resolved yet when the timer fires, the id is unwatched as soon as it resolves.
- `dropTarget(targetKey)` (called by `closeK8s`) clears every key of that target immediately without calling `unwatch` (the backend's `k8s_close` already aborted them).
- Listeners get a new array object only when rows change (so React memo works).

`useK8sWatch(target, ssoProfile, kind, namespace, enabled)` subscribes with key `${targetKey(target)}|${kind.group}/${kind.version}/${kind.plural}|${namespace ?? "*"}` and returns rows sorted by `name` (then namespace).

- [ ] **Step 6: Queries (tests first)**

```ts
export const k8sKeys = {
  root: (t: K8sTarget) => ["k8s", targetKey(t)] as const,
  context: (t: K8sTarget, kubeconfig: string | null, saved: string | null) => ["k8s", targetKey(t), "context", kubeconfig, saved] as const,
  session: (t: K8sTarget, context: string | null) => ["k8s", targetKey(t), "session", context] as const,
  rules: (t: K8sTarget, namespace: string | null) => ["k8s", targetKey(t), "rules", namespace] as const,
};
```
- `useK8sContext`: `staleTime: Infinity`, `retry: false`.
- `useK8sSession`: enabled when `context` is non-null; `staleTime: Infinity`, `gcTime: 0`, `retry: false` (the query is paired with backend state, like `usePgOverview`).
- `useK8sRules`: enabled when the session is ready and `namespace` non-null; `staleTime: 5 * 60_000`, `retry: false`.
- `closeK8s(qc, target, ssoProfile)`: `watchRegistry.dropTarget`, `k8sApi.close` (errors ignored), `qc.removeQueries({ queryKey: k8sKeys.root(target) })`.
- `refreshK8s(qc, target)`: `dropTarget`, `k8sApi.close`, then `qc.invalidateQueries({ queryKey: k8sKeys.root(target) })` so the context is re-read and the session reopened.
Tests: `closeK8s` removes queries and calls close once; `refreshK8s` re-runs the context query.

- [ ] **Step 7: Run and commit**

Run: `npx vitest run src/k8s && npx tsc --noEmit` — Expected: PASS.
```bash
git add src/k8s src/api/types.ts
git commit -m "feat(k8s): frontend api, queries, permission check and shared watches

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task KF2: The tab

**Files:**
- Create: `src/k8s/K8sTab.tsx`, `src/k8s/K8sError.tsx`, `src/k8s/NoContext.tsx`, `src/k8s/ContextPicker.tsx`, `src/k8s/TopBar.tsx`, `src/k8s/MyRules.tsx` and tests `src/k8s/{K8sTab,NoContext,ContextPicker,TopBar,MyRules}.test.tsx`
- Modify: `src/styles.css` (new `k8s-` classes, reusing `pg-top`/`pg-status` looks)

**Interfaces:**
- Consumes: KF1 everything; `useSettings` (`settings.k8sContexts`, `settings.kubeconfigPath`, `update`); `ErrorState` from `src/components/ErrorState.tsx`.
- Produces: `export function K8sTab({ target, active }: { target: K8sTarget; active: boolean })`.

- [ ] **Step 1: Failing tests**

Mock `k8sApi` (and `useSettings` through the real hook with a seeded `["settings"]` query). Cases:
1. Context with no candidates → `NoContext` shows `NO_CONTEXT`, the `updateCommand` in a `<code>`, a "복사" button that calls `writeText` from `@tauri-apps/plugin-clipboard-manager` and then shows "복사했어요", and "다시 확인" which refetches the context query.
2. Two candidates, no saved → `SEVERAL_CONTEXTS` and a list of both (name, user, exec profile); clicking one saves `k8sContexts[arn] = name` via `update` and opens with that context.
3. `savedMissing` → the `savedMissing(name)` line above the picker.
4. One candidate → opens directly; while opening shows "연결 중…"; when open, the top bar shows context, identity username, groups, connection "연결됨".
5. `execProfile` differs from `target.profile` → `profileMismatch(...)` line; equal or null → none.
6. `identity.source === "kubeconfig"` → `IDENTITY_FALLBACK`.
7. Open fails with `{ kind: "ssoExpired" }` → `K8sError` renders `ErrorState` with `profile = execProfile` (assert the login button exists and `profile` prop via the SSO context mock), and its retry calls `refreshK8s`.
8. Namespace selector lists rows from `useK8sWatch(NAMESPACES)` (mock the registry) plus "모든 네임스페이스"; default selection is the context's `namespace`, else "default" when present, else all.
9. `MyRules` for the chosen namespace shows one row per (verb set, group, resource, names) with "(core)" for `""` and "모두" for `*`; incomplete shows `RULES_INCOMPLETE`; "모든 네임스페이스" selected shows rules for `default` with a note line "모든 네임스페이스를 고르면 default 네임스페이스 기준으로 보여줘요" (add this string to `text.ts` and the ledger).
10. "다시 연결" calls `refreshK8s`.

Run: `npx vitest run src/k8s` — Expected: FAIL.

- [ ] **Step 2: Implement**

- `K8sTab`: reads `kubeconfig = settings?.kubeconfigPath ?? null`, `saved = info ? settings?.k8sContexts?.[info.arn] ?? null : null`. Because `saved` depends on the ARN that the context query returns, call `useK8sContext(target, kubeconfig, null)` first to get the ARN, then compute `chosen` on the client with the same rule as Rust `choose` (`chooseContext(candidates, saved)` in `targets.ts`, tested to match the Rust cases in KB1 Step 3) — so the backend `saved` argument is always `null` from this tab. Keep the `saved` parameter in the contract for other callers.
- Layout: `TopBar` on top, a left nav with one item "내 권한", and the body `MyRules`. Use the existing `.pg-top`, `.pg-status`, `.dot` classes where the look is the same; add only `k8s-` classes for what differs.
- `K8sError`: `<ErrorState error={error} profile={ssoProfile} compact={compact} onRetry={() => void refreshK8s(qc, target)} onLoggedIn={() => void refreshK8s(qc, target)} />`.
- `TopBar`: context name (mono), "신원" username (title attribute lists groups), groups as small chips (max 4 shown, then "+N"), profile mismatch line, connection state, namespace `<select>`, "다시 연결".

- [ ] **Step 3: Run and commit**

Run: `npx vitest run && npx tsc --noEmit` — Expected: PASS (whole suite).
```bash
git add src/k8s src/styles.css
git commit -m "feat(k8s): EKS tab with context choice, identity, namespaces and my rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task KF3: App wiring

**Files:**
- Create: `src/k8s/ClusterPicker.tsx`, `src/k8s/ClusterPicker.test.tsx`
- Modify: `src/App.tsx`, `src/components/MainArea.tsx`, `src/components/ResourceArea.tsx`, `src/components/Sidebar.tsx`, `src/components/ServiceSettings.tsx` and their tests (`src/App.test.tsx`, `src/components/ResourceArea.test.tsx`, `src/components/Sidebar.test.tsx`, `src/components/ServiceSettings.test.tsx`)

**Interfaces:**
- Consumes: `K8sTab`, `k8sTabId`, `closeK8s`, `refreshK8s`, `tabTitle`, `ssoProfileOf`.
- Produces: `onOpenK8s?: (target: K8sTarget) => void` on `MainArea`/`ResourceArea`; `onOpenK8s?: () => void` on `Sidebar`.

- [ ] **Step 1: Failing tests**

1. `ResourceArea`: double-clicking a row of `eks`/`clusters` calls `onOpenK8s({ profile, region, cluster: row.id })`; node-group rows do nothing.
2. `Sidebar`: under the expanded EKS service there is a "☸️ 클러스터 관리" row (like IAM's) that calls `onOpenK8s`.
3. `ClusterPicker`: lists clusters from `useResources(profile, region, eksService, "clusters")` (name, version, status); empty → `PICKER_EMPTY`; choosing one calls `onPick(name)`; Escape and the close button call `onClose`.
4. `App`: opening the same cluster twice keeps one tab with title `☸️ prod`; closing the tab calls `closeK8s` once; changing the profile closes all k8s tabs (calls `closeK8s` for each) and moves to "resources" when a k8s tab was active; ⌘R while a k8s tab is active calls `refreshK8s` for that target only.
5. `ServiceSettings`: a "kubeconfig 경로" text field with the placeholder; editing and blurring calls `onKubeconfigPathChange(value || null)`.

- [ ] **Step 2: Implement**

- `App.tsx`: state `k8sTabs: { id: string; target: K8sTarget }[]`, `openK8s(target)` (id `k8sTabId(target)`), render `<K8sTab target={t.target} active={activeTab === t.id} />` panes, add to `tabs`, `closeTab`, `changeProfile` (prefix `k8s:`), `refresh`, and `showK8sPicker` state for the sidebar picker (`<ClusterPicker profile region onPick={(cluster) => openK8s({ profile, region, cluster })} onClose />`). Closing needs the SSO profile: pass `target.profile` to `closeK8s` (the close call does not run exec, so any profile works for reporting).
- `ServiceSettings`: new props `kubeconfigPath: string | null`, `onKubeconfigPathChange(path: string | null)`; App wires them to `settings.kubeconfigPath` / `update({ kubeconfigPath })`, and changing the path invalidates every `["k8s"]` context query (`qc.invalidateQueries({ queryKey: ["k8s"] })`).

- [ ] **Step 3: Run the whole frontend and backend suites**

Run: `npx vitest run && npx tsc --noEmit && npm run build && (cd src-tauri && cargo test --lib && cargo clippy --all-targets -- -D warnings)` — Expected: all PASS, clean.

- [ ] **Step 4: Manual smoke (controller runs it with the user if needed)**

`npm run tauri dev`, open EKS → Clusters, double-click a cluster reachable over Tailscale: identity and namespaces appear; toggle Tailscale off and press "다시 연결": the private-endpoint message appears.

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(k8s): open EKS tabs from the resource list and the sidebar, kubeconfig path setting

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task K1R: Whole-K1 review

- [ ] Review package over `main..feat/eks-k8s` (backend + frontend + script), one reviewer, focus: secrets never leave `kube`, hygiene coverage, lock order, watch task cleanup on close/unwatch/channel drop, SSO profile routing, kube 4.2 API usage, string constants match this plan.
- [ ] One fix wave, re-review, then keep the branch open for K2 (no merge to `main` until KR).
- [ ] Record final counts (vitest, cargo, live) in `.superpowers/sdd/progress.md` under a new "EKS K1" section.
