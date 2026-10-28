//! 계약 시험: 명령이 돌려주는 값의 JSON이 프런트엔드의 `src/pg/types.ts`와 필드마다 맞는지 본다.
//! 필드 이름(camelCase)과 열거형의 문자열, 값이 없는 칸이 생략이 아니라 `null`로 나가는 것을 지킨다.

use serde_json::{json, Value};

use super::*;
use crate::pg::eval::{Coverage, SchemaCell, SourceKind};
use crate::pg::model::{FunctionRec, RelKind};
use crate::pg::target::{PgTargetInfo, TargetKind};

fn to_json<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("json")
}

/// 열거형의 모든 값이 계약의 문자열로 나가는지
fn names<T: Serialize>(all: impl IntoIterator<Item = T>) -> Vec<Value> {
    all.into_iter().map(|value| to_json(&value)).collect()
}

fn strings(all: &[&str]) -> Vec<Value> {
    all.iter().map(|name| json!(name)).collect()
}

#[test]
fn the_enums_serialize_to_the_strings_of_the_contract() {
    {
        use PgBadgeKind::*;
        assert_eq!(
            names([Admin, IamAuth, CreateRole, CreateDb, BypassRls, Replication, Expired, ExpiringSoon, LoginRole]),
            strings(&["admin", "iamAuth", "createRole", "createDb", "bypassRls", "replication", "expired", "expiringSoon", "loginRole"])
        );
    }
    assert_eq!(names([PgBadgeLevel::High, PgBadgeLevel::Medium, PgBadgeLevel::Info]), strings(&["high", "medium", "info"]));
    assert_eq!(names([PgRoleKind::User, PgRoleKind::Group]), strings(&["user", "group"]));
    assert_eq!(names([PgCoverage::All, PgCoverage::Some, PgCoverage::None]), strings(&["all", "some", "none"]));
    assert_eq!(
        names([PgDefaultObjectType::Tables, PgDefaultObjectType::Sequences, PgDefaultObjectType::Functions, PgDefaultObjectType::Types, PgDefaultObjectType::Schemas]),
        strings(&["tables", "sequences", "functions", "types", "schemas"])
    );
    {
        use PgObjectKind::*;
        assert_eq!(
            names([Database, Schema, Table, View, Matview, Partitioned, Foreign, Sequence, Function]),
            strings(&["database", "schema", "table", "view", "matview", "partitioned", "foreign", "sequence", "function"])
        );
    }
    {
        use PgFindingKind::*;
        assert_eq!(
            names([PublicSchemaCreate, PublicObjectGrant, RdsSuperuser, CreateRole, BypassRls, ExpiringLogin, EmptyLogin, DefaultPrivilegeGap, SecurityDefinerPath, Md5Encryption]),
            strings(&[
                "publicSchemaCreate",
                "publicObjectGrant",
                "rdsSuperuser",
                "createRole",
                "bypassRls",
                "expiringLogin",
                "emptyLogin",
                "defaultPrivilegeGap",
                "securityDefinerPath",
                "md5Encryption"
            ])
        );
    }
    assert_eq!(names([PgFindingLevel::High, PgFindingLevel::Medium, PgFindingLevel::Low]), strings(&["high", "medium", "low"]));
    // 권한 출처의 종류는 평가기의 것이 그대로 계약이다
    assert_eq!(
        names([SourceKind::Owner, SourceKind::Direct, SourceKind::Group, SourceKind::Public, SourceKind::Predefined, SourceKind::Superuser]),
        strings(&["owner", "direct", "group", "public", "predefined", "superuser"])
    );
}

fn target_info() -> PgTargetInfo {
    PgTargetInfo {
        arn: "arn:aws:rds:ap-northeast-2:123456789012:cluster:orders-aurora".into(),
        identifier: "orders-aurora".into(),
        kind: TargetKind::Cluster,
        engine: "aurora-postgresql".into(),
        engine_version: "16.4".into(),
        endpoint: "orders-aurora.cluster-c9akciq32.ap-northeast-2.rds.amazonaws.com".into(),
        port: 5432,
        default_database: "orders".into(),
        iam_auth: true,
        read_replica: false,
    }
}

fn role_summary() -> PgRoleSummary {
    PgRoleSummary {
        name: "iam_admin".into(),
        kind: PgRoleKind::User,
        system: false,
        attributes: PgAttributes {
            login: true,
            create_db: false,
            create_role: true,
            inherit: true,
            replication: false,
            bypass_rls: false,
            connection_limit: -1,
            valid_until: Some("2026-11-05T12:00:00Z".into()),
        },
        member_of: vec![PgMembership { group: "rds_superuser".into(), inherit: true, admin: false }],
        member_count: 0,
        session_count: 2,
        badges: vec![PgBadge { kind: PgBadgeKind::Admin, label: "관리자급".into(), level: PgBadgeLevel::High }],
        comment: None,
    }
}

