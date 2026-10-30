//! EKS 탭. kubeconfig의 context로 접속해 클러스터를 읽는다. K1은 클러스터에 아무것도 쓰지 않는다(`hygiene`이 지킨다).
pub mod kubeconfig;

#[cfg(test)]
mod hygiene;
