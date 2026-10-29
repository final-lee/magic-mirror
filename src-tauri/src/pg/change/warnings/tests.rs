use crate::pg::change::model::{PgChange, PresetChoice, PresetKind};
use crate::pg::change::preview::preview;
use crate::pg::change::support::*;
use crate::pg::fixtures::*;
use crate::pg::model::Privilege::{Select, Update};
use crate::pg::model::{DefaultAclRec, DefaultObjType, SessionRec};
use crate::pg::view::{PgPreview, PgWarnLevel::*};

fn run(scene: &Scene, change: &PgChange) -> PgPreview {
    preview(&ctx(scene), change)
}

fn texts(p: &PgPreview, level: crate::pg::view::PgWarnLevel) -> Vec<&str> {
    p.warnings.iter().filter(|w| w.level == level).map(|w| w.message.as_str()).collect()
}

fn fires(scene: &Scene, change: &PgChange, level: crate::pg::view::PgWarnLevel, message: &str) -> bool {
    texts(&run(scene, change), level).contains(&message)
}

const SUPERUSER: &str = "rds_superuser를 주면 대부분의 관리 작업을 할 수 있게 돼요";
const CREATE_ROLE: &str = "CREATEROLE을 주면 역할을 만들고 바꿀 수 있게 돼요";
const PUBLIC: &str = "모든 역할(PUBLIC)에 권한을 줘요";

fn with_rds(version: i32) -> Scene {
    admin_of(version, &["rds_superuser", "rds_iam"]).add_role(role("rds_superuser")).add_role(role("rds_iam"))
}

fn preset(kind: PresetKind) -> PresetChoice {
    PresetChoice { preset: kind, database: if kind == PresetKind::Admin { None } else { Some("appdb".into()) }, schemas: strings(&["app"]), creators: Vec::new(), group: None, create_group: false }
}

fn create(name: &str, login: bool, groups: &[&str], preset: Option<PresetChoice>) -> PgChange {
    PgChange::CreateRole { name: name.into(), login, groups: strings(groups), connection_limit: -1, valid_until: None, preset }
}

// ───────────────────────── 확인 ─────────────────────────

#[test]
fn rds_superuser_asks_for_confirmation_when_given() {
    for version in [PG15, PG16] {
        let s = with_rds(version);
        assert!(fires(&s, &membership("rds_superuser", "alice", true, false), Confirm, SUPERUSER), "{version}");
        assert!(fires(&s, &create("dave", false, &["rds_superuser"], None), Confirm, SUPERUSER));
        let mut admin_preset = preset(PresetKind::Admin);
        admin_preset.schemas.clear();
        assert!(fires(&s, &create("dave", false, &[], Some(admin_preset)), Confirm, SUPERUSER));
        // 거나 다른 그룹이면 묻지 않는다
        assert!(!fires(&s, &membership("rds_iam", "alice", true, false), Confirm, SUPERUSER));
        assert!(!fires(&s, &create("dave", false, &["app_read"], Some(preset(PresetKind::ReadOnly))), Confirm, SUPERUSER));
        // 빼는 것은 묻지 않는다
        let s = s.add_member(member_grants("alice", "rds_superuser", &[("mm", false, Some(true), Some(true))]));
        assert!(!fires(&s, &membership("rds_superuser", "alice", false, false), Confirm, SUPERUSER), "{version}");
    }
}

#[test]
fn turning_createrole_on_asks_for_confirmation() {
    for version in [PG15, PG16] {
        let s = admin_of(version, &["alice"]);
        assert!(fires(&s, &attributes(&s, "alice", |set| set.create_role = true), Confirm, CREATE_ROLE), "{version}");
        assert!(!fires(&s, &attributes(&s, "alice", |set| set.connection_limit = 3), Confirm, CREATE_ROLE));
        // 이미 켜져 있으면 켜는 변경이 아니다
        let mut on = s.clone();
        on.role_mut("alice").create_role = true;
        assert!(!fires(&on, &attributes(&on, "alice", |set| set.connection_limit = 3), Confirm, CREATE_ROLE));
        assert!(!fires(&on, &attributes(&on, "alice", |set| set.create_role = false), Confirm, CREATE_ROLE));
    }
}

