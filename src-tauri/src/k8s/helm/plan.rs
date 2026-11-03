//! Helm 변경의 미리보기와 적용. 변경 공통 틀(`k8s_preview`·`k8s_apply`)이 `dry_plan`과 `apply`를 부른다.
//! - 계획을 만드는 순수 함수(`plan_*`): 현재 릴리스와 목표(렌더링 결과 또는 다른 리비전)에서 객체별 차이, values 차이, 경고, 되돌리기를 만든다.
//! - 입출력(`prepare`): 저장소에서 현재 릴리스를 읽고, 업그레이드·설치는 임시 폴더에 차트와 values를 쓰고 `helm --dry-run=server`로 렌더링한다.
//!
//! 적용 직전에 같은 계획을 다시 만들어 릴리스가 그대로인지(리비전과 내용 해시)와 이름 입력을 확인한 뒤 helm을 실행한다.
use std::path::PathBuf;
use std::time::Duration;

use serde_json::Value;
use sha2::{Digest, Sha256};
use tempfile::TempDir;

use super::cli::{self, ChartArg, Ctx};
use super::manifest::{self, Doc};
use super::release::{Driver, Release};
use super::{chart, read, run, ChartSource, Cluster};
use crate::error::AppError;
use crate::k8s::change::{dangerous, ApiCall, Change, FieldDiff, Operation, Plan, Preview, INVALID_CHANGE, NOOP_WARNING};
use crate::k8s::commit::CONFIRM_REQUIRED;
use crate::k8s::exec::STALE;

pub const VALUES_NOT_YAML: &str = "values가 올바른 YAML이 아니에요";
pub const VALUES_NOT_MAP: &str = "values는 키: 값 꼴의 YAML이어야 해요";
pub const RENDER_UNREADABLE: &str = "helm이 돌려준 결과를 해석하지 못했어요";
pub const ALREADY_EXISTS: &str = "같은 이름의 릴리스가 이미 있어요. 업그레이드를 쓰거나 다른 이름을 골라 주세요";
pub const ALREADY_CURRENT: &str = "이미 이 리비전이에요";
pub const PURGE_NOTHING: &str = "이미 삭제돼 이력만 남은 릴리스예요. 이력까지 지워요";
pub const UNINSTALL_FINAL: &str = "이 삭제는 되돌릴 수 없어요. 이력까지 지워져 롤백도 할 수 없어요";
pub const NAMESPACE_CREATED: &str = "네임스페이스도 만들어요. 이 변경을 되돌려도 네임스페이스는 남아요";
const DRY_RUN_LIMIT: Duration = Duration::from_secs(180);
const APPLY_LIMIT: Duration = Duration::from_secs(600);
/// 릴리스가 없을 때(설치 전)의 버전·해시
const ABSENT_VERSION: &str = "0";

fn hooks_warning(release: &Release, events: &[&str]) -> Option<String> {
    let count = release.hooks.iter().filter(|h| h.events.iter().any(|e| events.contains(&e.as_str()))).count();
    (count > 0).then(|| format!("이 차트의 훅 {count}개가 함께 실행돼요({})", events.join(", ")))
}

fn status_warning(release: &Release) -> Option<String> {
    super::release::is_problem(&release.info.status).then(|| format!("릴리스가 {} 상태예요. helm이 이 변경을 거절할 수 있어요", release.info.status))
}

/// 릴리스의 지금 상태를 가리키는 해시: 리비전, 상태, manifest, 사용자 values
pub fn state_fingerprint(release: &Release) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(release.version.to_be_bytes());
    hasher.update(release.info.status.as_bytes());
    hasher.update(release.manifest.as_bytes());
    hasher.update(release.user_values().to_string().as_bytes());
    hasher.finalize().into()
}

