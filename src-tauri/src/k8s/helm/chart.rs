//! 저장된 릴리스의 차트를 폴더로 되살린다. 저장소(repo) 접근 없이 같은 차트로 다시 렌더링하기 위해서다.
//! 서브차트는 `charts/<이름>/`에 풀어 넣고 Chart.yaml의 `dependencies`는 뺀다: 저장된 서브차트는 이미 조건·별칭을 적용한 뒤의 것이라
//! helm이 의존성을 다시 처리하면 이름이 맞지 않는다.
use std::fs;
use std::path::{Component, Path, PathBuf};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::Value;

use super::release::{Chart, File};
use crate::error::AppError;

pub const CHART_UNWRITABLE: &str = "릴리스의 차트를 임시 폴더에 풀지 못했어요";
pub const UNSAFE_PATH: &str = "릴리스 데이터에 폴더 밖을 가리키는 파일 이름이 있어요";

/// 폴더 안의 상대 경로만 받는다(`..`·절대 경로·드라이브 접두사는 거절)
fn safe_join(dir: &Path, name: &str) -> Result<PathBuf, AppError> {
    let relative = Path::new(name);
    if name.is_empty() || !relative.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(AppError::other(UNSAFE_PATH));
    }
    Ok(dir.join(relative))
}

fn write_file(dir: &Path, name: &str, bytes: &[u8]) -> Result<(), AppError> {
    let path = safe_join(dir, name)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| AppError::other(CHART_UNWRITABLE))?;
    }
    fs::write(path, bytes).map_err(|_| AppError::other(CHART_UNWRITABLE))
}

fn write_all(dir: &Path, files: &[File]) -> Result<(), AppError> {
    for file in files {
        let bytes = STANDARD.decode(file.data.trim()).map_err(|_| AppError::other(CHART_UNWRITABLE))?;
        write_file(dir, &file.name, &bytes)?;
    }
    Ok(())
}

/// Chart.yaml. JSON은 YAML의 부분집합이라 저장된 metadata를 그대로 쓴다.
fn chart_yaml(chart: &Chart) -> Result<String, AppError> {
    let mut metadata = chart.metadata.clone();
    if let Value::Object(map) = &mut metadata {
        map.remove("dependencies");
    }
    serde_json::to_string_pretty(&metadata).map_err(|_| AppError::other(CHART_UNWRITABLE))
}

/// 차트 하나(와 서브차트)를 `dir`에 쓴다. `dir`은 비어 있거나 없어야 한다.
pub fn write(chart: &Chart, dir: &Path) -> Result<(), AppError> {
    fs::create_dir_all(dir).map_err(|_| AppError::other(CHART_UNWRITABLE))?;
    write_file(dir, "Chart.yaml", chart_yaml(chart)?.as_bytes())?;
    let values = match &chart.values {
        Some(values) => serde_saphyr::to_string(values).map_err(|_| AppError::other(CHART_UNWRITABLE))?,
        None => "{}\n".to_string(),
    };
    write_file(dir, "values.yaml", values.as_bytes())?;
    if let Some(schema) = chart.schema.as_deref().filter(|s| !s.is_empty()) {
        let bytes = STANDARD.decode(schema.trim()).map_err(|_| AppError::other(CHART_UNWRITABLE))?;
        write_file(dir, "values.schema.json", &bytes)?;
    }
    write_all(dir, &chart.templates)?;
    write_all(dir, &chart.files)?;
    for dependency in &chart.dependencies {
        let name = dependency.name();
        write(dependency, &safe_join(&dir.join("charts"), &name)?)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