#[test]
fn granting_to_public_asks_for_confirmation() {
    let s = admin(PG16);
    let items = || vec![item(rel("audit", "events"), &[Select])];
    assert!(fires(&s, &grant("PUBLIC", true, items()), Confirm, PUBLIC));
    assert!(fires(&s, &default_change("app_owner", None, DefaultObjType::Tables, "PUBLIC", &[Select], true), Confirm, PUBLIC));
    assert!(!fires(&s, &grant("app_read", true, items()), Confirm, PUBLIC));
    let mut held = s.clone();
    held.db.relations.iter_mut().find(|r| r.name == "events").unwrap().acl.push(entry("app_owner", None, Select));
    assert!(!fires(&held, &grant("PUBLIC", false, vec![item(rel("audit", "events"), &[Select])]), Confirm, PUBLIC));
}

#[test]
fn dropping_and_terminating_ask_for_confirmation() {
    let s = admin_of(PG16, &["tmp"]).add_role(role("tmp")).add_member(member_with("mm", "alice", true, true));
    assert!(fires(&s, &PgChange::DropRole { role: "tmp".into() }, Confirm, "역할을 삭제해요. 되돌릴 수 없어요"));
    assert!(!fires(&s, &attributes(&s, "tmp", |set| set.connection_limit = 2), Confirm, "역할을 삭제해요. 되돌릴 수 없어요"));
    let mut t = s.clone();
    t.cluster.sessions.push(SessionRec {
        pid: 41,
        role: Some("alice".into()),
        database: None,
        client_addr: None,
        application_name: String::new(),
        state: None,
        backend_start: Some("2026-10-29T01:02:03Z".into()),
        query_start: None,
        wait_event: None,
    });
    let terminate = PgChange::Terminate { pid: 41, role: "alice".into(), backend_start: None };
    assert!(fires(&t, &terminate, Confirm, "세션을 끊어요. 되돌릴 수 없어요"));
    assert!(!fires(&t, &PgChange::Password { role: "alice".into() }, Confirm, "세션을 끊어요. 되돌릴 수 없어요"));
}

fn crowded(members: usize) -> Scene {
    (0..members).fold(admin_of(PG16, &["app_read"]), |scene, n| {
        let name = format!("u{n:02}");
        scene.add_role(role(&name)).add_member(member_with(&name, "app_read", true, true))
    })
}

#[test]
fn a_group_with_ten_direct_members_asks_for_confirmation() {
    let text = |n: usize| format!("구성원이 {n}명인 그룹의 권한을 바꿔요");
    // app_read의 직접 구성원은 app_write, bob, mm(ADMIN OPTION)에 더하는 만큼이다
    let ten = crowded(7);
    let nine = crowded(6);
    let items = || vec![item(rel("audit", "events"), &[Select])];
    assert!(fires(&ten, &grant("app_read", true, items()), Confirm, &text(10)));
    assert!(fires(&ten, &grant("app_read", false, vec![item(rel("app", "customers"), &[Select])]), Confirm, &text(10)));
    assert!(fires(&ten, &default_change("app_owner", None, DefaultObjType::Tables, "app_read", &[Select], true), Confirm, &text(10)));
    assert!(!fires(&nine, &grant("app_read", true, items()), Confirm, &text(9)));
    assert!(texts(&run(&nine, &grant("app_read", true, items())), Confirm).is_empty());
    // 큰 그룹을 다른 그룹에 넣는 변경도 같다(구성원이 큰 그룹이다)
    let into = ten.clone().add_role(role("outer")).add_member(member_grants("mm", "outer", &[(BOOTSTRAP, true, Some(true), Some(true))]));
    assert!(fires(&into, &membership("outer", "app_read", true, false), Confirm, &text(10)));
    assert!(!fires(&into, &membership("outer", "alice", true, false), Confirm, &text(10)));
}