/// 편집한 values 글을 맵으로 읽는다. 빈 글은 빈 맵. 오류 글에는 값 조각이 실릴 수 있어 고정 문구만 쓴다.
pub fn parse_values(text: &str) -> Result<Value, AppError> {
    if text.trim().is_empty() {
        return Ok(Value::Object(Default::default()));
    }
    match serde_saphyr::from_str::<Value>(text) {
        Ok(Value::Object(map)) => Ok(Value::Object(map)),
        Ok(Value::Null) => Ok(Value::Object(Default::default())),
        Ok(_) => Err(AppError::other(VALUES_NOT_MAP)),
        Err(_) => Err(AppError::other(VALUES_NOT_YAML)),
    }
}

fn counts_text(counts: manifest::Counts) -> String {
    if counts.total() == 0 {
        return "바뀌는 객체가 없어요".to_string();
    }
    format!("바뀌는 객체 {}개(추가 {}, 변경 {}, 삭제 {})", counts.total(), counts.added, counts.changed, counts.removed)
}

fn chart_text(before: &Release, after: &Release) -> Option<String> {
    let (b, a) = (before.chart.label(), after.chart.label());
    (b != a).then(|| format!("차트 {b} → {a}"))
}

fn inverse(change: &Change, operation: Operation) -> Change {
    Change { target: change.target.clone(), operation }
}

/// 이름 입력이 필요한가: 늘(`always`), 또는 `kube-system`·이름에 `prod`
fn confirm_name(change: &Change, always: bool) -> Option<String> {
    let target = &change.target;
    (always || dangerous(target.namespace.as_deref(), &target.name)).then(|| target.name.clone())
}

#[allow(clippy::too_many_arguments)]
fn assemble(
    change: &Change,
    shown: &str,
    diff: Vec<FieldDiff>,
    impact: Vec<String>,
    warnings: Vec<String>,
    always_confirm: bool,
    undo: Option<Change>,
    version: String,
    fingerprint: [u8; 32],
) -> Plan {
    Plan {
        preview: Preview {
            calls: vec![ApiCall { verb: "helm".into(), path: shown.strip_prefix("helm ").unwrap_or(shown).to_string(), body: Value::Null }],
            diff,
            impact,
            warnings,
            confirm_name: confirm_name(change, always_confirm),
            reversible: undo.is_some(),
            drain: None,
            conflicts: Vec::new(),
            effect: None,
        },
        inverse: undo,
        version: Some(version),
        fingerprint: Some(fingerprint),
    }
}

fn docs_of(release: &Release) -> Result<Vec<Doc>, AppError> {
    manifest::parse(&release.manifest)
}

/// 업그레이드: `rendered`는 `helm upgrade --dry-run=server`가 돌려준 릴리스(새 manifest)다.
pub fn plan_upgrade(change: &Change, current: &Release, rendered: &Release, new_values: &Value, shown: &str) -> Result<Plan, AppError> {
    let (objects, counts) = manifest::diff(&docs_of(current)?, &docs_of(rendered)?);
    let mut diff = manifest::values_diff(&current.user_values(), new_values);
    diff.extend(objects);
    let chart_change = chart_text(current, rendered);
    let mut impact = vec![format!("helm upgrade {}: 리비전 {} → {}", current.name, current.version, current.version + 1), counts_text(counts)];
    impact.extend(chart_change.clone());
    let mut warnings = Vec::new();
    if diff.is_empty() && chart_change.is_none() {
        warnings.push(NOOP_WARNING.to_string());
    }
    if counts.removed > 0 {
        warnings.push(format!("새 렌더링에서 빠진 객체 {}개를 삭제해요", counts.removed));
    }
    warnings.extend(hooks_warning(current, &["pre-upgrade", "post-upgrade"]));
    warnings.extend(status_warning(current));
    let undo = inverse(change, Operation::HelmRollback { revision: current.version });
    Ok(assemble(change, shown, diff, impact, warnings, false, Some(undo), current.version.to_string(), state_fingerprint(current)))
}

