//! 접근 화면(K4): 신원 연결, 실효 권한, 권한 표, 누가 할 수 있나, 워크로드 신원. 클러스터에는 읽기 요청만 보낸다.
//! - `rbac`, `engine`, `matrix`, `diff`, `identity`, `workload`: 순수 코드(계산 API는 `engine`의 문서에 있다).
//! - `read`: 쿠버네티스·EKS·IAM에서 읽기. `review`: `SubjectAccessReview` 대조(허용된 쓰기 모양 호출은 이 파일뿐).
//! - `view`: 화면에 보낼 모양.
//!
//! RBAC과 EKS access policy만 계산한다. 노드 인가, 승인 컨트롤러, 다른 인가 웹훅, IAM 정책은 보지 않는다.
pub mod diff;
pub mod engine;
pub mod identity;
pub mod matrix;
pub mod rbac;
pub mod read;
pub mod review;
pub mod view;
pub mod workload;

#[cfg(test)]
mod fixtures;