#[test]
fn the_login_losing_access_asks_for_confirmation() {
    let text = "적용하면 이 앱이 다시 접속하지 못할 수 있어요";
    // LOGIN을 끈다(15 이하는 CREATEROLE만으로 자기 속성을 바꾼다)
    let s = admin(PG15);
    assert!(fires(&s, &attributes(&s, "mm", |set| set.login = false), Confirm, text));
    assert!(!fires(&s, &attributes(&s, "mm", |set| set.connection_limit = 3), Confirm, text));
    // 만료일이 지금보다 앞이다
    assert!(fires(&s, &attributes(&s, "mm", |set| set.valid_until = Some("2026-01-01T00:00:00Z".into())), Confirm, text));
    assert!(!fires(&s, &attributes(&s, "mm", |set| set.valid_until = Some("2030-01-01T00:00:00Z".into())), Confirm, text));
    // 이미 만료된 로그인은 달라지지 않는다
    let mut expired = s.clone();
    expired.role_mut("mm").valid_until = Some("2025-01-01T00:00:00Z".into());
    assert!(!fires(&expired, &attributes(&expired, "mm", |set| set.valid_until = Some("2026-01-01T00:00:00Z".into())), Confirm, text));
    // 역할을 관리할 수 없게 된다
    assert!(fires(&s, &attributes(&s, "mm", |set| set.create_role = false), Confirm, text));
    // rds_iam에서 빠진다(구성원 관계 사슬 어디든)
    let iam = admin(PG15).add_role(role("rds_iam")).add_role(role("iam_grp")).add_member(member("mm", "iam_grp")).add_member(member("iam_grp", "rds_iam"));
    assert!(fires(&iam, &membership("iam_grp", "mm", false, false), Confirm, text));
    assert!(!fires(&iam, &membership("iam_grp", "alice", true, false), Confirm, text));
}

#[test]
fn a_truncated_snapshot_asks_for_confirmation_on_bulk_grants() {
    let mut s = admin(PG16);
    s.db.truncated = true;
    let text = "객체가 많아 일부만 읽었어요. 영향에 없는 객체에도 적용돼요";
    assert!(fires(&s, &grant("app_read", true, vec![item(all_tables("audit"), &[Select])]), Confirm, text));
    assert!(!fires(&s, &grant("app_read", true, vec![item(rel("audit", "events"), &[Select])]), Confirm, text));
}

// ───────────────────────── 알림 ─────────────────────────

const TABLES: &str = "새로 만드는 테이블에는 적용되지 않아요";
const SEQUENCES: &str = "새로 만드는 시퀀스에는 적용되지 않아요";

fn default_rec(creator: &str, schema: Option<&str>, object_type: DefaultObjType, grantee: Option<&str>, privileges: &[crate::pg::model::Privilege]) -> DefaultAclRec {
    DefaultAclRec {
        creator: creator.into(),
        schema: schema.map(Into::into),
        obj_type: object_type,
        acl: privileges.iter().map(|&p| entry(creator, grantee, p)).collect(),
    }
}

#[test]
fn all_tables_without_defaults_warns_and_offers_the_default_privilege() {
    let s = admin(PG16);
    let change = grant("app_read", true, vec![item(all_tables("app"), &[Select])]);
    let p = run(&s, &change);
    let warning = p.warnings.iter().find(|w| w.message == TABLES).expect("경고");
    assert_eq!(warning.level, Warn);
    assert_eq!(warning.add, vec![default_change("app_owner", Some("app"), DefaultObjType::Tables, "app_read", &[Select], true)]);
    assert!(!texts(&p, Warn).contains(&SEQUENCES));
    // 시퀀스
    let p = run(&s, &grant("app_read", true, vec![item(crate::pg::change::model::GrantTarget::AllSequences { schema: "app".into() }, &[Select])]));
    let warning = p.warnings.iter().find(|w| w.message == SEQUENCES).expect("경고");
    assert_eq!(warning.add, vec![default_change("app_owner", Some("app"), DefaultObjType::Sequences, "app_read", &[Select], true)]);
}

