//! IAM 작업 공간: 작업 카탈로그, 정책 문서 파싱·매칭, 스냅숏 모델, 권한 계산, 보안 점검, 권한 줄이기, 직접 변경.
//! AWS 호출은 `fetch`·`fetch_policy`(읽기 전용)와 `write`(IAM을 바꾸는 호출은 `write.rs`에만 있다)에만 있고 나머지는 순수 코드다.
//! 변경은 `change`(미리보기·경고·역변경, 순수) → `commit`(적용 직전 재검증, 기록) → `write`(실행) 순서로 흐르고, `log`가 변경 기록 파일을 다룬다.

pub mod catalog;
pub mod change;
pub mod clock;
pub mod commit;
pub mod danger;
pub mod eval;
pub mod fetch;
pub mod fetch_policy;
#[cfg(test)]
pub mod fixtures;
pub mod findings;
pub mod lastused;
pub mod log;
#[cfg(test)]
pub mod mock_aws;
pub mod model;
pub mod overview;
pub mod policy;
pub mod summary;
pub mod text;
pub mod trust;
pub mod view;
pub mod write;