/// 롤백: 현재 리비전의 manifest·values와 그 리비전의 것을 견준다. 삭제돼 이력만 남은 릴리스를 같은 리비전으로 되살리는 것도 롤백이다.
pub fn plan_rollback(change: &Change, current: &Release, target: &Release, shown: &str) -> Result<Plan, AppError> {
    let restoring = current.info.status == "uninstalled";
    if target.version == current.version && !restoring {
        return Err(AppError::other(ALREADY_CURRENT));
    }
    let before = if restoring { Vec::new() } else { docs_of(current)? };
    let (objects, counts) = manifest::diff(&before, &docs_of(target)?);
    let mut diff = manifest::values_diff(&current.user_values(), &target.user_values());
    diff.extend(objects);
    let mut impact = if restoring {
        vec![format!("helm rollback {}: 삭제된 릴리스를 리비전 {} 내용으로 되살려요", current.name, target.version)]
    } else {
        vec![format!("helm rollback {}: 리비전 {} 내용으로 되돌려요(새 리비전 {}로 기록돼요)", current.name, target.version, current.version + 1)]
    };
    impact.push(counts_text(counts));
    impact.extend(chart_text(current, target));
    let mut warnings = Vec::new();
    if target.info.status == "failed" {
        warnings.push(format!("리비전 {}은 실패했던 리비전이에요", target.version));
    }
    if counts.removed > 0 {
        warnings.push(format!("그 리비전에 없는 객체 {}개를 삭제해요", counts.removed));
    }
    warnings.extend(hooks_warning(target, &["pre-rollback", "post-rollback"]));
    if !restoring {
        warnings.extend(status_warning(current));
    }
    let undo = if restoring {
        inverse(change, Operation::HelmUninstall { keep_history: true })
    } else {
        inverse(change, Operation::HelmRollback { revision: current.version })
    };
    Ok(assemble(change, shown, diff, impact, warnings, false, Some(undo), current.version.to_string(), state_fingerprint(current)))
}

/// 삭제: 지워지는 객체를 보인다. 이력을 남기면 롤백으로 되살릴 수 있다. 이름 입력은 늘 요구한다.
pub fn plan_uninstall(change: &Change, current: &Release, keep_history: bool, shown: &str) -> Result<Plan, AppError> {
    let already = current.info.status == "uninstalled";
    let docs = if already { Vec::new() } else { docs_of(current)? };
    let (diff, counts) = manifest::diff(&docs, &[]);
    let mut impact = vec![format!("helm uninstall {}: 릴리스의 객체 {}개를 삭제해요", current.name, counts.removed)];
    impact.push(if keep_history { "이력은 남겨요(롤백으로 되살릴 수 있어요)".to_string() } else { "이력도 함께 지워요".to_string() });
    let mut warnings = Vec::new();
    if already {
        warnings.push(PURGE_NOTHING.to_string());
    }
    if !keep_history {
        warnings.push(UNINSTALL_FINAL.to_string());
    }
    let kept = docs
        .iter()
        .filter(|d| d.object.pointer("/metadata/annotations/helm.sh~1resource-policy").and_then(Value::as_str) == Some("keep"))
        .count();
    if kept > 0 {
        warnings.push(format!("helm.sh/resource-policy: keep인 객체 {kept}개는 남아요"));
    }
    warnings.extend(hooks_warning(current, &["pre-delete", "post-delete"]));
    let undo = (keep_history && !already).then(|| inverse(change, Operation::HelmRollback { revision: current.version }));
    Ok(assemble(change, shown, diff, impact, warnings, true, undo, current.version.to_string(), state_fingerprint(current)))
}

/// 설치: `rendered`는 `helm install --dry-run=server`가 돌려준 릴리스다.
pub fn plan_install(change: &Change, rendered: &Release, new_values: &Value, create_namespace: bool, shown: &str) -> Result<Plan, AppError> {
    let (objects, counts) = manifest::diff(&[], &docs_of(rendered)?);
    let mut diff = manifest::values_diff(&Value::Object(Default::default()), new_values);
    diff.extend(objects);
    let namespace = change.target.namespace.as_deref().unwrap_or_default();
    let impact = vec![
        format!("helm install {} ({}): 네임스페이스 {namespace}에 객체 {}개를 만들어요", change.target.name, rendered.chart.label(), counts.added),
    ];
    let mut warnings = Vec::new();
    if create_namespace {
        warnings.push(NAMESPACE_CREATED.to_string());
    }
    warnings.extend(hooks_warning(rendered, &["pre-install", "post-install"]));
    let undo = inverse(change, Operation::HelmUninstall { keep_history: false });
    Ok(assemble(change, shown, diff, impact, warnings, false, Some(undo), ABSENT_VERSION.to_string(), [0; 32]))
}

