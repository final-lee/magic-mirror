use super::*;
use crate::pg::change::model::PgChange;
use crate::pg::change::support::*;
use crate::pg::fixtures::*;
use crate::pg::model::DefaultObjType;
use crate::pg::model::Privilege::{Insert, Select, Update};
use crate::pg::view::PgWarnLevel::*;

fn run(scene: &Scene, change: &PgChange) -> PgPreview {
    preview(&ctx(scene), change)
}

fn batch_of(scene: &Scene, changes: &[PgChange]) -> PgBatchPreview {
    preview_batch(&ctx(scene), "appdb", changes)
}

fn block_texts(warnings: &[PgWarning]) -> Vec<&str> {
    warnings.iter().filter(|w| w.level == Block).map(|w| w.message.as_str()).collect()
}

fn texts(warnings: &[PgWarning], level: crate::pg::view::PgWarnLevel) -> Vec<&str> {
    warnings.iter().filter(|w| w.level == level).map(|w| w.message.as_str()).collect()
}

fn create(name: &str, groups: &[&str]) -> PgChange {
    PgChange::CreateRole { name: name.into(), login: false, groups: strings(groups), connection_limit: -1, valid_until: None, preset: None }
}

fn session(start: Option<&str>) -> crate::pg::model::SessionRec {
    crate::pg::model::SessionRec {
        pid: 41,
        role: Some("alice".into()),
        database: None,
        client_addr: None,
        application_name: String::new(),
        state: None,
        backend_start: start.map(Into::into),
        query_start: None,
        wait_event: None,
    }
}

// ───────────────────────── 변경 하나 ─────────────────────────

