use aws_config::{BehaviorVersion, Region, SdkConfig};
use aws_credential_types::provider::SharedCredentialsProvider;
use aws_credential_types::Credentials;
use aws_sdk_rds::types::builders::{DbClusterBuilder, DbInstanceBuilder};
use aws_sdk_rds::types::Endpoint;
use aws_smithy_types::retry::RetryConfig;
use serde_json::json;

use super::*;
use crate::iam::mock_aws::Recorder;

const CLUSTER_ARN: &str = "arn:aws:rds:ap-northeast-2:111111111111:cluster:aurora-1";
const CLUSTER_ENDPOINT: &str = "aurora-1.cluster-abc.ap-northeast-2.rds.amazonaws.com";
const INSTANCE_ARN: &str = "arn:aws:rds:ap-northeast-2:111111111111:db:orders-db";
const INSTANCE_ENDPOINT: &str = "orders-db.abc.ap-northeast-2.rds.amazonaws.com";
const NOT_POSTGRES: &str = "PostgreSQL 엔진만 열 수 있어요";

fn cluster() -> DbClusterBuilder {
    DbCluster::builder()
        .db_cluster_identifier("aurora-1")
        .db_cluster_arn(CLUSTER_ARN)
        .engine("aurora-postgresql")
        .engine_version("16.4")
        .endpoint(CLUSTER_ENDPOINT)
        .port(5432)
}

fn instance() -> DbInstanceBuilder {
    DbInstance::builder()
        .db_instance_identifier("orders-db")
        .db_instance_arn(INSTANCE_ARN)
        .engine("postgres")
        .engine_version("15.7")
        .endpoint(Endpoint::builder().address(INSTANCE_ENDPOINT).port(5432).build())
}

fn target(kind: TargetKind, id: &str) -> PgTarget {
    PgTarget { profile: "dev".into(), region: "ap-northeast-2".into(), kind, id: id.into() }
}

#[test]
fn info_of_cluster_reads_the_writer_endpoint() {
    let info = info_of_cluster(&cluster().database_name("app").iam_database_authentication_enabled(true).build()).unwrap();
    assert_eq!(
        info,
        PgTargetInfo {
            arn: CLUSTER_ARN.into(),
            identifier: "aurora-1".into(),
            kind: TargetKind::Cluster,
            engine: "aurora-postgresql".into(),
            engine_version: "16.4".into(),
            endpoint: CLUSTER_ENDPOINT.into(),
            port: 5432,
            default_database: "app".into(),
            iam_auth: true,
            read_replica: false,
        }
    );
}

#[test]
fn a_cluster_without_a_database_name_opens_postgres() {
    assert_eq!(info_of_cluster(&cluster().build()).unwrap().default_database, "postgres");
    assert_eq!(info_of_cluster(&cluster().database_name("").build()).unwrap().default_database, "postgres");
}

#[test]
fn iam_authentication_is_off_unless_the_cluster_says_so() {
    assert!(!info_of_cluster(&cluster().build()).unwrap().iam_auth);
    assert!(!info_of_cluster(&cluster().iam_database_authentication_enabled(false).build()).unwrap().iam_auth);
}

#[test]
fn a_replication_source_makes_a_cluster_a_read_replica() {
    assert!(!info_of_cluster(&cluster().build()).unwrap().read_replica);
    let replica = cluster().replication_source_identifier("arn:aws:rds:us-east-1:111111111111:cluster:primary").build();
    assert!(info_of_cluster(&replica).unwrap().read_replica);
}

#[test]
fn a_cluster_keeps_a_non_default_port() {
    assert_eq!(info_of_cluster(&cluster().port(15432).build()).unwrap().port, 15432);
}

#[test]
fn info_of_instance_reads_its_endpoint() {
    let db = instance().db_name("orders").iam_database_authentication_enabled(true).build();
    assert_eq!(
        info_of_instance(&db).unwrap(),
        PgTargetInfo {
            arn: INSTANCE_ARN.into(),
            identifier: "orders-db".into(),
            kind: TargetKind::Instance,
            engine: "postgres".into(),
            engine_version: "15.7".into(),
            endpoint: INSTANCE_ENDPOINT.into(),
            port: 5432,
            default_database: "orders".into(),
            iam_auth: true,
            read_replica: false,
        }
    );
}

#[test]
fn an_instance_defaults_like_a_cluster() {
    let info = info_of_instance(&instance().build()).unwrap();
    assert_eq!(info.default_database, "postgres");
    assert!(!info.iam_auth);
    assert!(!info.read_replica);
}