fn role_summary_json() -> Value {
    json!({
        "name": "iam_admin",
        "kind": "user",
        "system": false,
        "attributes": {
            "login": true, "createDb": false, "createRole": true, "inherit": true, "replication": false, "bypassRls": false,
            "connectionLimit": -1, "validUntil": "2026-11-05T12:00:00Z"
        },
        "memberOf": [{ "group": "rds_superuser", "inherit": true, "admin": false }],
        "memberCount": 0,
        "sessionCount": 2,
        "badges": [{ "kind": "admin", "label": "관리자급", "level": "high" }],
        "comment": null
    })
}

#[test]
fn the_overview_serializes_to_the_contract() {
    let overview = PgOverview {
        target: target_info(),
        login_user: "iam_admin".into(),
        server_version: "16.4".into(),
        server_version_num: 160004,
        password_encryption: "scram-sha-256".into(),
        fetched_at: "2026-10-28T12:00:00Z".into(),
        roles: vec![role_summary()],
        databases: vec![PgDatabaseInfo { name: "legacy_archive".into(), owner: "app_owner".into(), allow_conn: false }],
        can_manage: false,
        manage_reason: Some("이 사용자는 rds_superuser 멤버가 아니고 CREATEROLE도 없어서 바꿀 수 없어요".into()),
    };
    assert_eq!(
        to_json(&overview),
        json!({
            "target": {
                "arn": "arn:aws:rds:ap-northeast-2:123456789012:cluster:orders-aurora",
                "identifier": "orders-aurora",
                "kind": "cluster",
                "engine": "aurora-postgresql",
                "engineVersion": "16.4",
                "endpoint": "orders-aurora.cluster-c9akciq32.ap-northeast-2.rds.amazonaws.com",
                "port": 5432,
                "defaultDatabase": "orders",
                "iamAuth": true,
                "readReplica": false
            },
            "loginUser": "iam_admin",
            "serverVersion": "16.4",
            "serverVersionNum": 160004,
            "passwordEncryption": "scram-sha-256",
            "fetchedAt": "2026-10-28T12:00:00Z",
            "roles": [role_summary_json()],
            "databases": [{ "name": "legacy_archive", "owner": "app_owner", "allowConn": false }],
            "canManage": false,
            "manageReason": "이 사용자는 rds_superuser 멤버가 아니고 CREATEROLE도 없어서 바꿀 수 없어요"
        })
    );
    // 관리할 수 있으면 이유는 생략이 아니라 null이다
    let manageable = PgOverview { can_manage: true, manage_reason: None, ..overview };
    assert_eq!(to_json(&manageable)["manageReason"], Value::Null);
}

#[test]
fn a_role_without_expiry_or_comment_sends_nulls() {
    let mut role = role_summary();
    role.attributes.valid_until = None;
    let sent = to_json(&role);
    assert_eq!(sent["attributes"]["validUntil"], Value::Null);
    assert_eq!(sent["comment"], Value::Null);
}

#[test]
fn the_database_view_serializes_to_the_contract() {
    let view = PgDatabaseView {
        database: "orders".into(),
        fetched_at: "2026-10-28T12:00:00Z".into(),
        truncated: false,
        db_privileges: vec![PgDbPrivilegeRow { role: "alice".into(), connect: true, create: false, temp: true }],
        schemas: vec![PgSchemaInfo { name: "app".into(), owner: "app_owner".into(), table_count: 3 }],
        cells: vec![PgSchemaCell {
            role: "alice".into(),
            schema: "app".into(),
            usage: true,
            create: false,
            read: PgCoverage::All,
            write: PgCoverage::Some,
            inherited_only: true,
            unusable: None,
        }],
        default_privileges: vec![
            PgDefaultAclRow {
                creator: "app_owner".into(),
                schema: Some("app".into()),
                object_type: PgDefaultObjectType::Tables,
                grants: vec![PgDefaultGrant { grantee: "app_read".into(), privileges: vec!["SELECT".into()], grantable: false }],
            },
            PgDefaultAclRow { creator: "app_owner".into(), schema: None, object_type: PgDefaultObjectType::Types, grants: vec![] },
        ],
    };
    assert_eq!(
        to_json(&view),
        json!({
            "database": "orders",
            "fetchedAt": "2026-10-28T12:00:00Z",
            "truncated": false,
            "dbPrivileges": [{ "role": "alice", "connect": true, "create": false, "temp": true }],
            "schemas": [{ "name": "app", "owner": "app_owner", "tableCount": 3 }],
            "cells": [{
                "role": "alice", "schema": "app", "usage": true, "create": false, "read": "all", "write": "some",
                "inheritedOnly": true, "unusable": null
            }],
            "defaultPrivileges": [
                {
                    "creator": "app_owner", "schema": "app", "objectType": "tables",
                    "grants": [{ "grantee": "app_read", "privileges": ["SELECT"], "grantable": false }]
                },
                { "creator": "app_owner", "schema": null, "objectType": "types", "grants": [] }
            ]
        })
    );
}

