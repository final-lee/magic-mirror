//! helm 명령 인자 만들기. 클러스터를 바꾸는 helm 하위 명령(`upgrade`·`install`·`uninstall`·`rollback`)의 이름은 이 파일에만 있다(`hygiene`이 지킨다).
//! 인자는 문자열 배열로 넘기지 셸을 거치지 않는다. 사용자가 입력한 값(릴리스·네임스페이스·차트·저장소·버전)은 `-`로 시작하거나 공백·제어 문자를 품을 수 없다.
use std::path::{Path, PathBuf};

use super::release::Driver;
use super::ChartSource;
use crate::error::AppError;

pub const BAD_RELEASE_NAME: &str = "릴리스 이름은 소문자·숫자·-·.만 쓰고 53자 이하여야 해요";
pub const BAD_NAMESPACE: &str = "네임스페이스는 소문자·숫자·-만 쓰고 63자 이하여야 해요";
pub const BAD_CHART: &str = "차트 위치가 올바르지 않아요(공백이나 -로 시작하는 값은 쓸 수 없어요)";
pub const BAD_REPO: &str = "저장소 주소는 http:// 또는 https://로 시작하고 사용자 정보(user:pass@)가 없어야 해요";
pub const BAD_VERSION: &str = "차트 버전이 올바르지 않아요";
pub const REPO_WITH_OCI: &str = "oci:// 차트에는 저장소 주소를 쓸 수 없어요";
pub const REPO_NEEDS_NAME: &str = "저장소 주소를 쓰면 차트는 저장소 안의 이름이어야 해요(경로나 oci:// 주소가 아니라)";
pub const LOCAL_WITH_REPO: &str = "로컬 경로 차트에는 저장소 주소나 버전을 쓸 수 없어요";
pub const CHART_PATH_MISSING: &str = "차트 경로를 찾지 못했어요. 차트 폴더(Chart.yaml이 있는 곳)나 .tgz 파일의 절대 경로를 넣어 주세요";

/// helm을 부르는 클러스터 정보
pub struct Ctx<'a> {
    pub context: &'a str,
    pub kubeconfig_paths: &'a [PathBuf],
    pub driver: Driver,
}

impl Ctx<'_> {
    /// helm 프로세스에 줄 환경 변수. 릴리스를 어느 저장소(Secret·ConfigMap)에 두는지, 여러 kubeconfig일 때 그 목록.
    pub fn env(&self) -> Vec<(String, String)> {
        let mut env = vec![("HELM_DRIVER".to_string(), self.driver.env_value().to_string())];
        if self.kubeconfig_paths.len() != 1 {
            let joined = std::env::join_paths(self.kubeconfig_paths).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
            env.push(("KUBECONFIG".to_string(), joined));
        }
        env
    }
}

/// 실행할 인자와 화면에 보일 명령. 보이는 명령에는 임시 파일 경로와 kubeconfig 경로를 넣지 않는다.
#[derive(Clone, Debug, PartialEq)]
pub struct Built {
    pub args: Vec<String>,
    pub shown: String,
}

#[derive(Default)]
struct Line {
    args: Vec<String>,
    shown: Vec<String>,
}

impl Line {
    fn word(&mut self, word: &str) -> &mut Self {
        self.args.push(word.to_string());
        self.shown.push(word.to_string());
        self
    }

    fn pair(&mut self, flag: &str, value: &str) -> &mut Self {
        self.word(flag).word(value)
    }

    /// 실행에만 쓰는 인자(화면에는 없다)
    fn hidden(&mut self, words: &[&str]) -> &mut Self {
        self.args.extend(words.iter().map(|w| w.to_string()));
        self
    }

    /// 실제 경로로 실행하고 화면에는 `shown`을 보인다
    fn file(&mut self, flag: &str, shown: &str, real: &Path) -> &mut Self {
        self.args.push(flag.to_string());
        self.args.push(real.to_string_lossy().into_owned());
        self.shown.push(flag.to_string());
        self.shown.push(shown.to_string());
        self
    }