/// 적용 직전 확인: 미리보기를 본 릴리스(리비전과 내용)가 그대로이고, 이름 입력을 정확히 했는가
pub fn check(seen: &Plan, current: &Plan, confirmation: Option<&str>) -> Result<(), AppError> {
    if seen.version != current.version || seen.fingerprint != current.fingerprint {
        return Err(AppError::other(STALE));
    }
    if seen.preview.confirm_name.as_deref().is_some_and(|name| Some(name) != confirmation) {
        return Err(AppError::other(CONFIRM_REQUIRED));
    }
    Ok(())
}

/// 실행할 helm 명령과 그 명령이 쓰는 임시 폴더(명령이 끝날 때까지 지워지지 않게 쥐고 있다)
struct Job {
    helm: PathBuf,
    args: Vec<String>,
    env: Vec<(String, String)>,
    _work: Option<TempDir>,
}

fn render(output: &str) -> Result<Release, AppError> {
    serde_json::from_str(output.trim()).map_err(|_| AppError::other(RENDER_UNREADABLE))
}

/// 서버 dry-run으로 렌더링한 릴리스(새 manifest)를 받는다
async fn dry_render(cluster: &Cluster, helm: &std::path::Path, built: &cli::Built, ctx: &Ctx<'_>) -> Result<Release, AppError> {
    render(&run::exec(helm, &built.args, &ctx.env(), cluster.endpoint, DRY_RUN_LIMIT).await?)
}

/// values를 임시 폴더에 쓴다. 폴더는 호출한 쪽이 쥐고 있다가 helm이 끝나면 지운다.
fn work_with_values(values: &Value) -> Result<(TempDir, PathBuf), AppError> {
    let work = tempfile::Builder::new().prefix("mm-helm-").tempdir().map_err(|_| AppError::other(chart::CHART_UNWRITABLE))?;
    let path = work.path().join("values.yaml");
    let text = if values.as_object().is_some_and(|m| m.is_empty()) { "{}\n".to_string() } else { serde_saphyr::to_string(values).map_err(|_| AppError::other(VALUES_NOT_YAML))? };
    std::fs::write(&path, text).map_err(|_| AppError::other(chart::CHART_UNWRITABLE))?;
    Ok((work, path))
}

