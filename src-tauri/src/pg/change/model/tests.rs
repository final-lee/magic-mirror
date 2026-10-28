use super::*;

fn names(all: &[&str]) -> Vec<String> {
    all.iter().map(|name| name.to_string()).collect()
}

fn relation(schema: &str, name: &str) -> GrantTarget {
    GrantTarget::Relation { schema: schema.into(), name: name.into() }
}

fn preset() -> PresetChoice {
    PresetChoice {
        preset: PresetKind::ReadOnly,
        database: Some("appdb".into()),
        schemas: names(&["app"]),
        creators: names(&["app_owner"]),
        group: Some("app_read".into()),
        create_group: true,
    }
}

fn create_role(preset: Option<PresetChoice>) -> PgChange {
    PgChange::CreateRole { name: "alice".into(), login: true, groups: names(&["app_read"]), connection_limit: 5, valid_until: Some("2027-01-01T00:00:00Z".into()), preset }
}

fn grant(database: &str) -> PgChange {
    PgChange::Grant {
        database: database.into(),
        grantee: "app_read".into(),
        add: true,
        items: vec![GrantItem { target: relation("app", "orders"), privileges: vec![Privilege::Select, Privilege::Insert] }],
    }
}

fn default_privilege(database: &str) -> PgChange {
    PgChange::DefaultPrivilege {
        database: database.into(),
        creator: "app_owner".into(),
        schema: Some("app".into()),
        object_type: DefaultObjType::Tables,
        grantee: "app_read".into(),
        privileges: vec![Privilege::Select],
        add: true,
    }
}