#[test]
fn a_missing_port_means_the_postgres_default() {
    let no_port = DbCluster::builder().db_cluster_identifier("aurora-1").engine("aurora-postgresql").endpoint(CLUSTER_ENDPOINT).build();
    assert_eq!(info_of_cluster(&no_port).unwrap().port, 5432);
    let no_port = instance().endpoint(Endpoint::builder().address(INSTANCE_ENDPOINT).build()).build();
    assert_eq!(info_of_instance(&no_port).unwrap().port, 5432);
}

#[test]
fn an_instance_keeps_a_non_default_port() {
    let db = instance().endpoint(Endpoint::builder().address(INSTANCE_ENDPOINT).port(15432).build()).build();
    assert_eq!(info_of_instance(&db).unwrap().port, 15432);
}

#[test]
fn a_replica_source_makes_an_instance_a_read_replica() {
    let replica = instance().read_replica_source_db_instance_identifier("orders-primary").build();
    assert!(info_of_instance(&replica).unwrap().read_replica);
}

#[test]
fn non_postgres_targets_are_refused() {
    for engine in ["aurora-mysql", "mysql"] {
        assert_eq!(info_of_cluster(&cluster().engine(engine).build()), Err(AppError::other(NOT_POSTGRES)), "cluster {engine}");
        assert_eq!(info_of_instance(&instance().engine(engine).build()), Err(AppError::other(NOT_POSTGRES)), "instance {engine}");
    }
}

#[test]
fn an_unknown_engine_is_refused_before_the_endpoint_is_looked_at() {
    let no_engine = DbCluster::builder().db_cluster_identifier("aurora-1").build();
    assert_eq!(info_of_cluster(&no_engine), Err(AppError::other(NOT_POSTGRES)));
    let mysql_without_endpoint = DbInstance::builder().db_instance_identifier("m").engine("mysql").build();
    assert_eq!(info_of_instance(&mysql_without_endpoint), Err(AppError::other(NOT_POSTGRES)));
}

#[test]
fn a_target_without_an_endpoint_is_not_ready_yet() {
    let not_ready = AppError::other("엔드포인트가 아직 없어요");
    let creating = DbCluster::builder().db_cluster_identifier("aurora-1").engine("aurora-postgresql").build();
    assert_eq!(info_of_cluster(&creating), Err(not_ready.clone()));
    let no_address = instance().endpoint(Endpoint::builder().port(5432).build()).build();
    assert_eq!(info_of_instance(&no_address), Err(not_ready.clone()));
    let no_endpoint = DbInstance::builder().db_instance_identifier("orders-db").engine("postgres").build();
    assert_eq!(info_of_instance(&no_endpoint), Err(not_ready));
}

#[test]
fn the_contract_uses_camel_case_names() {
    let info = info_of_cluster(&cluster().database_name("app").iam_database_authentication_enabled(true).build()).unwrap();
    assert_eq!(
        serde_json::to_value(&info).unwrap(),
        json!({
            "arn": CLUSTER_ARN, "identifier": "aurora-1", "kind": "cluster",
            "engine": "aurora-postgresql", "engineVersion": "16.4",
            "endpoint": CLUSTER_ENDPOINT, "port": 5432, "defaultDatabase": "app",
            "iamAuth": true, "readReplica": false,
        })
    );
    let parsed: PgTarget = serde_json::from_value(json!({ "profile": "dev", "region": "ap-northeast-2", "kind": "instance", "id": "orders-db" })).unwrap();
    assert_eq!(parsed, target(TargetKind::Instance, "orders-db"));
}

// 아래는 `resolve`: 진짜 SDK가 만든 요청이 RDS 대신 기록기로 가고, 정해 둔 XML이 돌아온다.

const NAMESPACE: &str = "http://rds.amazonaws.com/doc/2014-10-31/";

fn describe_response(action: &str, list: &str, item: &str) -> String {
    format!(
        r#"<{action}Response xmlns="{NAMESPACE}"><{action}Result><{list}>{item}</{list}></{action}Result><ResponseMetadata><RequestId>req-1</RequestId></ResponseMetadata></{action}Response>"#
    )
}

