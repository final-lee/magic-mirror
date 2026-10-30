use aws_sdk_eks::types::{Cluster, VpcConfigResponse};

use super::*;

fn vpc() -> VpcConfigResponse {
    VpcConfigResponse::builder().endpoint_public_access(true).endpoint_private_access(true).public_access_cidrs("10.0.0.0/8").public_access_cidrs("1.2.3.4/32").build()
}

#[test]
fn cluster_info_reads_endpoint_access_and_cidrs() {
    let c = Cluster::builder()
        .arn("arn:aws:eks:ap-northeast-2:1:cluster/prod")
        .endpoint("https://abc.eks.amazonaws.com")
        .version("1.33")
        .resources_vpc_config(vpc())
        .build();
    let info = cluster_info(&c).unwrap();
    assert_eq!(info.arn, "arn:aws:eks:ap-northeast-2:1:cluster/prod");
    assert_eq!(info.endpoint, "https://abc.eks.amazonaws.com");
    assert_eq!(info.version, "1.33");
    assert!(info.endpoint_public && info.endpoint_private);
    assert_eq!(info.public_cidrs, ["10.0.0.0/8", "1.2.3.4/32"]);
}

#[test]
fn cluster_without_vpc_config_is_private_nowhere() {
    let c = Cluster::builder().endpoint("https://abc").build();
    let info = cluster_info(&c).unwrap();
    assert!(!info.endpoint_public && !info.endpoint_private);
    assert!(info.public_cidrs.is_empty());
}

#[test]
fn cluster_without_endpoint_is_an_error() {
    for c in [Cluster::builder().arn("a").build(), Cluster::builder().endpoint("").build()] {
        assert_eq!(cluster_info(&c).unwrap_err(), AppError::other(NO_ENDPOINT));
    }
}

#[test]
fn not_found_names_the_cluster() {
    assert_eq!(not_found("prod"), "클러스터를 찾을 수 없어요: prod");
}

#[test]
fn target_uses_camel_case() {
    let t: K8sTarget = serde_json::from_str(r#"{"profile":"p","region":"r","cluster":"c"}"#).unwrap();
    assert_eq!(serde_json::to_value(&t).unwrap(), serde_json::json!({"profile":"p","region":"r","cluster":"c"}));
}
