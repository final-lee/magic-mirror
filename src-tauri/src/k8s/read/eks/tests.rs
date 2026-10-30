#![allow(deprecated)] // EncryptionConfig::resources: 시험에서 secrets 암호화를 만들려면 이 빌더가 필요하다

use aws_sdk_eks::operation::describe_cluster::DescribeClusterError;
use aws_sdk_eks::types::{
    AccessConfigResponse, AddonHealth, AddonIssue, AddonIssueCode, AddonStatus, AuthenticationMode, CapacityTypes, Category, ClusterStatus, EncryptionConfig, Identity,
    InsightStatus, InsightStatusValue, LogSetup, LogType, Logging, NodegroupScalingConfig, NodegroupStatus, Oidc, VpcConfigResponse,
};
use aws_smithy_runtime_api::client::orchestrator::HttpResponse;

use super::*;

#[test]
fn cluster_view_reads_access_logging_encryption_oidc_and_auth_mode() {
    let c = Cluster::builder()
        .version("1.31")
        .platform_version("eks.12")
        .status(ClusterStatus::Active)
        .resources_vpc_config(VpcConfigResponse::builder().endpoint_public_access(true).endpoint_private_access(false).public_access_cidrs("0.0.0.0/0").build())
        .logging(
            Logging::builder()
                .cluster_logging(LogSetup::builder().types(LogType::Api).types(LogType::Audit).enabled(true).build())
                .cluster_logging(LogSetup::builder().types(LogType::Scheduler).enabled(false).build())
                .build(),
        )
        .encryption_config(EncryptionConfig::builder().resources("secrets").build())
        .identity(Identity::builder().oidc(Oidc::builder().issuer("https://oidc.eks.ap-northeast-2.amazonaws.com/id/ABC").build()).build())
        .access_config(AccessConfigResponse::builder().authentication_mode(AuthenticationMode::ApiAndConfigMap).build())
        .build();
    assert_eq!(
        cluster_view(&c),
        ClusterView {
            version: "1.31".into(),
            platform_version: Some("eks.12".into()),
            status: Some("ACTIVE".into()),
            endpoint_public: true,
            endpoint_private: false,
            public_cidrs: vec!["0.0.0.0/0".into()],
            logging: vec!["api".into(), "audit".into()],
            secrets_encrypted: true,
            oidc_issuer: Some("https://oidc.eks.ap-northeast-2.amazonaws.com/id/ABC".into()),
            authentication_mode: Some("API_AND_CONFIG_MAP".into()),
        }
    );
    let bare = cluster_view(&Cluster::builder().build());
    assert!(!bare.secrets_encrypted && bare.logging.is_empty() && bare.oidc_issuer.is_none());
}

#[test]
fn nodegroup_addon_and_insight_views() {
    let n = Nodegroup::builder()
        .nodegroup_name("ng-1")
        .status(NodegroupStatus::Active)
        .version("1.30")
        .instance_types("m6i.large")
        .capacity_type(CapacityTypes::OnDemand)
        .scaling_config(NodegroupScalingConfig::builder().min_size(1).max_size(3).desired_size(2).build())
        .build();
    assert_eq!(
        nodegroup_view(&n),
        NodegroupView { name: "ng-1".into(), status: Some("ACTIVE".into()), version: Some("1.30".into()), instance_types: vec!["m6i.large".into()], capacity_type: Some("ON_DEMAND".into()), min: Some(1), max: Some(3), desired: Some(2) }
    );
    let a = Addon::builder()
        .addon_name("coredns")
        .addon_version("v1.11.1-eksbuild.4")
        .status(AddonStatus::Degraded)
        .health(AddonHealth::builder().issues(AddonIssue::builder().code(AddonIssueCode::InsufficientNumberOfReplicas).message("1 of 2 ready").build()).build())
        .build();
    assert_eq!(
        addon_view(&a, Some("v1.11.3-eksbuild.1".into())),
        AddonView { name: "coredns".into(), version: Some("v1.11.1-eksbuild.4".into()), latest: Some("v1.11.3-eksbuild.1".into()), status: Some("DEGRADED".into()), issues: vec!["InsufficientNumberOfReplicas: 1 of 2 ready".into()] }
    );
    let i = InsightSummary::builder()
        .name("Deprecated APIs removed in Kubernetes v1.32")
        .category(Category::UpgradeReadiness)
        .kubernetes_version("1.32")
        .insight_status(InsightStatus::builder().status(InsightStatusValue::Warning).reason("Deprecated API usage detected").build())
        .description("Checks for usage of deprecated APIs")
        .build();
    let v = insight_view(&i);
    assert_eq!((v.category.as_deref(), v.status.as_deref(), v.reason.as_deref(), v.kubernetes_version.as_deref()), (Some("UPGRADE_READINESS"), Some("WARNING"), Some("Deprecated API usage detected"), Some("1.32")));
}

#[test]
fn latest_version_compares_numbers_not_text() {
    let v = ["v1.9.0-eksbuild.3", "v1.10.0-eksbuild.1", "v1.10.0-eksbuild.2", "v1.2.0-eksbuild.9"];
    assert_eq!(latest_version(v.into_iter()), Some("v1.10.0-eksbuild.2".into()));
    assert_eq!(latest_version(std::iter::empty()), None);
}

#[tokio::test(start_paused = true)]
async fn calls_time_out_after_30_seconds() {
    let never = std::future::pending::<Result<(), SdkError<DescribeClusterError, HttpResponse>>>();
    assert_eq!(call(never, "eks:DescribeCluster").await, Err(AppError::Network { message: eks_timeout("eks:DescribeCluster") }));
    assert_eq!(eks_timeout("eks:ListInsights"), "EKS API가 30초 안에 답하지 않았어요(eks:ListInsights)");
}