/// 변경 하나와, 계약이 정한 JSON 글자 그대로의 모양
fn every_variant() -> Vec<(PgChange, &'static str)> {
    vec![
        (
            create_role(None),
            r#"{"kind":"createRole","name":"alice","login":true,"groups":["app_read"],"connectionLimit":5,"validUntil":"2027-01-01T00:00:00Z","preset":null}"#,
        ),
        (
            create_role(Some(preset())),
            r#"{"kind":"createRole","name":"alice","login":true,"groups":["app_read"],"connectionLimit":5,"validUntil":"2027-01-01T00:00:00Z","preset":{"preset":"readOnly","database":"appdb","schemas":["app"],"creators":["app_owner"],"group":"app_read","createGroup":true}}"#,
        ),
        (
            PgChange::Membership { group: "app_read".into(), member: "alice".into(), add: true, admin: false },
            r#"{"kind":"membership","group":"app_read","member":"alice","add":true,"admin":false}"#,
        ),
        (
            PgChange::Attributes {
                role: "alice".into(),
                set: AttributesSet { login: true, create_db: false, create_role: false, inherit: true, connection_limit: -1, valid_until: None },
            },
            r#"{"kind":"attributes","role":"alice","set":{"login":true,"createDb":false,"createRole":false,"inherit":true,"connectionLimit":-1,"validUntil":null}}"#,
        ),
        (PgChange::Password { role: "alice".into() }, r#"{"kind":"password","role":"alice"}"#),
        (
            grant("appdb"),
            r#"{"kind":"grant","database":"appdb","grantee":"app_read","add":true,"items":[{"target":{"kind":"relation","schema":"app","name":"orders"},"privileges":["SELECT","INSERT"]}]}"#,
        ),
        (
            default_privilege("appdb"),
            r#"{"kind":"defaultPrivilege","database":"appdb","creator":"app_owner","schema":"app","objectType":"tables","grantee":"app_read","privileges":["SELECT"],"add":true}"#,
        ),
        (PgChange::DropRole { role: "alice".into() }, r#"{"kind":"dropRole","role":"alice"}"#),
        (
            PgChange::Terminate { pid: 4242, role: "bob".into(), backend_start: Some("2026-10-28T12:00:00Z".into()) },
            r#"{"kind":"terminate","pid":4242,"role":"bob","backendStart":"2026-10-28T12:00:00Z"}"#,
        ),
    ]
}

#[test]
fn every_change_has_the_json_shape_of_the_contract() {
    for (change, json) in every_variant() {
        assert_eq!(serde_json::to_string(&change).expect("serialize"), json);
    }
}

#[test]
fn every_change_round_trips_through_its_json() {
    for (change, json) in every_variant() {
        let read: PgChange = serde_json::from_str(json).unwrap_or_else(|e| panic!("{json}: {e}"));
        assert_eq!(read, change, "{json}");
        assert_eq!(serde_json::to_string(&read).expect("serialize"), json);
    }
}

#[test]
fn a_change_without_a_start_time_or_an_expiry_writes_null() {
    let terminate = PgChange::Terminate { pid: 7, role: "bob".into(), backend_start: None };
    assert_eq!(serde_json::to_string(&terminate).expect("serialize"), r#"{"kind":"terminate","pid":7,"role":"bob","backendStart":null}"#);
    let read: PgChange = serde_json::from_str(r#"{"kind":"terminate","pid":7,"role":"bob","backendStart":null}"#).expect("null");
    assert_eq!(read, terminate);
}

#[test]
fn every_grant_target_has_the_json_shape_of_the_contract() {
    let all = [
        (GrantTarget::Database { name: "orders".into() }, r#"{"kind":"database","name":"orders"}"#),
        (GrantTarget::Schema { name: "app".into() }, r#"{"kind":"schema","name":"app"}"#),
        (relation("app", "orders"), r#"{"kind":"relation","schema":"app","name":"orders"}"#),
        (GrantTarget::Sequence { schema: "app".into(), name: "orders_id_seq".into() }, r#"{"kind":"sequence","schema":"app","name":"orders_id_seq"}"#),
        (
            GrantTarget::Function { schema: "app".into(), name: "touch".into(), signature: "order_id integer".into() },
            r#"{"kind":"function","schema":"app","name":"touch","signature":"order_id integer"}"#,
        ),
        (GrantTarget::AllTables { schema: "app".into() }, r#"{"kind":"allTables","schema":"app"}"#),
        (GrantTarget::AllSequences { schema: "app".into() }, r#"{"kind":"allSequences","schema":"app"}"#),
    ];
    for (target, json) in all {
        assert_eq!(serde_json::to_string(&target).expect("serialize"), json);
        assert_eq!(serde_json::from_str::<GrantTarget>(json).expect("read"), target, "{json}");
    }
}

#[test]
fn every_preset_kind_has_its_contract_name() {
    for (kind, name) in [(PresetKind::ReadOnly, "readOnly"), (PresetKind::ReadWrite, "readWrite"), (PresetKind::Owner, "owner"), (PresetKind::Admin, "admin")] {
        assert_eq!(serde_json::to_string(&kind).expect("serialize"), format!("\"{name}\""));
        assert_eq!(serde_json::from_str::<PresetKind>(&format!("\"{name}\"")).expect("read"), kind);
    }
}

#[test]
fn every_privilege_is_written_and_read_by_its_aclexplode_name() {
    let all = [
        Privilege::Select,
        Privilege::Insert,
        Privilege::Update,
        Privilege::Delete,
        Privilege::Truncate,
        Privilege::References,
        Privilege::Trigger,
        Privilege::Maintain,
        Privilege::Execute,
        Privilege::Usage,
        Privilege::Create,
        Privilege::Connect,
        Privilege::Temporary,
    ];
    let item = GrantItem { target: GrantTarget::Schema { name: "app".into() }, privileges: all.to_vec() };
    let json = serde_json::to_string(&item).expect("serialize");
    assert_eq!(
        json,
        r#"{"target":{"kind":"schema","name":"app"},"privileges":["SELECT","INSERT","UPDATE","DELETE","TRUNCATE","REFERENCES","TRIGGER","MAINTAIN","EXECUTE","USAGE","CREATE","CONNECT","TEMPORARY"]}"#
    );
    assert_eq!(serde_json::from_str::<GrantItem>(&json).expect("read"), item);
}

#[test]
fn every_default_object_type_is_written_and_read_by_its_contract_name() {
    for (object_type, name) in [
        (DefaultObjType::Tables, "tables"),
        (DefaultObjType::Sequences, "sequences"),
        (DefaultObjType::Functions, "functions"),
        (DefaultObjType::Types, "types"),
        (DefaultObjType::Schemas, "schemas"),
    ] {
        let change = PgChange::DefaultPrivilege {
            database: "appdb".into(),
            creator: "app_owner".into(),
            schema: None,
            object_type,
            grantee: "PUBLIC".into(),
            privileges: vec![Privilege::Execute],
            add: false,
        };
        let json = format!(
            r#"{{"kind":"defaultPrivilege","database":"appdb","creator":"app_owner","schema":null,"objectType":"{name}","grantee":"PUBLIC","privileges":["EXECUTE"],"add":false}}"#
        );
        assert_eq!(serde_json::to_string(&change).expect("serialize"), json);
        assert_eq!(serde_json::from_str::<PgChange>(&json).expect("read"), change);
    }
}

#[test]
fn a_privilege_name_the_server_does_not_use_fails_to_deserialize() {
    // 이름은 `aclexplode`가 주는 글자 그대로다: 모르는 이름도, 소문자도, 줄임말(TEMP)도 읽지 않는다
    for bad in ["DROP", "select", "Select", "TEMP", "ALL", "", "SELECT "] {
        let item = format!(r#"{{"target":{{"kind":"schema","name":"app"}},"privileges":["SELECT","{bad}"]}}"#);
        let error = serde_json::from_str::<GrantItem>(&item).expect_err(bad).to_string();
        assert!(error.contains("알 수 없는 권한이에요"), "{bad:?}: {error}");
        let default = format!(
            r#"{{"kind":"defaultPrivilege","database":"d","creator":"c","schema":null,"objectType":"tables","grantee":"g","privileges":["{bad}"],"add":true}}"#
        );
        assert!(serde_json::from_str::<PgChange>(&default).is_err(), "{bad:?}");
    }
}

#[test]
fn something_that_is_not_a_known_kind_or_object_type_fails_to_deserialize() {
    for bad in [
        r#"{"kind":"createUser","name":"x"}"#,
        r#"{"kind":"password"}"#,
        r#"{"role":"alice"}"#,
        r#"{"kind":"defaultPrivilege","database":"d","creator":"c","schema":null,"objectType":"views","grantee":"g","privileges":[],"add":true}"#,
        r#"{"kind":"defaultPrivilege","database":"d","creator":"c","schema":null,"objectType":"Tables","grantee":"g","privileges":[],"add":true}"#,
    ] {
        assert!(serde_json::from_str::<PgChange>(bad).is_err(), "{bad}");
    }
    assert!(serde_json::from_str::<GrantTarget>(r#"{"kind":"view","schema":"app","name":"v"}"#).is_err());
    assert!(serde_json::from_str::<PresetKind>(r#""superuser""#).is_err());
}

#[test]
fn a_grant_and_a_default_privilege_run_in_their_own_database() {
    assert_eq!(grant("orders").execution_database("appdb"), "orders");
    assert_eq!(default_privilege("orders").execution_database("appdb"), "orders");
}

#[test]
fn a_create_role_runs_in_the_database_its_preset_names() {
    assert_eq!(create_role(Some(preset())).execution_database("postgres"), "appdb");
}

#[test]
fn a_create_role_without_a_preset_database_runs_in_the_default_database() {
    assert_eq!(create_role(None).execution_database("postgres"), "postgres");
    // 관리자 프리셋에는 데이터베이스가 없다
    let admin = PresetChoice { preset: PresetKind::Admin, database: None, schemas: vec![], creators: vec![], group: None, create_group: false };
    assert_eq!(create_role(Some(admin)).execution_database("postgres"), "postgres");
}

#[test]
fn every_other_change_runs_in_the_default_database() {
    let others = [
        PgChange::Membership { group: "app_read".into(), member: "alice".into(), add: true, admin: false },
        PgChange::Attributes {
            role: "alice".into(),
            set: AttributesSet { login: true, create_db: false, create_role: false, inherit: true, connection_limit: -1, valid_until: None },
        },
        PgChange::Password { role: "alice".into() },
        PgChange::DropRole { role: "alice".into() },
        PgChange::Terminate { pid: 4242, role: "bob".into(), backend_start: None },
    ];
    for change in others {
        assert_eq!(change.execution_database("appdb"), "appdb", "{change:?}");
    }
}