    fn chart(&mut self, chart: &ChartArg) -> &mut Self {
        self.args.push(chart.arg.clone());
        self.shown.push(chart.shown.clone());
        if let Some(repo) = &chart.repo {
            self.pair("--repo", repo);
        }
        if let Some(version) = &chart.version {
            self.pair("--version", version);
        }
        self
    }

    /// 어느 클러스터에 하는지: context는 보이고 kubeconfig 경로는 숨긴다
    fn cluster(&mut self, ctx: &Ctx) -> &mut Self {
        self.pair("--kube-context", ctx.context);
        if let [only] = ctx.kubeconfig_paths {
            self.hidden(&["--kubeconfig", &only.to_string_lossy()]);
        }
        self
    }

    fn built(self) -> Built {
        Built { args: self.args, shown: format!("helm {}", self.shown.join(" ")) }
    }
}

/// helm에 넘길 차트
#[derive(Clone, Debug, PartialEq)]
pub struct ChartArg {
    pub arg: String,
    pub shown: String,
    pub repo: Option<String>,
    pub version: Option<String>,
}

impl ChartArg {
    /// 임시 폴더로 되살린 차트(저장된 릴리스의 차트)
    pub fn rebuilt(dir: &Path, shown: &str) -> ChartArg {
        ChartArg { arg: dir.to_string_lossy().into_owned(), shown: shown.to_string(), repo: None, version: None }
    }
}

