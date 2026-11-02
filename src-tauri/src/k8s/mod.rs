//! EKS 탭. 조회와 변경을 분리하며 클러스터 쓰기는 `exec`에서만 보낸다.
pub mod change;
pub mod commit;
pub mod exec;
pub mod log;
pub mod connect;
pub mod failure;
pub mod kubeconfig;
pub mod logs;
pub mod path;
pub mod read;
pub mod review;
pub mod rows;
pub mod target;
pub mod tls;
pub mod watch;

#[cfg(test)]
mod hygiene;

#[cfg(test)]
mod live_tests;