#[test]
fn a_cell_of_the_evaluator_becomes_the_cell_of_the_contract() {
    let cell = SchemaCell {
        role: "bob".into(),
        schema: "app".into(),
        usage: false,
        create: false,
        read: Coverage::Some,
        write: Coverage::None,
        inherited_only: false,
        unusable: Some("CONNECT 없음"),
    };
    assert_eq!(
        to_json(&PgSchemaCell::from(cell)),
        json!({
            "role": "bob", "schema": "app", "usage": false, "create": false, "read": "some", "write": "none",
            "inheritedOnly": false, "unusable": "CONNECT 없음"
        })
    );
}

#[test]
fn the_cell_detail_and_who_can_serialize_to_the_contract() {
    let table = PgObjectRef { kind: PgObjectKind::Table, schema: Some("app".into()), name: "orders".into(), signature: None };
    let function = PgObjectRef { kind: PgObjectKind::Function, schema: Some("app".into()), name: "touch_order".into(), signature: Some("order_id integer".into()) };
    let source = PgSource { kind: SourceKind::Group, via: vec!["app_write".into(), "app_read".into()], grantor: Some("app_owner".into()) };

    let detail = PgCellDetail {
        role: "alice".into(),
        schema: "app".into(),
        objects: vec![PgCellObject {
            object: table.clone(),
            owner: "app_owner".into(),
            rls: true,
            privileges: vec![PgPrivilegeGrant { privilege: "SELECT".into(), sources: vec![source.clone()] }],
        }],
        truncated: true,
    };
    assert_eq!(
        to_json(&detail),
        json!({
            "role": "alice",
            "schema": "app",
            "objects": [{
                "object": { "kind": "table", "schema": "app", "name": "orders", "signature": null },
                "owner": "app_owner",
                "rls": true,
                "privileges": [{ "privilege": "SELECT", "sources": [{ "kind": "group", "via": ["app_write", "app_read"], "grantor": "app_owner" }] }]
            }],
            "truncated": true
        })
    );

    let who = PgWhoCan {
        object: function,
        privilege: "EXECUTE".into(),
        allowed: vec![PgWhoCanRow { role: "alice".into(), kind: PgRoleKind::User, system: false, sources: vec![source], unusable: Some("USAGE 없음".into()) }],
    };
    assert_eq!(
        to_json(&who),
        json!({
            "object": { "kind": "function", "schema": "app", "name": "touch_order", "signature": "order_id integer" },
            "privilege": "EXECUTE",
            "allowed": [{
                "role": "alice", "kind": "user", "system": false,
                "sources": [{ "kind": "group", "via": ["app_write", "app_read"], "grantor": "app_owner" }],
                "unusable": "USAGE 없음"
            }]
        })
    );
}

#[test]
fn a_session_serializes_to_the_contract() {
    let session = PgSession {
        pid: 3101,
        role: Some("iam_admin".into()),
        database: Some("orders".into()),
        client_addr: None,
        application_name: "magic-mirror".into(),
        state: Some("idle".into()),
        backend_start: Some("2026-10-28T11:42:10Z".into()),
        query_start: None,
        wait_event: None,
        own: true,
    };
    assert_eq!(
        to_json(&session),
        json!({
            "pid": 3101, "role": "iam_admin", "database": "orders", "clientAddr": null, "applicationName": "magic-mirror", "state": "idle",
            "backendStart": "2026-10-28T11:42:10Z", "queryStart": null, "waitEvent": null, "own": true
        })
    );
}