#[test]
fn all_tables_with_defaults_or_without_a_gap_does_not_warn() {
    let change = grant("app_write", true, vec![item(all_tables("app"), &[Select])]);
    let none = |s: &Scene| !texts(&run(s, &change), Warn).contains(&TABLES);
    // 스키마별 기본 권한이 받는 쪽에게 이미 있다
    let mut s = admin(PG16);
    s.db.default_acls.push(default_rec("app_owner", Some("app"), DefaultObjType::Tables, Some("app_write"), &[Select]));
    assert!(none(&s));
    // 모든 스키마의 기본 권한
    let mut s = admin(PG16);
    s.db.default_acls.push(default_rec("app_owner", None, DefaultObjType::Tables, Some("app_write"), &[Select]));
    assert!(none(&s));
    // 받는 쪽이 상속하는 역할에 있다(app_write는 app_read를 상속한다)
    let mut s = admin(PG16);
    s.db.default_acls.push(default_rec("app_owner", Some("app"), DefaultObjType::Tables, Some("app_read"), &[Select]));
    assert!(none(&s));
    // PUBLIC에 있다
    let mut s = admin(PG16);
    s.db.default_acls.push(default_rec("app_owner", Some("app"), DefaultObjType::Tables, None, &[Select]));
    assert!(none(&s));
    // 권한이 모자라면 경고한다
    let mut s = admin(PG16);
    s.db.default_acls.push(default_rec("app_owner", Some("app"), DefaultObjType::Tables, Some("app_write"), &[Update]));
    assert!(!none(&s));
    // 소유자 자신이 받는 쪽이면 건너뛴다
    let owner = grant("app_owner", true, vec![item(all_tables("app"), &[Select])]);
    assert!(!texts(&run(&admin(PG16), &owner), Warn).contains(&TABLES));
    // 개별 객체에 주는 것은 새 테이블과 상관없다
    let one = grant("app_read", true, vec![item(rel("audit", "events"), &[Select])]);
    assert!(!texts(&run(&admin(PG16), &one), Warn).contains(&TABLES));
    // 거두는 것도 경고하지 않는다
    let revoke = grant("app_read", false, vec![item(all_tables("app"), &[Select])]);
    assert!(!texts(&run(&admin(PG16), &revoke), Warn).contains(&TABLES));
}

#[test]
fn a_preset_that_covers_its_creators_defaults_only_warns_for_other_owners() {
    // 프리셋이 app_owner의 기본 권한을 함께 주면 경고가 없다
    let s = admin(PG16);
    let mut covered = preset(PresetKind::ReadOnly);
    covered.creators = strings(&["app_owner"]);
    assert!(!texts(&run(&s, &create("dave", false, &[], Some(covered))), Warn).iter().any(|t| *t == TABLES || *t == SEQUENCES));
    // 다른 소유자의 테이블이 있으면 그 소유자만 경고한다
    let mut other = s.clone().add_role(role("other_owner"));
    other.db.relations.push(table("app", "extra", "other_owner"));
    let mut covered = preset(PresetKind::ReadOnly);
    covered.creators = strings(&["app_owner"]);
    let p = run(&other, &create("dave", false, &[], Some(covered)));
    let warning = p.warnings.iter().find(|w| w.message == TABLES).expect("경고");
    assert_eq!(warning.add, vec![default_change("other_owner", Some("app"), DefaultObjType::Tables, "dave", &[Select], true)]);
}

