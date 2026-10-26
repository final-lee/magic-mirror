//! IAM 작업 공간: 작업 카탈로그, 정책 문서 파싱·매칭, 스냅숏 모델, 권한 계산, 보안 점검, 권한 줄이기.
//! AWS 호출은 `fetch`(읽기 전용)에만 있고 나머지는 순수 코드다.

pub mod catalog;
pub mod change;
pub mod clock;
pub mod danger;
pub mod eval;
pub mod fetch;
#[cfg(test)]
pub mod fixtures;
pub mod findings;
pub mod lastused;
pub mod model;
pub mod overview;
pub mod policy;
pub mod summary;
pub mod text;
pub mod trust;
pub mod view;
