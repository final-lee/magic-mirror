//! IAM 작업 공간: 작업 카탈로그, 정책 문서 파싱·매칭, 스냅숏 모델, 권한 계산. 순수 코드이고 AWS 호출은 하지 않는다.

pub mod catalog;
pub mod danger;
pub mod eval;
#[cfg(test)]
pub mod fixtures;
pub mod model;
pub mod policy;
pub mod summary;
pub mod trust;
pub mod view;