#[test]
fn the_role_view_serializes_to_the_contract() {
    let view = PgRoleView {
        summary: role_summary(),
        settings: vec![PgRoleSetting { database: None, setting: "search_path=app, public".into() }],
        members: vec![PgRoleMember { role: "alice".into(), inherit: false, admin: true }],
        databases: vec![
            PgRoleDatabase { database: "orders".into(), loaded: true, cells: vec![], owned: vec![PgObjectRef::schema("app")], owned_omitted: 4 },
            PgRoleDatabase { database: "analytics".into(), loaded: false, cells: vec![], owned: vec![], owned_omitted: 0 },
        ],
        sessions: vec![],
        set_role_only: vec!["app_read".into()],
    };
    assert_eq!(
        to_json(&view),
        json!({
            "summary": role_summary_json(),
            "settings": [{ "database": null, "setting": "search_path=app, public" }],
            "members": [{ "role": "alice", "inherit": false, "admin": true }],
            "databases": [
                {
                    "database": "orders", "loaded": true, "cells": [],
                    "owned": [{ "kind": "schema", "schema": null, "name": "app", "signature": null }], "ownedOmitted": 4
                },
                { "database": "analytics", "loaded": false, "cells": [], "owned": [], "ownedOmitted": 0 }
            ],
            "sessions": [],
            "setRoleOnly": ["app_read"]
        })
    );
}

#[test]
fn the_findings_serialize_to_the_contract() {
    let findings = PgFindings {
        groups: vec![PgFindingGroup {
            kind: PgFindingKind::SecurityDefinerPath,
            title: "search_path를 고정하지 않은 SECURITY DEFINER 함수".into(),
            level: PgFindingLevel::High,
            items: vec![
                PgFinding {
                    database: Some("orders".into()),
                    role: None,
                    object: Some(PgObjectRef { kind: PgObjectKind::Function, schema: Some("app".into()), name: "touch_order".into(), signature: Some("order_id integer".into()) }),
                    detail: "SECURITY DEFINER 함수인데 search_path를 고정하지 않았어요".into(),
                },
                PgFinding { database: None, role: Some("postgres".into()), object: None, detail: "x".into() },
            ],
        }],
        skipped: vec![PgSkippedDatabase { database: "analytics".into(), reason: "analytics에 연결하지 못했어요: permission denied".into() }],
        fetched_at: "2026-10-28T12:01:00Z".into(),
    };
    assert_eq!(
        to_json(&findings),
        json!({
            "groups": [{
                "kind": "securityDefinerPath",
                "title": "search_path를 고정하지 않은 SECURITY DEFINER 함수",
                "level": "high",
                "items": [
                    {
                        "database": "orders",
                        "role": null,
                        "object": { "kind": "function", "schema": "app", "name": "touch_order", "signature": "order_id integer" },
                        "detail": "SECURITY DEFINER 함수인데 search_path를 고정하지 않았어요"
                    },
                    { "database": null, "role": "postgres", "object": null, "detail": "x" }
                ]
            }],
            "skipped": [{ "database": "analytics", "reason": "analytics에 연결하지 못했어요: permission denied" }],
            "fetchedAt": "2026-10-28T12:01:00Z"
        })
    );
}

#[test]
fn an_object_ref_from_the_frontend_reads_back_and_the_constructors_follow_the_contract() {
    // 프런트엔드가 `pg_who_can`의 `object` 인자로 보내는 모양(`pg_objects`가 준 것을 그대로 돌려보낸다)
    let sent: PgObjectRef = serde_json::from_value(json!({ "kind": "function", "schema": "app", "name": "touch", "signature": "order_id integer" })).expect("object ref");
    assert_eq!(sent, PgObjectRef { kind: PgObjectKind::Function, schema: Some("app".into()), name: "touch".into(), signature: Some("order_id integer".into()) });
    let schema: PgObjectRef = serde_json::from_value(json!({ "kind": "schema", "schema": null, "name": "app", "signature": null })).expect("object ref");
    assert_eq!(schema, PgObjectRef::schema("app"));
    assert!(serde_json::from_value::<PgObjectRef>(json!({ "kind": "index", "schema": null, "name": "x", "signature": null })).is_err(), "모르는 종류는 받지 않아요");

    // 데이터베이스와 스키마는 스키마 칸이 비어 있고, 관계는 스키마와 이름이 있고, 함수는 인자 목록도 있다
    assert_eq!(to_json(&PgObjectRef::database("orders")), json!({ "kind": "database", "schema": null, "name": "orders", "signature": null }));
    let function = FunctionRec {
        schema: "app".into(),
        name: "touch".into(),
        signature: "order_id integer".into(),
        owner: "app_owner".into(),
        security_definer: false,
        search_path_set: false,
        acl: vec![],
    };
    assert_eq!(PgObjectRef::function(&function), sent);
}

#[test]
fn every_relation_kind_has_its_object_kind() {
    let all = [
        (RelKind::Table, "table"),
        (RelKind::View, "view"),
        (RelKind::MatView, "matview"),
        (RelKind::Partitioned, "partitioned"),
        (RelKind::Foreign, "foreign"),
        (RelKind::Sequence, "sequence"),
    ];
    for (kind, name) in all {
        assert_eq!(to_json(&PgObjectKind::of(kind)), json!(name));
    }
}