#[test]
fn membership_inherit_create_and_drop_note_that_only_one_database_was_counted() {
    let text = "영향은 appdb 데이터베이스만 계산했어요";
    let s = admin_of(PG16, &["app_read", "alice", "tmp"]).add_role(role("tmp"));
    assert!(fires(&s, &membership("app_read", "carol", true, false), Warn, text));
    assert!(fires(&s, &create("dave", false, &[], None), Warn, text));
    assert!(fires(&s, &PgChange::DropRole { role: "tmp".into() }, Warn, text));
    assert!(fires(&s, &attributes(&s, "alice", |set| set.inherit = false), Warn, text));
    // 권한과 다른 속성은 이 데이터베이스의 일이다
    assert!(!fires(&s, &attributes(&s, "alice", |set| set.connection_limit = 3), Warn, text));
    assert!(!fires(&s, &grant("app_read", true, vec![item(rel("audit", "events"), &[Select])]), Warn, text));
    // 달라지는 게 없는 구성원 관계 변경은 연산이 없다
    let done = s.clone().add_member(member_grants("alice", "app_write", &[("mm", false, Some(true), Some(true))]));
    assert!(!fires(&done, &membership("app_write", "alice", true, false), Warn, text));
}

#[test]
fn a_change_that_changes_nothing_says_so() {
    let text = "이미 그 상태라 달라지는 게 없어요";
    let s = admin_of(PG16, &["app_write"]);
    assert!(fires(&s, &grant("app_read", true, vec![item(rel("app", "customers"), &[Select])]), Warn, text));
    // 새 부여자의 줄이 더해지는 구성원 관계는 달라지는 것이다
    assert!(!fires(&s, &membership("app_write", "alice", true, false), Warn, text));
    let s2 = admin_of(PG16, &["app_write"]).add_member(member_grants("alice", "app_write", &[("mm", false, Some(true), Some(true))]));
    assert!(fires(&s2, &membership("app_write", "alice", true, false), Warn, text));
    assert!(fires(&s, &attributes(&s, "alice", |_| {}), Warn, text));
    assert!(!fires(&s, &grant("app_read", true, vec![item(rel("audit", "events"), &[Select])]), Warn, text));
    // 막힌 변경은 달라지는 게 없는 변경이 아니다
    assert!(!fires(&s, &grant("app_read", true, vec![item(rel("app", "missing"), &[Select])]), Warn, text));
    // 비밀번호와 세션은 스냅숏 밖의 일이다
    let password = admin_of(PG16, &["alice"]);
    assert!(!fires(&password, &PgChange::Password { role: "alice".into() }, Warn, text));
}

#[test]
fn grants_and_memberships_that_stay_are_listed() {
    // 다른 역할이 준 권한
    let mut s = admin(PG16);
    s.db.relations.iter_mut().find(|r| r.name == "customers").unwrap().acl.push(entry("someone", Some("app_read"), Select));
    let p = run(&s, &grant("app_read", false, vec![item(rel("app", "customers"), &[Select])]));
    assert!(texts(&p, Warn).contains(&"다른 역할이 준 권한은 남아요(1개, 예: someone → app.customers SELECT)"), "{:?}", p.warnings);
    // 다른 역할이 준 구성원 관계(160000부터)
    let m = admin_of(PG16, &["app_read"]).add_member(member_grants("bob", "app_read", &[(BOOTSTRAP, false, Some(false), Some(true)), ("mm", false, Some(false), Some(true))]));
    let p = run(&m, &membership("app_read", "bob", false, false));
    assert!(texts(&p, Warn).contains(&"다른 역할이 준 구성원 관계는 남아요: rdsadmin"), "{:?}", p.warnings);
    // 남는 게 없으면 알리지 않는다
    let none = run(&admin(PG16), &grant("app_read", false, vec![item(rel("app", "customers"), &[Select])]));
    assert!(texts(&none, Warn).iter().all(|t| !t.starts_with("다른 역할이 준")));
}