fn error_response(code: &str) -> String {
    format!(r#"<ErrorResponse xmlns="{NAMESPACE}"><Error><Type>Sender</Type><Code>{code}</Code><Message>nope</Message></Error><RequestId>req-1</RequestId></ErrorResponse>"#)
}

fn config(recorder: &Recorder) -> SdkConfig {
    SdkConfig::builder()
        .behavior_version(BehaviorVersion::latest())
        .region(Region::new("ap-northeast-2"))
        .credentials_provider(SharedCredentialsProvider::new(Credentials::new("AKIDTEST", "secret", None, None, "test")))
        .http_client(recorder.clone())
        // 재시도가 켜져 있으면 일부러 실패시킨 요청이 여러 번 기록되고 테스트가 느려진다
        .retry_config(RetryConfig::disabled())
        .build()
}

const CLUSTER_XML: &str = "<DBCluster><DBClusterIdentifier>aurora-1</DBClusterIdentifier><DBClusterArn>arn:aws:rds:ap-northeast-2:111111111111:cluster:aurora-1</DBClusterArn>\
    <Engine>aurora-postgresql</Engine><EngineVersion>16.4</EngineVersion><Endpoint>aurora-1.cluster-abc.ap-northeast-2.rds.amazonaws.com</Endpoint>\
    <Port>5432</Port><DatabaseName>app</DatabaseName><IAMDatabaseAuthenticationEnabled>true</IAMDatabaseAuthenticationEnabled></DBCluster>";
const INSTANCE_XML: &str = "<DBInstance><DBInstanceIdentifier>orders-db</DBInstanceIdentifier><DBInstanceArn>arn:aws:rds:ap-northeast-2:111111111111:db:orders-db</DBInstanceArn>\
    <Engine>postgres</Engine><EngineVersion>15.7</EngineVersion><DBName>orders</DBName><IAMDatabaseAuthenticationEnabled>true</IAMDatabaseAuthenticationEnabled>\
    <Endpoint><Address>orders-db.abc.ap-northeast-2.rds.amazonaws.com</Address><Port>5432</Port><HostedZoneId>Z1</HostedZoneId></Endpoint></DBInstance>";

#[tokio::test]
async fn resolve_asks_for_the_cluster_by_its_identifier() {
    let recorder = Recorder::new(|_| (200, describe_response("DescribeDBClusters", "DBClusters", CLUSTER_XML)));
    let info = resolve(&config(&recorder), &target(TargetKind::Cluster, "aurora-1")).await.unwrap();
    let sent = recorder.sent();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].action, "DescribeDBClusters");
    assert_eq!(sent[0].params["DBClusterIdentifier"], "aurora-1");
    assert_eq!((info.kind, info.endpoint.as_str(), info.default_database.as_str(), info.iam_auth), (TargetKind::Cluster, CLUSTER_ENDPOINT, "app", true));
}

#[tokio::test]
async fn resolve_asks_for_the_instance_by_its_identifier() {
    let recorder = Recorder::new(|_| (200, describe_response("DescribeDBInstances", "DBInstances", INSTANCE_XML)));
    let info = resolve(&config(&recorder), &target(TargetKind::Instance, "orders-db")).await.unwrap();
    let sent = recorder.sent();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].action, "DescribeDBInstances");
    assert_eq!(sent[0].params["DBInstanceIdentifier"], "orders-db");
    assert_eq!((info.kind, info.endpoint.as_str(), info.default_database.as_str(), info.iam_auth), (TargetKind::Instance, INSTANCE_ENDPOINT, "orders", true));
}

#[tokio::test]
async fn resolve_names_the_denied_describe_call() {
    let recorder = Recorder::new(|_| (403, error_response("AccessDenied")));
    let cfg = config(&recorder);
    assert_eq!(
        resolve(&cfg, &target(TargetKind::Cluster, "aurora-1")).await,
        Err(AppError::AccessDenied { action: "rds:DescribeDBClusters".into() })
    );
    assert_eq!(
        resolve(&cfg, &target(TargetKind::Instance, "orders-db")).await,
        Err(AppError::AccessDenied { action: "rds:DescribeDBInstances".into() })
    );
}

#[tokio::test]
async fn resolve_reports_a_target_the_account_does_not_have() {
    let recorder = Recorder::new(|sent| match sent.action.as_str() {
        "DescribeDBClusters" => (200, describe_response("DescribeDBClusters", "DBClusters", "")),
        _ => (200, describe_response("DescribeDBInstances", "DBInstances", "")),
    });
    let cfg = config(&recorder);
    for kind in [TargetKind::Cluster, TargetKind::Instance] {
        let err = resolve(&cfg, &target(kind, "gone")).await.unwrap_err();
        assert_eq!(err, AppError::other("RDS에서 대상을 찾지 못했어요: gone"), "{kind:?}");
    }
}
