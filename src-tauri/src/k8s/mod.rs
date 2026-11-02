//! EKS 탭. kubeconfig의 context로 접속해 클러스터를 읽는다. K1·K2는 클러스터에 아무것도 쓰지 않는다(`hygiene`이 지킨다).
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