#[test]
fn an_rds_iam_user_warns_about_passwords() {
    let text = "이 사용자는 rds_iam 구성원이라 비밀번호로는 로그인하지 못해요";
    let s = admin_of(PG16, &["alice", "bob", "rds_iam"]).add_role(role("rds_iam")).add_member(member_with("alice", "rds_iam", true, true));
    assert!(fires(&s, &PgChange::Password { role: "alice".into() }, Warn, text));
    assert!(!fires(&s, &PgChange::Password { role: "bob".into() }, Warn, text));
    assert!(fires(&s, &create("dave", true, &["rds_iam"], None), Warn, text));
    assert!(!fires(&s, &create("dave", false, &["rds_iam"], None), Warn, text));
    assert!(!fires(&s, &create("dave", true, &["app_read"], None), Warn, text));
    // 사슬로 속해도 rds_iam 사용자다
    let chained = s.clone().add_role(role("iam_users")).add_member(member_with("bob", "iam_users", true, true)).add_member(member_with("iam_users", "rds_iam", true, true));
    assert!(fires(&chained, &PgChange::Password { role: "bob".into() }, Warn, text));
}

#[test]
fn a_schema_default_revoke_held_by_the_global_default_warns() {
    let text = "스키마별 기본 권한에서는 모든 스키마에 준 권한을 뺄 수 없어요. 모든 스키마의 기본 권한에서 빼 주세요";
    let mut s = admin(PG16);
    s.db.default_acls.push(default_rec("app_owner", None, DefaultObjType::Tables, Some("app_read"), &[Select]));
    let revoke = default_change("app_owner", Some("app"), DefaultObjType::Tables, "app_read", &[Select], false);
    assert!(fires(&s, &revoke, Warn, text));
    // 모든 스키마에서 빼는 것은 된다
    assert!(!fires(&s, &default_change("app_owner", None, DefaultObjType::Tables, "app_read", &[Select], false), Warn, text));
    // 스키마별 기록이 가진 것을 빼는 것은 된다
    let mut held = s.clone();
    held.db.default_acls.push(default_rec("app_owner", Some("app"), DefaultObjType::Tables, Some("app_read"), &[Select]));
    assert!(!fires(&held, &revoke, Warn, text));
    // 아무 데도 없는 것은 서버 내장 기본값도 아니다
    assert!(!fires(&admin(PG16), &revoke, Warn, text));
    // 내장 기본값이 가진 것(소유자 자신)
    let own = default_change("app_owner", Some("app"), DefaultObjType::Tables, "app_owner", &[Select], false);
    assert!(fires(&admin(PG16), &own, Warn, text));
}

#[test]
fn turning_login_off_warns_about_the_role_list() {
    let text = "LOGIN을 끄면 이 역할은 역할 목록의 그룹 쪽에 보여요";
    for version in [PG15, PG16] {
        let s = admin_of(version, &["alice", "app_read"]);
        assert!(fires(&s, &attributes(&s, "alice", |set| set.login = false), Warn, text), "{version}");
        assert!(!fires(&s, &attributes(&s, "alice", |set| set.connection_limit = 2), Warn, text));
        assert!(!fires(&s, &attributes(&s, "app_read", |set| set.login = false), Warn, text));
        assert!(!fires(&s, &attributes(&s, "app_read", |set| set.login = true), Warn, text));
    }
}

// ───────────────────────── 순서 ─────────────────────────

#[test]
fn warnings_go_block_then_confirm_then_warn_and_a_block_drops_the_confirms() {
    let mut s = crowded(7);
    s.db.relations.iter_mut().find(|r| r.name == "customers").unwrap().acl.push(entry("someone", Some("app_read"), Select));
    let revoke = vec![item(rel("app", "customers"), &[Select])];
    let p = run(&s, &grant("app_read", false, revoke.clone()));
    let levels: Vec<_> = p.warnings.iter().map(|w| w.level).collect();
    assert_eq!(levels, vec![Confirm, Warn]);
    assert_eq!(p.confirm_text.as_deref(), Some("app_read"));
    // 객체가 없으면 막히고 확인은 사라지며 알림은 남는다
    let mut blocked_items = revoke;
    blocked_items.push(item(rel("app", "missing"), &[Select]));
    let p = run(&s, &grant("app_read", false, blocked_items));
    let levels: Vec<_> = p.warnings.iter().map(|w| w.level).collect();
    assert_eq!(levels, vec![Block, Warn]);
    assert_eq!(p.confirm_text, None);
    assert!(!p.reversible);
}