/// 공백·제어 문자가 없고 `-`로 시작하지 않는 한 낱말
fn plain(word: &str) -> bool {
    !word.is_empty() && !word.starts_with('-') && !word.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// helm의 릴리스 이름 규칙: DNS 서브도메인 꼴 소문자, 53자 이하
pub fn valid_release_name(name: &str) -> bool {
    let edge = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit();
    !name.is_empty()
        && name.len() <= 53
        && name.chars().next().is_some_and(edge)
        && name.chars().last().is_some_and(edge)
        && name.chars().all(|c| edge(c) || c == '-' || c == '.')
}

/// 쿠버네티스 네임스페이스(DNS 라벨) 규칙
pub fn valid_namespace(namespace: &str) -> bool {
    let edge = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit();
    !namespace.is_empty()
        && namespace.len() <= 63
        && namespace.chars().next().is_some_and(edge)
        && namespace.chars().last().is_some_and(edge)
        && namespace.chars().all(|c| edge(c) || c == '-')
}

/// 릴리스 이름과 네임스페이스를 확인한다. 이 둘은 인자가 되므로 어떤 변경이든 먼저 거친다.
pub fn check_target(release: &str, namespace: &str) -> Result<(), AppError> {
    if !valid_release_name(release) {
        return Err(AppError::other(BAD_RELEASE_NAME));
    }
    if !valid_namespace(namespace) {
        return Err(AppError::other(BAD_NAMESPACE));
    }
    Ok(())
}

/// `http(s)://`로 시작하고 사용자 정보가 없는 주소
fn valid_repo(repo: &str) -> bool {
    let Some(rest) = repo.strip_prefix("https://").or_else(|| repo.strip_prefix("http://")) else {
        return false;
    };
    let authority = rest.split('/').next().unwrap_or("");
    plain(repo) && !authority.is_empty() && !authority.contains('@')
}

/// 사용자가 넣은 차트 위치를 helm 인자로 바꾼다. 로컬 경로는 있는지 확인한다(`~/`는 `home`으로 푼다).
pub fn resolve_chart(source: &ChartSource, home: Option<&Path>) -> Result<ChartArg, AppError> {
    let reference = source.reference.trim();
    let repo = source.repo.as_deref().map(str::trim).filter(|r| !r.is_empty());
    let version = source.version.as_deref().map(str::trim).filter(|v| !v.is_empty());
    if !plain(reference) {
        return Err(AppError::other(BAD_CHART));
    }
    if repo.is_some_and(|r| !valid_repo(r)) {
        return Err(AppError::other(BAD_REPO));
    }
    if version.is_some_and(|v| !plain(v)) {
        return Err(AppError::other(BAD_VERSION));
    }
    let local = match reference.strip_prefix("~/") {
        Some(rest) => home.map(|h| h.join(rest)),
        None => Some(PathBuf::from(reference)).filter(|p| p.is_absolute()),
    };
    if let Some(path) = local {
        if repo.is_some() || version.is_some() {
            return Err(AppError::other(LOCAL_WITH_REPO));
        }
        if !path.is_dir() && !path.is_file() {
            return Err(AppError::other(CHART_PATH_MISSING));
        }
        let shown = path.to_string_lossy().into_owned();
        return Ok(ChartArg { arg: shown.clone(), shown, repo: None, version: None });
    }
    // 상대 경로는 helm의 작업 폴더가 정해져 있지 않아 쓰지 않는다
    if reference.starts_with('~') || reference.starts_with('.') {
        return Err(AppError::other(CHART_PATH_MISSING));
    }
    if reference.starts_with("oci://") {
        if repo.is_some() {
            return Err(AppError::other(REPO_WITH_OCI));
        }
    } else if repo.is_some() && (reference.contains('/') || reference.contains(':')) {
        return Err(AppError::other(REPO_NEEDS_NAME));
    }
    Ok(ChartArg { arg: reference.to_string(), shown: reference.to_string(), repo: repo.map(str::to_string), version: version.map(str::to_string) })
}

/// 서버 dry-run 뒤 릴리스를 JSON으로 받는 인자(화면의 명령에는 없다)
const DRY_RUN: [&str; 3] = ["--dry-run=server", "--output", "json"];

/// 업그레이드. `--reset-values`와 `-f`로 사용자 values를 통째로 바꾼다(키를 지우는 편집도 그대로 반영된다).
pub fn upgrade(ctx: &Ctx, release: &str, namespace: &str, chart: &ChartArg, values: &Path, dry_run: bool) -> Built {
    let mut line = Line::default();
    line.word("upgrade").word(release).chart(chart).pair("--namespace", namespace).word("--reset-values").file("--values", "values.yaml", values);
    if dry_run {
        line.hidden(&DRY_RUN);
    }
    line.cluster(ctx);
    line.built()
}

pub fn install(ctx: &Ctx, release: &str, namespace: &str, chart: &ChartArg, values: &Path, create_namespace: bool, dry_run: bool) -> Built {
    let mut line = Line::default();
    line.word("install").word(release).chart(chart).pair("--namespace", namespace);
    if create_namespace {
        line.word("--create-namespace");
    }
    line.file("--values", "values.yaml", values);
    if dry_run {
        line.hidden(&DRY_RUN);
    }
    line.cluster(ctx);
    line.built()
}

pub fn rollback(ctx: &Ctx, release: &str, namespace: &str, revision: u32) -> Built {
    let mut line = Line::default();
    line.word("rollback").word(release).word(&revision.to_string()).pair("--namespace", namespace);
    line.cluster(ctx);
    line.built()
}

pub fn uninstall(ctx: &Ctx, release: &str, namespace: &str, keep_history: bool) -> Built {
    let mut line = Line::default();
    line.word("uninstall").word(release).pair("--namespace", namespace);
    if keep_history {
        line.word("--keep-history");
    }
    line.cluster(ctx);
    line.built()
}

/// 차트의 기본 values를 보는 읽기 전용 명령(클러스터에 닿지 않는다)
pub fn show_values(chart: &ChartArg) -> Built {
    let mut line = Line::default();
    line.word("show").word("values").chart(chart);
    line.built()
}

#[cfg(test)]
mod tests;
