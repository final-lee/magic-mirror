//! 관계 트리(xray). 객체 하나에서 소유 사슬·자식, 이름으로 가리키는 것, 레이블로 고르는 것, 대상으로 삼는 것을 읽을 수 있는 목록만으로 계산한다.
//! GET·LIST만 쓰고(`hygiene`이 지킨다), 권한이 없는 종류는 실패가 아니라 `gaps`에 담고, 노드 수와 가지 수에 한도를 둔다.
use kube::Client;

use crate::error::AppError;
use crate::k8s::failure::Endpoint;
use crate::k8s::rows::KindRef;

pub mod graph;
pub mod model;
pub mod pool;
pub mod read;
pub mod refs;

use model::Xray;

/// 객체 하나의 관계 트리
pub async fn xray(client: &Client, kind: &KindRef, namespace: Option<&str>, name: &str, endpoint: Endpoint) -> Result<Xray, AppError> {
    let (root, pool) = read::gather(client, kind, namespace, name, endpoint).await?;
    Ok(graph::build(&root, &pool))
}

#[cfg(test)]
mod tests;