#[test]
fn a_preview_carries_the_summary_the_login_the_database_and_the_masked_sql() {
    let s = admin(PG16);
    let change = grant("app_read", true, vec![item(rel("audit", "events"), &[Select])]);
    let p = run(&s, &change);
    assert_eq!(p.change, change);
    assert_eq!((p.database.as_str(), p.login_user.as_str()), ("appdb", "mm"));
    assert_eq!(p.summary, "권한 주기: app_read · audit.events SELECT");
    assert_eq!(p.sql, strings(&[r#"GRANT SELECT ON TABLE "audit"."events" TO "app_read""#]));
    // 로그인 역할을 만드는 변경은 비밀번호를 가린다
    let login = PgChange::CreateRole { name: "dave".into(), login: true, groups: Vec::new(), connection_limit: -1, valid_until: None, preset: None };
    assert_eq!(run(&s, &login).sql, strings(&[r#"CREATE ROLE "dave" LOGIN PASSWORD '••••••••'"#]));
    // 구성원 관계는 대상의 기본 데이터베이스에서 돈다
    let mut other = admin_of(PG16, &["app_read"]);
    other.db.database = "appdb".into();
    let p = preview(&PreviewCtx { default_db: "postgres", ..ctx(&other) }, &membership("app_read", "carol", true, false));
    assert_eq!(p.database, "postgres");
}

#[test]
fn the_same_input_gives_an_equal_preview() {
    for version in [PG15, PG16] {
        let s = admin_of(version, &["app_read"]);
        for change in [
            membership("app_read", "carol", true, false),
            grant("PUBLIC", true, vec![item(all_tables("audit"), &[Select])]),
            attributes(&s, "alice", |set| set.connection_limit = 4),
            create("dave", &["app_read"]),
        ] {
            assert_eq!(run(&s, &change), run(&s, &change), "{change:?}");
        }
        let changes = vec![membership("app_read", "carol", true, false), grant("app_read", true, vec![item(rel("audit", "events"), &[Select])])];
        assert_eq!(batch_of(&s, &changes), batch_of(&s, &changes));
    }
}

#[test]
fn the_confirm_target_is_the_member_the_role_or_the_grantee() {
    let s = admin(PG16);
    assert_eq!(confirm_target(&create("dave", &[])), "dave");
    assert_eq!(confirm_target(&membership("app_read", "carol", true, false)), "carol");
    assert_eq!(confirm_target(&attributes(&s, "alice", |_| {})), "alice");
    assert_eq!(confirm_target(&PgChange::Password { role: "alice".into() }), "alice");
    assert_eq!(confirm_target(&PgChange::DropRole { role: "tmp".into() }), "tmp");
    assert_eq!(confirm_target(&PgChange::Terminate { pid: 1, role: "bob".into(), backend_start: None }), "bob");
    assert_eq!(confirm_target(&grant("app_read", true, Vec::new())), "app_read");
    assert_eq!(confirm_target(&default_change("app_owner", None, DefaultObjType::Tables, "PUBLIC", &[Select], true)), "PUBLIC");
}

#[test]
fn the_confirm_text_is_the_target_only_when_something_needs_confirming() {
    let s = admin(PG16);
    let public = run(&s, &grant("PUBLIC", true, vec![item(rel("audit", "events"), &[Select])]));
    assert_eq!(public.confirm_text.as_deref(), Some("PUBLIC"));
    let plain = run(&s, &grant("app_read", true, vec![item(rel("audit", "events"), &[Select])]));
    assert_eq!(plain.confirm_text, None);
    let drop = admin_of(PG16, &["tmp"]).add_role(role("tmp"));
    assert_eq!(run(&drop, &PgChange::DropRole { role: "tmp".into() }).confirm_text.as_deref(), Some("tmp"));
}

#[test]
fn reversible_needs_no_block_every_inverse_and_a_non_empty_one() {
    let s = admin_of(PG16, &["app_read", "alice", "tmp"]).add_role(role("tmp"));
    let items = || vec![item(rel("audit", "events"), &[Select])];
    assert!(run(&s, &grant("app_read", true, items())).reversible);
    assert!(run(&s, &membership("app_read", "carol", true, false)).reversible);
    assert!(run(&s, &create("dave", &[])).reversible);
    // 아무것도 바꾸지 않는다
    assert!(!run(&s, &grant("app_read", true, vec![item(rel("app", "customers"), &[Select])])).reversible);
    // 되돌릴 수 없다
    assert!(!run(&s, &PgChange::DropRole { role: "tmp".into() }).reversible);
    assert!(!run(&s, &PgChange::Password { role: "alice".into() }).reversible);
    assert!(!run(&s, &membership("app_read", "bob", true, false)).reversible);
    // 막혔다
    assert!(!run(&s, &grant("app_read", true, vec![item(rel("app", "missing"), &[Select])])).reversible);
}

#[test]
fn a_replaced_session_is_blocked_in_the_preview() {
    let mut s = admin(PG16).add_member(member_with("mm", "alice", true, true));
    s.cluster.sessions.push(session(Some("2026-10-29T01:02:03Z")));
    let terminate = |start: &str| PgChange::Terminate { pid: 41, role: "alice".into(), backend_start: Some(start.into()) };
    let p = run(&s, &terminate("2026-10-29T09:09:09Z"));
    assert_eq!(block_texts(&p.warnings), vec!["세션이 이미 끝났어요"]);
    assert_eq!(p.confirm_text, None);
    let p = run(&s, &terminate("2026-10-29T01:02:03Z"));
    assert!(block_texts(&p.warnings).is_empty());
    assert_eq!(p.confirm_text.as_deref(), Some("alice"));
}

// ───────────────────────── 묶음의 막힘 ─────────────────────────

const EMPTY: &str = "담긴 변경이 없어요";
const OVER: &str = "한 번에 50개까지 적용할 수 있어요";
const NOT_TRAY: &str = "장바구니에 담을 수 없는 변경이에요";
const ANOTHER: &str = "다른 데이터베이스의 변경이 담겨 있어요. 먼저 적용하거나 비워 주세요";
const TWICE: &str = "같은 대상의 변경이 두 번 담겨 있어요";

#[test]
fn an_empty_or_oversized_batch_is_blocked_alone() {
    let s = admin(PG16);
    let p = batch_of(&s, &[]);
    assert_eq!(block_texts(&p.warnings), vec![EMPTY]);
    assert!(p.items.is_empty() && p.sql.is_empty() && !p.reversible && p.confirm_text.is_none());
    let many: Vec<PgChange> = (0..51).map(|n| membership("app_read", &format!("u{n}"), true, false)).collect();
    let p = batch_of(&s, &many);
    assert_eq!(block_texts(&p.warnings), vec![OVER]);
    assert!(p.items.is_empty());
    // 50개는 된다
    let fifty: Vec<PgChange> = (0..50).map(|n| membership("app_read", &format!("u{n}"), true, false)).collect();
    assert!(!block_texts(&batch_of(&s, &fifty).warnings).contains(&OVER));
}

#[test]
fn create_password_and_terminate_are_not_tray_changes() {
    let s = admin(PG16);
    for change in [create("dave", &[]), PgChange::Password { role: "alice".into() }, PgChange::Terminate { pid: 1, role: "alice".into(), backend_start: None }] {
        let p = batch_of(&s, std::slice::from_ref(&change));
        assert!(block_texts(&p.warnings).contains(&NOT_TRAY), "{change:?}");
    }
}

#[test]
fn a_grant_for_another_database_is_blocked() {
    let s = admin(PG16);
    let other = PgChange::Grant { database: "other".into(), grantee: "app_read".into(), add: true, items: vec![item(rel("audit", "events"), &[Select])] };
    assert!(block_texts(&batch_of(&s, &[other]).warnings).contains(&ANOTHER));
    let other_default = PgChange::DefaultPrivilege {
        database: "other".into(),
        creator: "app_owner".into(),
        schema: None,
        object_type: DefaultObjType::Tables,
        grantee: "app_read".into(),
        privileges: vec![Select],
        add: true,
    };
    assert!(block_texts(&batch_of(&s, &[other_default]).warnings).contains(&ANOTHER));
    // membership은 데이터베이스가 없다
    assert!(!block_texts(&batch_of(&admin_of(PG16, &["app_read"]), &[membership("app_read", "carol", true, false)]).warnings).contains(&ANOTHER));
}

#[test]
fn two_changes_with_the_same_target_are_blocked() {
    let s = admin_of(PG16, &["app_read"]).add_member(member_grants("bob", "app_read", &[("mm", false, Some(false), Some(true))]));
    let twice = |changes: &[PgChange]| block_texts(&batch_of(&s, changes).warnings).contains(&TWICE);
    let events = || item(rel("audit", "events"), &[Select]);
    // 같은 (받는 쪽, 객체, 권한)
    assert!(twice(&[grant("app_read", true, vec![events()]), grant("app_read", false, vec![item(rel("audit", "events"), &[Select, Update])])]));
    // 한 객체와 ALL TABLES가 겹친다
    assert!(twice(&[grant("app_read", true, vec![events()]), grant("app_read", true, vec![item(all_tables("audit"), &[Select])])]));
    // 받는 쪽, 객체, 권한 가운데 하나라도 다르면 괜찮다
    assert!(!twice(&[grant("app_read", true, vec![events()]), grant("app_write", true, vec![events()])]));
    assert!(!twice(&[grant("app_read", true, vec![events()]), grant("app_read", true, vec![item(rel("audit", "events"), &[Update])])]));
    assert!(!twice(&[grant("app_read", true, vec![events()]), grant("app_read", true, vec![item(rel("audit", "remote_log"), &[Select])])]));
    // 한 변경 안의 겹침은 두 번 담긴 것이 아니다
    assert!(!twice(&[grant("app_read", true, vec![events(), events()])]));
    // 구성원 관계 쌍
    assert!(twice(&[membership("app_read", "bob", false, false), membership("app_read", "bob", true, true)]));
    assert!(!twice(&[membership("app_read", "bob", false, false), membership("app_read", "carol", true, false)]));
    // 같은 역할의 속성
    let a = attributes(&s, "alice", |set| set.connection_limit = 3);
    let b = attributes(&s, "alice", |set| set.connection_limit = 4);
    assert!(twice(&[a.clone(), b]));
    assert!(!twice(&[a, attributes(&s, "bob", |set| set.connection_limit = 4)]));
    // 같은 기본 권한 열쇠와 권한
    let d = |grantee: &str, privileges: &[crate::pg::model::Privilege], add| default_change("app_owner", Some("app"), DefaultObjType::Tables, grantee, privileges, add);
    assert!(twice(&[d("app_read", &[Select], true), d("app_read", &[Select, Insert], false)]));
    assert!(!twice(&[d("app_read", &[Select], true), d("app_read", &[Insert], true)]));
    assert!(!twice(&[d("app_read", &[Select], true), d("app_write", &[Select], true)]));
    // 같은 역할을 두 번 지운다
    let drop = PgChange::DropRole { role: "alice".into() };
    assert!(twice(&[drop.clone(), drop]));
}

// ───────────────────────── 묶음의 순서와 내용 ─────────────────────────

#[test]
fn a_batch_runs_in_the_documented_order_and_items_keep_it() {
    let s = admin(PG15).add_role(role("tmp"));
    let changes = vec![
        PgChange::DropRole { role: "tmp".into() },
        membership("app_read", "bob", false, false),
        grant("app_read", false, vec![item(rel("app", "customers"), &[Select])]),
        default_change("app_owner", Some("app"), DefaultObjType::Tables, "app_read", &[Select], false),
        default_change("app_owner", Some("app"), DefaultObjType::Tables, "app_write", &[Select], true),
        grant("app_read", true, vec![item(rel("audit", "events"), &[Select])]),
        attributes(&s, "alice", |set| set.connection_limit = 3),
        membership("app_read", "carol", true, false),
    ];
    let p = batch_of(&s, &changes);
    assert_eq!(block_texts(&p.warnings), Vec::<&str>::new());
    assert_eq!(
        p.sql,
        strings(&[
            r#"GRANT "app_read" TO "carol""#,
            r#"ALTER ROLE "alice" CONNECTION LIMIT 3"#,
            r#"GRANT SELECT ON TABLE "audit"."events" TO "app_read""#,
            r#"ALTER DEFAULT PRIVILEGES FOR ROLE "app_owner" IN SCHEMA "app" GRANT SELECT ON TABLES TO "app_write""#,
            r#"ALTER DEFAULT PRIVILEGES FOR ROLE "app_owner" IN SCHEMA "app" REVOKE SELECT ON TABLES FROM "app_read""#,
            r#"REVOKE SELECT ON TABLE "app"."customers" FROM "app_read""#,
            r#"REVOKE "app_read" FROM "bob""#,
            r#"DROP ROLE "tmp""#,
        ])
    );
    let summaries: Vec<&str> = p.items.iter().map(|i| i.summary.as_str()).collect();
    assert_eq!(
        summaries,
        vec![
            "그룹에 넣기: carol → app_read",
            "속성 바꾸기: alice",
            "권한 주기: app_read · audit.events SELECT",
            "기본 권한 주기: app_owner → app_write",
            "기본 권한 빼기: app_owner → app_read",
            "권한 빼기: app_read · app.customers SELECT",
            "그룹에서 빼기: bob → app_read",
            "역할 삭제: tmp",
        ]
    );
    assert_eq!(p.items.iter().flat_map(|i| i.sql.clone()).collect::<Vec<_>>(), p.sql);
    assert_eq!((p.database.as_str(), p.login_user.as_str()), ("appdb", "mm"));
}

#[test]
fn within_a_kind_the_given_order_is_kept() {
    let s = admin(PG16);
    let changes = vec![
        grant("app_read", true, vec![item(rel("audit", "remote_log"), &[Select])]),
        grant("app_read", true, vec![item(rel("audit", "events"), &[Select])]),
    ];
    let p = batch_of(&s, &changes);
    assert_eq!(p.sql, strings(&[r#"GRANT SELECT ON TABLE "audit"."remote_log" TO "app_read""#, r#"GRANT SELECT ON TABLE "audit"."events" TO "app_read""#]));
}

#[test]
fn items_are_resolved_in_turn_on_one_pair_of_snapshots() {
    // 앞의 변경이 만든 상태가 뒤의 변경의 판단 근거다: 같은 묶음에서 새 그룹에 담은 권한은 구성원이 상속한다.
    // 영향은 첫 스냅숏과 마지막 스냅숏을 견준 것이다
    let s = admin_of(PG16, &["app_read"]).add_role(role("newbie"));
    let changes = vec![membership("app_read", "newbie", true, false), grant("app_read", true, vec![item(rel("audit", "events"), &[Select])])];
    let p = batch_of(&s, &changes);
    assert_eq!(block_texts(&p.warnings), Vec::<&str>::new());
    let newbie = p.impacts.iter().find(|i| i.role == "newbie").expect("newbie");
    assert!(newbie.gained.iter().any(|d| d.object_kind == crate::pg::view::PgObjectKind::Partitioned && d.sample == strings(&["events"])), "{:?}", newbie.gained);
    assert!(newbie.gained.iter().any(|d| d.privilege == "SELECT" && d.sample.contains(&"customers".to_string())));
    assert_eq!(p.roles.iter().find(|r| r.role == "newbie").map(|r| r.groups_added.clone()), Some(strings(&["app_read"])));
}

#[test]
fn item_warnings_stay_on_the_items_and_batch_warnings_are_batch_wide() {
    let s = admin_of(PG16, &["app_read"]);
    let changes = vec![grant("PUBLIC", true, vec![item(rel("audit", "events"), &[Select])]), membership("app_read", "carol", true, false)];
    let p = batch_of(&s, &changes);
    let public = "모든 역할(PUBLIC)에 권한을 줘요";
    let item_of = |kind: &str| p.items.iter().find(|i| i.summary.starts_with(kind)).expect("항목");
    assert!(texts(&item_of("권한 주기").warnings, Confirm).contains(&public));
    assert!(!texts(&p.warnings, Confirm).contains(&public));
    // 영향이 한 데이터베이스뿐이라는 알림은 묶음 전체에 한 번이다
    assert_eq!(texts(&p.warnings, Warn), vec!["영향은 appdb 데이터베이스만 계산했어요"]);
    // 확인할 것이 항목에만 있어도 확인 문구가 있다. 대상이 다르니 변경 개수다
    assert_eq!(p.confirm_text.as_deref(), Some("변경 2개 적용"));
}

#[test]
fn the_batch_confirm_text_is_the_common_target_or_the_count() {
    let s = admin(PG16);
    let two_public = vec![grant("PUBLIC", true, vec![item(rel("audit", "events"), &[Select])]), grant("PUBLIC", true, vec![item(rel("audit", "remote_log"), &[Select])])];
    assert_eq!(batch_of(&s, &two_public).confirm_text.as_deref(), Some("PUBLIC"));
    // 확인할 것이 없으면 없다
    let plain = vec![grant("app_read", true, vec![item(rel("audit", "events"), &[Select])])];
    assert_eq!(batch_of(&s, &plain).confirm_text, None);
}

#[test]
fn a_block_anywhere_drops_every_confirm_but_keeps_the_warns() {
    let mut s = admin(PG16);
    s.db.relations.iter_mut().find(|r| r.name == "customers").unwrap().acl.push(entry("someone", Some("app_read"), Select));
    let changes = vec![
        grant("PUBLIC", true, vec![item(rel("audit", "events"), &[Select])]),
        grant("app_read", false, vec![item(rel("app", "customers"), &[Select])]),
        grant("app_read", true, vec![item(rel("app", "missing"), &[Select])]),
    ];
    let p = batch_of(&s, &changes);
    assert!(p.items.iter().any(|i| !block_texts(&i.warnings).is_empty()));
    assert!(p.items.iter().all(|i| texts(&i.warnings, Confirm).is_empty()));
    assert_eq!(p.confirm_text, None);
    assert!(p.items.iter().any(|i| texts(&i.warnings, Warn).iter().any(|t| t.starts_with("다른 역할이 준 권한은 남아요"))));
    assert!(!p.reversible);
    // 묶음 자체의 막힘도 확인을 지운다
    let again = vec![changes[0].clone(), changes[0].clone()];
    let p = batch_of(&s, &again);
    assert_eq!(block_texts(&p.warnings), vec![TWICE]);
    assert_eq!(p.confirm_text, None);
}

#[test]
fn the_tables_without_defaults_warning_is_judged_on_the_snapshot_after_the_batch() {
    let s = admin(PG16);
    let all = grant("app_read", true, vec![item(all_tables("app"), &[Select])]);
    let warn = "새로 만드는 테이블에는 적용되지 않아요";
    let p = batch_of(&s, std::slice::from_ref(&all));
    let found = p.warnings.iter().find(|w| w.message == warn).expect("경고");
    assert_eq!(found.add, vec![default_change("app_owner", Some("app"), DefaultObjType::Tables, "app_read", &[Select], true)]);
    // 같은 묶음이 기본 권한을 이미 담았다
    let with_default = vec![all.clone(), default_change("app_owner", Some("app"), DefaultObjType::Tables, "app_read", &[Select], true)];
    assert!(!texts(&batch_of(&s, &with_default).warnings, Warn).contains(&warn));
    // 기본 권한이 뒤에 있어도(문장 차례는 권한이 먼저다) 같다
    let reversed = vec![with_default[1].clone(), with_default[0].clone()];
    assert!(!texts(&batch_of(&s, &reversed).warnings, Warn).contains(&warn));
}

#[test]
fn the_login_losing_access_is_judged_on_the_snapshot_after_the_batch() {
    let s = admin(PG15);
    let text = "적용하면 이 앱이 다시 접속하지 못할 수 있어요";
    let off = attributes(&s, "mm", |set| set.login = false);
    let p = batch_of(&s, std::slice::from_ref(&off));
    assert!(texts(&p.warnings, Confirm).contains(&text));
    assert_eq!(p.confirm_text.as_deref(), Some("mm"));
}

#[test]
fn a_batch_is_reversible_with_the_item_inverses_in_reverse_order() {
    let s = admin_of(PG16, &["app_read"]);
    let changes = vec![grant("app_read", true, vec![item(rel("audit", "events"), &[Select])]), membership("app_read", "carol", true, false)];
    let p = batch_of(&s, &changes);
    assert!(p.reversible);
    // 실행 순서는 구성원 넣기, 권한 주기다: 되돌림은 그 반대다
    assert_eq!(
        inverse_batch(&ctx(&s), "appdb", &changes),
        Some(vec![grant("app_read", false, vec![item(rel("audit", "events"), &[Select])]), membership("app_read", "carol", false, false)])
    );
    // 되돌릴 수 없는 항목이 하나라도 있으면 되돌릴 수 없다
    let with_drop = admin_of(PG16, &["app_read", "tmp"]).add_role(role("tmp"));
    let mixed = vec![changes[0].clone(), PgChange::DropRole { role: "tmp".into() }];
    assert!(!batch_of(&with_drop, &mixed).reversible);
    assert_eq!(inverse_batch(&ctx(&with_drop), "appdb", &mixed), None);
    // 아무것도 바꾸지 않는 묶음은 되돌릴 게 없다
    let nothing = vec![grant("app_read", true, vec![item(rel("app", "customers"), &[Select])])];
    assert!(!batch_of(&s, &nothing).reversible);
    assert_eq!(inverse_batch(&ctx(&s), "appdb", &nothing), Some(Vec::new()));
}

#[test]
fn a_batch_for_a_different_database_than_its_snapshot_is_blocked() {
    let s = admin(PG16);
    let p = preview_batch(&ctx(&s), "other", &[membership("app_read", "carol", true, false)]);
    assert!(block_texts(&p.warnings).contains(&"이 데이터베이스에서는 바꿀 수 없어요: other"));
}
