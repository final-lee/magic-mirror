//! 접근 화면(K4)의 명령. 읽은 RBAC·신원 매핑과 계산 결과는 대상마다 하나 캐시한다(권한 표를 쪽마다 다시 읽지 않으려고).
//! 캐시는 연결(`Session`)이 바뀌거나 닫히면 쓰지 않는다. 연결을 붙들지 않게 약한 참조로만 가리킨다.
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use serde::Serialize;
use tauri::State;

use crate::commands::AppState;
use crate::error::AppError;
use crate::iam::clock::{iso, now_secs};
use crate::k8s::access::engine::{evaluate, Evaluation, Query, WhoCan};
use crate::k8s::access::identity::principals;
use crate::k8s::access::matrix::{self, Cell, CellDetail, MatrixPage, MatrixQuery};
use crate::k8s::access::rbac::Subject;
use crate::k8s::access::read::{self, WorkloadView};
use crate::k8s::access::review::{self, ReviewResult};
use crate::k8s::access::view::{self, AccessView};
use crate::k8s::target::K8sTarget;
use crate::k8s_commands::{K8sState, Session};

/// 누가 할 수 있나 응답에 싣는 주체 수 한도
pub const WHO_CAN_MAX: usize = 1000;

struct Cached {
    session: Weak<Session>,
    eval: Arc<Evaluation>,
    view: Arc<AccessView>,
}

#[derive(Default)]
pub struct AccessState {
    cache: Mutex<HashMap<K8sTarget, Arc<Cached>>>,
}

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhoCanView {
    pub entries: Vec<WhoCan>,
    /// 한도를 넘어 줄인 경우의 전체 수
    pub total: usize,
}

fn join_error(e: tokio::task::JoinError) -> AppError {
    AppError::other(e.to_string())
}

async fn ensure(app: &AppState, k8s: &K8sState, state: &AccessState, target: &K8sTarget, force: bool) -> Result<Arc<Cached>, AppError> {
    let session = k8s.session(target)?;
    if !force {
        if let Some(found) = locked(&state.cache).get(target).filter(|c| c.session.upgrade().is_some_and(|s| Arc::ptr_eq(&s, &session))) {
            return Ok(found.clone());
        }
    }
    let cfg = app.ctx.config(&target.profile, &target.region).await?;
    let eks = aws_sdk_eks::Client::new(&cfg);
    let mut loaded = read::load(&session.client, &eks, &target.cluster, session.endpoint).await;
    let rbac = loaded.rbac.take().unwrap_or_default();
    let mappings = principals(&loaded.mappings);
    let eval = tokio::task::spawn_blocking(move || evaluate(rbac, mappings)).await.map_err(join_error)?;
    let view = view::build(&loaded, &eval, &iso(now_secs()));
    let cached = Arc::new(Cached { session: Arc::downgrade(&session), eval: Arc::new(eval), view: Arc::new(view) });
    let mut cache = locked(&state.cache);
    cache.retain(|_, c| c.session.upgrade().is_some());
    cache.insert(target.clone(), cached.clone());
    Ok(cached)
}

/// 신원 연결과 권한 계산 요약. `force`면 캐시를 버리고 다시 읽는다. 출처마다 실패는 응답의 `gaps`에 담긴다.
#[tauri::command]
pub async fn k8s_access(app: State<'_, AppState>, k8s: State<'_, K8sState>, state: State<'_, AccessState>, target: K8sTarget, force: bool) -> Result<AccessView, AppError> {
    let cached = ensure(&app, &k8s, &state, &target, force).await?;
    Ok((*cached.view).clone())
}

/// 권한 표 한 쪽(필터·열 선택은 질의에 담긴다)
#[tauri::command]
pub async fn k8s_access_matrix(app: State<'_, AppState>, k8s: State<'_, K8sState>, state: State<'_, AccessState>, target: K8sTarget, query: MatrixQuery) -> Result<MatrixPage, AppError> {
    let cached = ensure(&app, &k8s, &state, &target, false).await?;
    tokio::task::spawn_blocking(move || matrix::matrix_page(&cached.eval, &query)).await.map_err(join_error)
}

/// 권한 표 칸 하나의 근거: 대표 요청별 허용 여부와 바인딩 경로
#[tauri::command]
pub async fn k8s_access_cell(
    app: State<'_, AppState>,
    k8s: State<'_, K8sState>,
    state: State<'_, AccessState>,
    target: K8sTarget,
    subject: Subject,
    cell: Cell,
    namespace: Option<String>,
) -> Result<CellDetail, AppError> {
    let cached = ensure(&app, &k8s, &state, &target, false).await?;
    tokio::task::spawn_blocking(move || matrix::cell_detail(&cached.eval, &subject, cell, namespace.as_deref())).await.map_err(join_error)
}

/// 요청 하나를 할 수 있는 주체와 경로
#[tauri::command]
pub async fn k8s_who_can(app: State<'_, AppState>, k8s: State<'_, K8sState>, state: State<'_, AccessState>, target: K8sTarget, query: Query) -> Result<WhoCanView, AppError> {
    let cached = ensure(&app, &k8s, &state, &target, false).await?;
    tokio::task::spawn_blocking(move || {
        let mut entries = cached.eval.who_can(&query);
        let total = entries.len();
        entries.truncate(WHO_CAN_MAX);
        WhoCanView { entries, total }
    })
    .await
    .map_err(join_error)
}

/// `SubjectAccessReview`로 이 주체가 이 요청을 할 수 있는지 클러스터에 직접 묻는다(엔진 계산과 대조용)
#[tauri::command]
pub async fn k8s_review(
    app: State<'_, AppState>,
    k8s: State<'_, K8sState>,
    state: State<'_, AccessState>,
    target: K8sTarget,
    query: Query,
    subject: Subject,
) -> Result<ReviewResult, AppError> {
    let cached = ensure(&app, &k8s, &state, &target, false).await?;
    let session = k8s.session(&target)?;
    let (user, groups) = cached.eval.identity_of(&subject);
    review::review(&session.client, user.as_deref(), &groups, &query, session.endpoint).await
}

/// ServiceAccount의 IRSA, Pod Identity 연결, 쓰는 Pod. 부분마다 실패는 응답의 `gaps`에 담긴다.
#[tauri::command]
pub async fn k8s_workload_identity(app: State<'_, AppState>, k8s: State<'_, K8sState>, target: K8sTarget) -> Result<WorkloadView, AppError> {
    let session = k8s.session(&target)?;
    let cfg = app.ctx.config(&target.profile, &target.region).await?;
    let eks = aws_sdk_eks::Client::new(&cfg);
    let iam = aws_sdk_iam::Client::new(&cfg);
    Ok(read::load_workload(&session.client, &eks, &iam, &target.cluster, session.endpoint).await)
}
