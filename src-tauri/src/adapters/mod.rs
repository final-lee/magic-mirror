pub mod ec2;
pub mod util;
pub mod vpc;

use std::sync::Arc;

use async_trait::async_trait;
use aws_config::SdkConfig;

use crate::aws::context::GLOBAL_REGION;
use crate::error::AppError;
use crate::model::{ListResult, ResourceType, ServiceInfo};

#[async_trait]
pub trait ResourceAdapter: Send + Sync {
    fn service_id(&self) -> &'static str;
    fn display_name(&self) -> &'static str;
    /// 리전과 무관한 서비스(IAM 등)는 true — us-east-1 클라이언트로 호출한다.
    fn is_global(&self) -> bool {
        false
    }
    fn resource_types(&self) -> Vec<ResourceType>;
    async fn list(&self, cfg: &SdkConfig, type_id: &str) -> Result<ListResult, AppError>;
}

pub type AdapterRef = Arc<dyn ResourceAdapter>;

/// 서비스 표시 순서대로 모든 어댑터를 돌려준다.
pub fn registry() -> Vec<AdapterRef> {
    vec![Arc::new(ec2::Ec2), Arc::new(vpc::Vpc)]
}

pub fn service_info(a: &dyn ResourceAdapter) -> ServiceInfo {
    ServiceInfo { id: a.service_id(), name: a.display_name(), global: a.is_global(), types: a.resource_types() }
}

pub fn find_adapter(adapters: &[AdapterRef], id: &str) -> Result<AdapterRef, AppError> {
    adapters
        .iter()
        .find(|a| a.service_id() == id)
        .cloned()
        .ok_or_else(|| AppError::other(format!("알 수 없는 서비스: {id}")))
}

pub fn effective_region<'a>(a: &dyn ResourceAdapter, region: &'a str) -> &'a str {
    if a.is_global() {
        GLOBAL_REGION
    } else {
        region
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake {
        global: bool,
    }

    #[async_trait]
    impl ResourceAdapter for Fake {
        fn service_id(&self) -> &'static str {
            "fake"
        }
        fn display_name(&self) -> &'static str {
            "Fake"
        }
        fn is_global(&self) -> bool {
            self.global
        }
        fn resource_types(&self) -> Vec<ResourceType> {
            vec![]
        }
        async fn list(&self, _cfg: &SdkConfig, _type_id: &str) -> Result<ListResult, AppError> {
            Ok(ListResult { items: vec![], truncated: false })
        }
    }

    #[test]
    fn find_adapter_by_id() {
        let adapters: Vec<AdapterRef> = vec![Arc::new(Fake { global: false })];
        assert_eq!(find_adapter(&adapters, "fake").unwrap().display_name(), "Fake");
        assert!(matches!(find_adapter(&adapters, "nope"), Err(AppError::Other { .. })));
    }

    #[test]
    fn global_services_use_us_east_1() {
        assert_eq!(effective_region(&Fake { global: true }, "ap-northeast-2"), "us-east-1");
        assert_eq!(effective_region(&Fake { global: false }, "ap-northeast-2"), "ap-northeast-2");
    }

    #[test]
    fn registry_ids_are_unique() {
        let ids: Vec<_> = registry().iter().map(|a| a.service_id()).collect();
        let mut dedup = ids.clone();
        dedup.sort();
        dedup.dedup();
        assert_eq!(ids.len(), dedup.len());
    }
}