async fn newest(cluster: &Cluster, namespace: &str, name: &str) -> Result<Option<(read::Stored, Vec<read::Stored>)>, AppError> {
    let stored = read::locate(cluster, namespace, name).await?;
    Ok(stored.first().cloned().map(|head| (head, stored)))
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// 사용자가 넣은 차트 위치를 helm 인자로(`~/`는 홈으로 푼다)
pub fn source_chart(source: &ChartSource) -> Result<ChartArg, AppError> {
    cli::resolve_chart(source, home().as_deref())
}

/// 변경의 계획과 그 계획을 적용하는 helm 명령을 만든다. 업그레이드·설치는 서버 dry-run을 돌려 새 manifest를 받는다.
async fn prepare(cluster: &Cluster, change: &Change) -> Result<(Plan, Job), AppError> {
    let namespace = change.target.namespace.as_deref().ok_or_else(|| AppError::other(INVALID_CHANGE))?;
    let name = change.target.name.as_str();
    cli::check_target(name, namespace)?;
    let helm = run::require().await?;
    let ctx = |driver: Driver| Ctx { context: &cluster.context, kubeconfig_paths: &cluster.kubeconfig_paths, driver };
    match &change.operation {
        Operation::HelmUpgrade { values, chart: source } => {
            let (head, _) = newest(cluster, namespace, name).await?.ok_or_else(|| AppError::other(read::NOT_FOUND))?;
            let current = read::fetch(cluster, &head).await?;
            let new_values = parse_values(values)?;
            let (work, values_path) = work_with_values(&new_values)?;
            let chart_arg = match source {
                Some(source) => source_chart(source)?,
                None => {
                    let dir = work.path().join("chart");
                    chart::write(&current.chart, &dir)?;
                    ChartArg::rebuilt(&dir, &format!("(리비전 {}의 차트)", current.version))
                }
            };
            let ctx = ctx(head.driver);
            let rendered = dry_render(cluster, &helm, &cli::upgrade(&ctx, name, namespace, &chart_arg, &values_path, true), &ctx).await?;
            let real = cli::upgrade(&ctx, name, namespace, &chart_arg, &values_path, false);
            let plan = plan_upgrade(change, &current, &rendered, &new_values, &real.shown)?;
            Ok((plan, Job { helm, args: real.args, env: ctx.env(), _work: Some(work) }))
        }
        Operation::HelmRollback { revision } => {
            let (head, stored) = newest(cluster, namespace, name).await?.ok_or_else(|| AppError::other(read::NOT_FOUND))?;
            let wanted = stored.iter().find(|s| s.revision == *revision).ok_or_else(|| AppError::other(read::REVISION_NOT_FOUND))?;
            let current = read::fetch(cluster, &head).await?;
            let target = if wanted.revision == head.revision { current.clone() } else { read::fetch(cluster, wanted).await? };
            let ctx = ctx(head.driver);
            let real = cli::rollback(&ctx, name, namespace, *revision);
            let plan = plan_rollback(change, &current, &target, &real.shown)?;
            Ok((plan, Job { helm, args: real.args, env: ctx.env(), _work: None }))
        }
        Operation::HelmUninstall { keep_history } => {
            let (head, _) = newest(cluster, namespace, name).await?.ok_or_else(|| AppError::other(read::NOT_FOUND))?;
            let current = read::fetch(cluster, &head).await?;
            let ctx = ctx(head.driver);
            let real = cli::uninstall(&ctx, name, namespace, *keep_history);
            let plan = plan_uninstall(change, &current, *keep_history, &real.shown)?;
            Ok((plan, Job { helm, args: real.args, env: ctx.env(), _work: None }))
        }
        Operation::HelmInstall { chart: source, values, create_namespace } => {
            if newest(cluster, namespace, name).await?.is_some_and(|(head, _)| head.status != "uninstalled") {
                return Err(AppError::other(ALREADY_EXISTS));
            }
            let new_values = parse_values(values)?;
            let chart_arg = source_chart(source)?;
            let (work, values_path) = work_with_values(&new_values)?;
            let ctx = ctx(Driver::Secret);
            let rendered = dry_render(cluster, &helm, &cli::install(&ctx, name, namespace, &chart_arg, &values_path, *create_namespace, true), &ctx).await?;
            let real = cli::install(&ctx, name, namespace, &chart_arg, &values_path, *create_namespace, false);
            let plan = plan_install(change, &rendered, &new_values, *create_namespace, &real.shown)?;
            Ok((plan, Job { helm, args: real.args, env: ctx.env(), _work: Some(work) }))
        }
        _ => Err(AppError::other(INVALID_CHANGE)),
    }
}

/// 미리보기: 계획을 만든다(업그레이드·설치는 서버 dry-run 포함)
pub async fn dry_plan(cluster: &Cluster, change: &Change) -> Result<Plan, AppError> {
    Ok(prepare(cluster, change).await?.0)
}

/// 적용: 같은 계획을 다시 만들어 미리보기와 같은지 확인하고 helm을 실행한다. 실행 결과는 계획과 함께 돌려준다(기록은 부른 쪽이 한다).
pub async fn apply(cluster: &Cluster, change: &Change, seen: &Plan, confirmation: Option<&str>) -> Result<(Plan, Result<(), AppError>), AppError> {
    let (plan, job) = prepare(cluster, change).await?;
    check(seen, &plan, confirmation)?;
    let result = run::exec(&job.helm, &job.args, &job.env, cluster.endpoint, APPLY_LIMIT).await.map(|_| ());
    Ok((plan, result))
}

#[cfg(test)]
mod tests;
