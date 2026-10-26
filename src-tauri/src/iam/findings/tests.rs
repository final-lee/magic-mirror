use serde_json::json;

use super::sample::*;
use super::FindingKind::*;
use super::*;
use crate::iam::clock::{iso, DAY_SECS};
use crate::iam::fixtures::{self, ADMIN_POLICY, ALICE, BOB, CAROL};
use crate::iam::model::{CredRow, RoleRec};
use crate::iam::view::{Badge, BadgeKind};

/// 테스트 스냅숏 + 보고서. 보고서에만 있던 사용자(dave·erin·frank·gina)도 계정에 있는 것으로 넣는다
/// (지금 계정에 없는 사용자의 보고서 줄은 점검하지 않는다).
fn snap() -> Snapshot {
    let mut s = fixtures::snapshot();
    s.cred_report = Some(parse_credential_report(&csv()));
    for name in ["dave", "erin", "frank", "gina"] {
        s.users.push(fixtures::user(name));
    }
    s
}

fn run() -> Findings {
    findings(&snap(), now())
}

fn group(f: &Findings, kind: FindingKind) -> &FindingGroup {
    f.groups.iter().find(|g| g.kind == kind).unwrap()
}

fn targets(f: &Findings, kind: FindingKind) -> Vec<&str> {
    group(f, kind).items.iter().map(|i| i.target_name.as_str()).collect()
}

fn item<'a>(f: &'a Findings, kind: FindingKind, name: &str) -> &'a FindingItem {
    group(f, kind).items.iter().find(|i| i.target_name == name).unwrap_or_else(|| panic!("{kind:?}에 {name}이 없어요"))
}

fn edit_row(s: &mut Snapshot, name: &str, edit: impl FnOnce(&mut CredRow)) {
    edit(s.cred_report.as_mut().unwrap().iter_mut().find(|r| r.user == name).unwrap());
}

fn edit_role(s: &mut Snapshot, name: &str, edit: impl FnOnce(&mut RoleRec)) {
    edit(s.roles.iter_mut().find(|r| r.name == name).unwrap());
}

fn days_ago(days: i64) -> String {
    iso(now() - days * DAY_SECS)
}

fn badge_kinds(s: &Snapshot, arn: &str) -> Vec<BadgeKind> {
    credential_badges(s, arn, now()).iter().map(|b| b.kind).collect()
}

// ---- 구조 ----

#[test]
fn groups_come_in_table_order_and_empty_ones_are_kept() {
    let f = findings(&Snapshot::default(), now());
    let kinds: Vec<FindingKind> = f.groups.iter().map(|g| g.kind).collect();
    assert_eq!(
        kinds,
        vec![
            RootAccessKey,
            RootNoMfa,
            ConsoleNoMfa,
            OldAccessKey,
            UnusedAccessKey,
            InactiveUser,
            InactiveRole,
            AdminPrincipal,
            PrivescPrincipal,
            ExternalTrust,
            UnattachedPolicy
        ]
    );
    assert!(f.groups.iter().all(|g| g.items.is_empty()));
    let meta: Vec<(&str, Level)> = f.groups.iter().map(|g| (g.title.as_str(), g.level)).collect();
    assert_eq!(
        meta,
        vec![
            ("루트 액세스 키", Level::Danger),
            ("루트 MFA 없음", Level::Danger),
            ("MFA 없는 콘솔 사용자", Level::Danger),
            ("오래된 액세스 키", Level::Warn),
            ("안 쓰는 액세스 키", Level::Warn),
            ("안 쓰는 사용자", Level::Info),
            ("안 쓰는 역할", Level::Info),
            ("관리자급 주체", Level::Warn),
            ("권한 상승 위험 주체", Level::Warn),
            // 누구나 조건 없이 맡을 수 있는 역할이 있을 때만 위험이다
            ("외부에 열린 신뢰", Level::Warn),
            ("붙은 곳 없는 정책", Level::Info),
        ]
    );
    assert_eq!(f.generated_at, None);
}

#[test]
fn kinds_are_declared_in_the_same_order_as_the_table() {
    for (position, (kind, _, _)) in TABLE.iter().enumerate() {
        assert_eq!(*kind as usize, position, "{kind:?}");
    }
}

#[test]
fn json_shape_matches_the_contract() {
    let mut s = snap();
    s.fetched_at = "2026-10-26T00:00:00Z".into();
    let value = serde_json::to_value(findings(&s, now())).unwrap();
    let mut keys: Vec<&str> = value.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, vec!["generatedAt", "groups", "warnings"]);
    assert_eq!(value["generatedAt"], json!("2026-10-26T00:00:00Z"));
    let first = &value["groups"][0];
    assert_eq!((first["kind"].clone(), first["level"].clone()), (json!("rootAccessKey"), json!("danger")));
    let mut group_keys: Vec<&str> = first.as_object().unwrap().keys().map(String::as_str).collect();
    group_keys.sort_unstable();
    assert_eq!(group_keys, vec!["items", "kind", "level", "title"]);
    let item = &value["groups"][2]["items"][0];
    let mut item_keys: Vec<&str> = item.as_object().unwrap().keys().map(String::as_str).collect();
    item_keys.sort_unstable();
    assert_eq!(item_keys, vec!["cli", "detail", "fix", "targetArn", "targetName"]);
    assert!(item["fix"].is_null());
    assert_eq!(value["groups"][6]["kind"], json!("inactiveRole"));
    assert_eq!(value["groups"][10]["kind"], json!("unattachedPolicy"));
}

#[test]
fn a_quick_fix_serializes_as_the_change_object() {
    // 자격 증명 보고서에는 키 ID가 없어서 지금은 항상 null이지만, 키 ID를 아는 쪽이 채우면 이 모양으로 나간다
    let fix = IamChange::SetAccessKeyStatus { user_name: "bob".into(), access_key_id: "AKIAEXAMPLE".into(), status: "Inactive".into() };
    let item = FindingItem { target_arn: "arn".into(), target_name: "bob".into(), detail: "d".into(), cli: None, fix: Some(fix) };
    assert_eq!(
        serde_json::to_value(&item).unwrap()["fix"],
        json!({ "op": "setAccessKeyStatus", "userName": "bob", "accessKeyId": "AKIAEXAMPLE", "status": "Inactive" })
    );
}

#[test]
fn without_a_report_only_the_report_free_checks_run() {
    let mut s = fixtures::snapshot();
    s.warnings.push("자격 증명 보고서를 불러오지 못했어요: 권한 없음 (iam:GenerateCredentialReport)".into());
    let f = findings(&s, now());
    for kind in [RootAccessKey, RootNoMfa, ConsoleNoMfa, OldAccessKey, UnusedAccessKey, InactiveUser] {
        assert!(group(&f, kind).items.is_empty(), "{kind:?}");
    }
    assert_eq!(targets(&f, AdminPrincipal), vec!["alice"]);
    assert_eq!(targets(&f, UnattachedPolicy), vec!["unused-policy"]);
    // 스냅숏 경고가 먼저, 점검을 건너뛴 사실이 그 뒤에 온다
    assert!(f.warnings[0].starts_with("자격 증명 보고서를 불러오지 못했어요"), "{:?}", f.warnings);
    assert!(f.warnings.iter().any(|w| w.contains("건너뛰었어요")), "{:?}", f.warnings);
    // 보고서가 있으면 건너뛴다는 말은 없다
    assert!(run().warnings.is_empty());
}

#[test]
fn generated_at_is_the_report_time_or_else_the_snapshot_time_when_there_is_a_report() {
    let mut s = snap();
    s.fetched_at = "2026-10-25T12:00:00Z".into();
    // 보고서가 만든 시각을 알려 주지 않았으면 스냅숏을 읽은 시각이다
    assert_eq!(findings(&s, now()).generated_at.as_deref(), Some("2026-10-25T12:00:00Z"));
    // 보고서는 스냅숏보다 오래됐을 수 있다. 점검은 가장 오래된 자료의 시각을 기준으로 알린다
    s.cred_generated_at = Some("2026-10-25T08:00:00Z".into());
    assert_eq!(findings(&s, now()).generated_at.as_deref(), Some("2026-10-25T08:00:00Z"));
}

#[test]
fn without_a_report_there_is_no_generated_time() {
    // 보고서로 하는 점검을 건너뛰었으니 "이 시각에 점검했다"고 말할 수 없다
    let mut s = fixtures::snapshot();
    assert!(!s.fetched_at.is_empty());
    assert_eq!(findings(&s, now()).generated_at, None);
    s.cred_generated_at = Some("2026-10-25T08:00:00Z".into());
    assert_eq!(findings(&s, now()).generated_at, None);
    assert!(serde_json::to_value(findings(&s, now())).unwrap()["generatedAt"].is_null());
}

#[test]
fn report_rows_of_users_no_longer_in_the_account_are_skipped_but_root_is_kept() {
    // 보고서는 4시간까지 묵은 것이 올 수 있어서, 그사이 지운 사용자의 줄이 남아 있을 수 있다
    let mut s = fixtures::snapshot();
    s.cred_report = Some(parse_credential_report(&csv()));
    let f = findings(&s, now());
    assert_eq!(targets(&f, InactiveUser), vec!["carol"]);
    assert_eq!(targets(&f, ConsoleNoMfa), vec!["bob"]);
    assert_eq!(targets(&f, OldAccessKey), vec!["alice", "bob", "carol"]);
    for kind in [RootAccessKey, RootNoMfa] {
        assert_eq!(targets(&f, kind), vec!["루트 계정"], "{kind:?}");
    }
    // 지운 사용자의 오래된 키도 알리지 않는다
    edit_row(&mut s, "gina", |r| r.key1_active = true);
    assert!(!targets(&findings(&s, now()), OldAccessKey).contains(&"gina"));
}

// ---- 루트 ----

#[test]
fn root_account_findings() {
    let f = run();
    for kind in [RootAccessKey, RootNoMfa] {
        let items = &group(&f, kind).items;
        assert_eq!(items.len(), 1, "{kind:?}");
        assert_eq!((items[0].target_arn.as_str(), items[0].target_name.as_str()), (ROOT_ARN, "루트 계정"));
        // 루트는 CLI나 빠른 조치로 고칠 수 없고 콘솔에서 한다
        assert_eq!((items[0].cli.clone(), items[0].fix.clone()), (None, None));
        assert!(items[0].detail.contains("콘솔"), "{}", items[0].detail);
    }
    assert!(group(&f, RootAccessKey).items[0].detail.contains("액세스 키"));
    assert!(group(&f, RootNoMfa).items[0].detail.contains("MFA"));
    // 루트는 사용자 점검에 섞이지 않는다
    for kind in [ConsoleNoMfa, OldAccessKey, UnusedAccessKey, InactiveUser] {
        assert!(!targets(&f, kind).contains(&"<root_account>"), "{kind:?}");
    }
}

#[test]
fn root_is_clean_with_mfa_and_no_active_keys() {
    let mut s = snap();
    edit_row(&mut s, "<root_account>", |r| {
        r.mfa_active = true;
        r.key1_active = false;
    });
    let f = findings(&s, now());
    assert!(group(&f, RootAccessKey).items.is_empty() && group(&f, RootNoMfa).items.is_empty());
    // 둘 다 켜져 있으면 개수를 알려 준다
    let mut s = snap();
    edit_row(&mut s, "<root_account>", |r| r.key2_active = true);
    assert!(group(&findings(&s, now()), RootAccessKey).items[0].detail.contains('2'));
}

// ---- 사용자 ----

#[test]
fn console_users_without_mfa() {
    let f = run();
    assert_eq!(targets(&f, ConsoleNoMfa), vec!["bob"]);
    let bob = item(&f, ConsoleNoMfa, "bob");
    assert_eq!(bob.target_arn, user_arn("bob"));
    assert_eq!(bob.cli.as_deref(), Some("aws iam list-mfa-devices --user-name bob"));
    assert_eq!(bob.fix, None);
    assert!(bob.detail.contains("MFA"));
}

#[test]
fn old_access_keys_are_active_keys_rotated_over_90_days_ago() {
    let f = run();
    assert_eq!(targets(&f, OldAccessKey), vec!["alice", "bob", "carol"]);
    let alice = item(&f, OldAccessKey, "alice");
    assert_eq!(alice.target_arn, user_arn("alice"));
    assert!(alice.detail.contains("200일"), "{}", alice.detail);
    assert!(alice.detail.contains("키 1번"), "{}", alice.detail);
    // 보고서에는 키 ID가 없으니 빠른 조치는 없고, CLI는 자리 표시자를 쓰고 키 탭을 안내한다
    assert_eq!(alice.fix, None);
    assert_eq!(
        alice.cli.as_deref(),
        Some("aws iam update-access-key --user-name alice --access-key-id <ACCESS_KEY_ID> --status Inactive")
    );
    assert!(alice.detail.contains("액세스 키 탭에서 바로 비활성화할 수 있어요"), "{}", alice.detail);
    assert!(item(&f, OldAccessKey, "bob").detail.contains("120일"));
    // 비활성 키(gina)는 오래돼도 세지 않는다
    assert!(!targets(&f, OldAccessKey).contains(&"gina"));
}

#[test]
fn old_key_threshold_is_more_than_90_days() {
    let key_age = |days: i64| {
        let mut s = snap();
        let rotated = ago(days);
        edit_row(&mut s, "alice", |r| r.key1_rotated = Some(rotated));
        targets(&findings(&s, now()), OldAccessKey).contains(&"alice")
    };
    assert!(!key_age(89) && !key_age(90));
    assert!(key_age(91));
}

#[test]
fn a_key_in_either_slot_is_checked_and_each_gets_its_own_item() {
    let mut s = snap();
    edit_row(&mut s, "alice", |r| {
        r.key2_active = true;
        r.key2_rotated = Some(ago(300));
        r.key2_last_used = Some(ago(2));
    });
    let f = findings(&s, now());
    let alice: Vec<&FindingItem> = group(&f, OldAccessKey).items.iter().filter(|i| i.target_name == "alice").collect();
    assert_eq!(alice.len(), 2);
    assert!(alice[0].detail.contains("키 1번") && alice[0].detail.contains("200일"));
    assert!(alice[1].detail.contains("키 2번") && alice[1].detail.contains("300일"));
}

#[test]
fn unused_access_keys_are_idle_over_90_days_or_never_used() {
    let f = run();
    assert_eq!(targets(&f, UnusedAccessKey), vec!["bob", "carol"]);
    let bob = item(&f, UnusedAccessKey, "bob");
    assert!(bob.detail.contains("한 번도"), "{}", bob.detail);
    assert!(bob.detail.contains("120일"), "{}", bob.detail);
    assert_eq!(bob.cli.as_deref(), Some("aws iam update-access-key --user-name bob --access-key-id <ACCESS_KEY_ID> --status Inactive"));
    assert_eq!(bob.fix, None);
    assert!(bob.detail.contains("액세스 키 탭에서 바로 비활성화할 수 있어요"));
    let carol = item(&f, UnusedAccessKey, "carol");
    assert!(carol.detail.contains("100일"), "{}", carol.detail);
    assert!(!carol.detail.contains("한 번도"));
    // 어제 쓴 키(alice)와 비활성 키(gina)는 아니다
    assert!(!targets(&f, UnusedAccessKey).contains(&"alice"));
    assert!(!targets(&f, UnusedAccessKey).contains(&"gina"));
}

#[test]
fn unused_key_thresholds() {
    let flagged = |edit: &dyn Fn(&mut CredRow)| {
        let mut s = snap();
        edit_row(&mut s, "alice", |r| edit(r));
        targets(&findings(&s, now()), UnusedAccessKey).contains(&"alice")
    };
    assert!(!flagged(&|r| r.key1_last_used = Some(ago(90))));
    assert!(flagged(&|r| r.key1_last_used = Some(ago(91))));
    // 한 번도 안 쓴 키는 만든 지 90일이 넘어야 한다
    assert!(!flagged(&|r| {
        r.key1_last_used = None;
        r.key1_rotated = Some(ago(90));
    }));
    assert!(flagged(&|r| {
        r.key1_last_used = None;
        r.key1_rotated = Some(ago(91));
    }));
    // 언제 만들었는지 모르면 판단하지 않는다
    assert!(!flagged(&|r| {
        r.key1_last_used = None;
        r.key1_rotated = None;
    }));
}

#[test]
fn inactive_users_have_used_nothing_for_over_90_days() {
    let f = run();
    assert_eq!(targets(&f, InactiveUser), vec!["carol", "dave", "erin"]);
    assert!(item(&f, InactiveUser, "carol").detail.contains("100일"), "{}", item(&f, InactiveUser, "carol").detail);
    assert!(item(&f, InactiveUser, "dave").detail.contains("기록이 없어요"));
    assert!(item(&f, InactiveUser, "dave").detail.contains("200일"));
    assert!(item(&f, InactiveUser, "erin").detail.contains("400일"));
    assert_eq!(item(&f, InactiveUser, "carol").target_arn, user_arn("carol"));
    assert_eq!(item(&f, InactiveUser, "dave").fix, None);
    // 만든 지 얼마 안 된 frank, 비활성 키라도 40일 전에 쓴 gina, 최근에 쓴 alice·bob은 아니다
    for name in ["frank", "gina", "alice", "bob"] {
        assert!(!targets(&f, InactiveUser).contains(&name), "{name}");
    }
}

#[test]
fn inactive_user_thresholds() {
    let flagged = |edit: &dyn Fn(&mut CredRow)| {
        let mut s = snap();
        edit_row(&mut s, "erin", |r| edit(r));
        targets(&findings(&s, now()), InactiveUser).contains(&"erin")
    };
    assert!(flagged(&|_| {}));
    // 만든 지 90일 이상이어야 한다
    assert!(!flagged(&|r| r.created_at = Some(ago(89))));
    assert!(flagged(&|r| r.created_at = Some(ago(90))));
    // 마지막 사용이 90일 넘게 지나야 한다
    assert!(!flagged(&|r| r.password_last_used = Some(ago(90))));
    assert!(flagged(&|r| r.password_last_used = Some(ago(91))));
    // 비밀번호와 키 중 하나라도 최근에 썼으면 아니다
    assert!(!flagged(&|r| {
        r.password_last_used = Some(ago(300));
        r.key2_last_used = Some(ago(5));
    }));
    // 만든 때를 모르면 판단하지 않는다
    assert!(!flagged(&|r| r.created_at = None));
}

// ---- 역할·정책 ----

#[test]
fn inactive_roles_skip_service_linked_sso_and_recently_used_roles() {
    let f = run();
    assert_eq!(targets(&f, InactiveRole), vec!["ci", "open", "vendor"]);
    let ci = item(&f, InactiveRole, "ci");
    assert_eq!(ci.target_arn, fixtures::CI);
    assert!(ci.detail.contains("사용 기록이 없어요"), "{}", ci.detail);
    assert_eq!(ci.cli.as_deref(), Some("aws iam get-role --role-name ci"));
    assert_eq!(ci.fix, None);
}

#[test]
fn inactive_role_thresholds() {
    let flagged = |edit: &dyn Fn(&mut RoleRec)| {
        let mut s = snap();
        edit_role(&mut s, "deploy", |r| edit(r));
        targets(&findings(&s, now()), InactiveRole).contains(&"deploy")
    };
    assert!(!flagged(&|_| {}));
    assert!(!flagged(&|r| r.last_used = Some(days_ago(90))));
    assert!(flagged(&|r| r.last_used = Some(days_ago(91))));
    let detail = {
        let mut s = snap();
        edit_role(&mut s, "deploy", |r| r.last_used = Some(days_ago(120)));
        item(&findings(&s, now()), InactiveRole, "deploy").detail.clone()
    };
    assert!(detail.contains("120일"), "{detail}");
    // 기록이 없으면 만든 지 90일 이상일 때만 센다
    assert!(!flagged(&|r| {
        r.last_used = None;
        r.created_at = Some(days_ago(89));
    }));
    assert!(flagged(&|r| {
        r.last_used = None;
        r.created_at = Some(days_ago(90));
    }));
}

#[test]
fn admin_and_privesc_principals_are_users_and_roles_only() {
    let f = run();
    assert_eq!(targets(&f, AdminPrincipal), vec!["alice"]);
    let alice = item(&f, AdminPrincipal, "alice");
    assert_eq!(alice.target_arn, ALICE);
    assert!(alice.detail.contains("AdministratorAccess"), "{}", alice.detail);
    assert!(alice.detail.contains("admins"), "{}", alice.detail);
    assert_eq!(alice.cli.as_deref(), Some("aws iam list-attached-user-policies --user-name alice"));
    // 관리자급이면 권한 상승 위험 목록에는 따로 넣지 않는다
    assert_eq!(targets(&f, PrivescPrincipal), vec!["deploy"]);
    let deploy = item(&f, PrivescPrincipal, "deploy");
    assert!(deploy.detail.contains("iam:PassRole"), "{}", deploy.detail);
    assert_eq!(deploy.cli.as_deref(), Some("aws iam list-attached-role-policies --role-name deploy"));
    assert_eq!(deploy.target_arn, fixtures::DEPLOY);
}

#[test]
fn a_role_with_a_wildcard_policy_is_admin_and_a_long_privesc_list_is_shortened() {
    let mut s = snap();
    let mut boss = fixtures::role("boss", "/", fixtures::trust(json!({ "Service": "ec2.amazonaws.com" }), "sts:AssumeRole", None));
    boss.attached = vec![ADMIN_POLICY.into()];
    s.roles.push(boss);
    let f = findings(&s, now());
    assert_eq!(targets(&f, AdminPrincipal), vec!["alice", "boss"]);
    assert_eq!(item(&f, AdminPrincipal, "boss").cli.as_deref(), Some("aws iam list-attached-role-policies --role-name boss"));
    assert!(item(&f, AdminPrincipal, "boss").detail.contains("AdministratorAccess"));

    let (s, arn) = fixtures::solo_user(json!([{ "Effect": "Allow", "Action": "iam:*", "Resource": "*" }]));
    let f = findings(&s, now());
    let detail = &item(&f, PrivescPrincipal, "u").detail;
    assert_eq!(item(&f, PrivescPrincipal, "u").target_arn, arn);
    assert!(detail.contains(" 외 "), "{detail}");
    assert!(detail.len() < 400, "{detail}");
}

#[test]
fn a_full_allow_except_a_few_resources_is_an_admin_principal_like_on_the_detail_screen() {
    // 리뷰 P6: 상세 화면은 관리자급이라고 하는데 점검은 권한 상승 위험이라고 하던 경우
    let mut s = snap();
    s.users[1].inline.push(fixtures::inline("almost-all", fixtures::policy(json!([{ "Effect": "Allow", "Action": "*", "NotResource": "arn:aws:s3:::secret/*" }]))));
    assert!(crate::iam::eval::evaluate(&s, BOB).unwrap().admin_like);
    let f = findings(&s, now());
    assert_eq!(targets(&f, AdminPrincipal), vec!["alice", "bob"]);
    assert!(item(&f, AdminPrincipal, "bob").detail.contains("almost-all"), "{}", item(&f, AdminPrincipal, "bob").detail);
    assert!(!targets(&f, PrivescPrincipal).contains(&"bob"));
}

#[test]
fn privesc_details_name_the_actions_in_the_catalog_order() {
    // 작업 이름은 위험 판정 문구가 아니라 작업마다 다시 판정해서 얻는다(문구가 바뀌어도 그대로다)
    let f = run();
    assert_eq!(item(&f, PrivescPrincipal, "deploy").detail, "권한 상승에 쓸 수 있는 작업을 모든 리소스에 조건 없이 허용해요: iam:PassRole");
    let (s, _) = fixtures::solo_user(json!([{ "Effect": "Allow", "Action": "iam:*", "Resource": "*" }]));
    let iam_actions = crate::iam::danger::PRIVESC_ACTIONS.iter().filter(|a| a.starts_with("iam:")).count();
    assert_eq!(
        item(&findings(&s, now()), PrivescPrincipal, "u").detail,
        format!("권한 상승에 쓸 수 있는 작업을 모든 리소스에 조건 없이 허용해요: iam:CreatePolicyVersion, iam:SetDefaultPolicyVersion, iam:PassRole 외 {}개", iam_actions - 3)
    );
    // 조건이 걸렸거나 모든 리소스에 열려 있지 않은 작업은 이름에 넣지 않는다
    let (s, _) = fixtures::solo_user(json!([
        { "Effect": "Allow", "Action": "iam:PassRole", "Resource": "*" },
        { "Effect": "Allow", "Action": "iam:CreateAccessKey", "Resource": "*", "Condition": { "Bool": { "aws:MultiFactorAuthPresent": "true" } } },
        { "Effect": "Allow", "Action": "sts:AssumeRole", "Resource": "arn:aws:iam::111111111111:role/app-*" }
    ]));
    assert_eq!(item(&findings(&s, now()), PrivescPrincipal, "u").detail, "권한 상승에 쓸 수 있는 작업을 모든 리소스에 조건 없이 허용해요: iam:PassRole");
}

#[test]
fn external_trust_lists_open_and_cross_account_roles() {
    let f = run();
    assert_eq!(targets(&f, ExternalTrust), vec!["open", "vendor"]);
    let open = item(&f, ExternalTrust, "open");
    assert!(open.detail.contains("누구나"), "{}", open.detail);
    assert_eq!(open.cli.as_deref(), Some("aws iam get-role --role-name open"));
    let vendor = item(&f, ExternalTrust, "vendor");
    assert!(vendor.detail.contains("999999999999"), "{}", vendor.detail);
    assert!(vendor.detail.contains("ExternalId 없이"), "{}", vendor.detail);
    assert_eq!(vendor.target_arn, fixtures::VENDOR);
    // 같은 계정의 OIDC·SAML 연동과 서비스 신뢰는 외부가 아니다
    for name in ["ci", "deploy", "AWSReservedSSO_Admin_abc", "AWSServiceRoleForX"] {
        assert!(!targets(&f, ExternalTrust).contains(&name), "{name}");
    }
}

#[test]
fn external_id_and_conditions_change_the_wording() {
    let mut s = snap();
    let guarded = fixtures::trust(
        json!({ "AWS": "arn:aws:iam::999999999999:root" }),
        "sts:AssumeRole",
        Some(json!({ "StringEquals": { "sts:ExternalId": "abc" } })),
    );
    edit_role(&mut s, "vendor", |r| r.trust = Some(fixtures::doc(guarded)));
    let conditional_open = fixtures::trust(json!({ "AWS": "*" }), "sts:AssumeRole", Some(json!({ "StringEquals": { "aws:PrincipalOrgID": "o-abc" } })));
    edit_role(&mut s, "open", |r| r.trust = Some(fixtures::doc(conditional_open)));
    let f = findings(&s, now());
    // 외부 계정이라는 사실은 그대로 보여 주고, 지켜 주는 조건이 있다는 것만 달라진다
    assert_eq!(targets(&f, ExternalTrust), vec!["open", "vendor"]);
    let vendor = item(&f, ExternalTrust, "vendor");
    assert!(vendor.detail.contains("ExternalId 조건이 있어요"), "{}", vendor.detail);
    assert!(!vendor.detail.contains("ExternalId 없이"));
    assert!(item(&f, ExternalTrust, "open").detail.contains("조건"), "{}", item(&f, ExternalTrust, "open").detail);
}

#[test]
fn external_trust_is_danger_only_when_someone_is_open_to_anyone_without_conditions() {
    let f = run();
    // `open`은 누구나 조건 없이 맡을 수 있다
    assert_eq!(group(&f, ExternalTrust).level, Level::Danger);
    let before: Vec<FindingItem> = group(&f, ExternalTrust).items.clone();

    // 누구나 열려 있어도 조건이 걸려 있으면 경고다. 항목 설명은 각자 그대로다
    let mut s = snap();
    let conditional_open = fixtures::trust(json!({ "AWS": "*" }), "sts:AssumeRole", Some(json!({ "StringEquals": { "aws:PrincipalOrgID": "o-abc" } })));
    edit_role(&mut s, "open", |r| r.trust = Some(fixtures::doc(conditional_open)));
    let f = findings(&s, now());
    assert_eq!(group(&f, ExternalTrust).level, Level::Warn);
    assert_eq!(targets(&f, ExternalTrust), vec!["open", "vendor"]);
    assert_eq!(item(&f, ExternalTrust, "vendor"), before.iter().find(|i| i.target_name == "vendor").unwrap());

    // 다른 계정에만 열려 있으면 경고다
    let mut s = snap();
    s.roles.retain(|r| r.name != "open");
    let f = findings(&s, now());
    assert_eq!(targets(&f, ExternalTrust), vec!["vendor"]);
    assert_eq!(group(&f, ExternalTrust).level, Level::Warn);
    // 다른 그룹의 심각도는 표 그대로다
    assert_eq!(group(&f, RootAccessKey).level, Level::Danger);
}

#[test]
fn unattached_customer_policies() {
    let f = run();
    assert_eq!(targets(&f, UnattachedPolicy), vec!["unused-policy"]);
    let policy = item(&f, UnattachedPolicy, "unused-policy");
    assert_eq!(policy.target_arn, fixtures::UNUSED_POLICY);
    assert_eq!(policy.cli.as_deref(), Some("aws iam list-entities-for-policy --policy-arn arn:aws:iam::111111111111:policy/unused-policy"));
    // AWS 관리형은 붙은 곳이 없어도 점검 대상이 아니다
    let mut s = snap();
    s.policies.get_mut(ADMIN_POLICY).unwrap().attachment_count = 0;
    assert_eq!(targets(&findings(&s, now()), UnattachedPolicy), vec!["unused-policy"]);
}

#[test]
fn an_unattached_policy_shows_its_description() {
    let mut s = snap();
    assert!(!item(&findings(&s, now()), UnattachedPolicy, "unused-policy").detail.contains("설명"));
    s.policies.get_mut(fixtures::UNUSED_POLICY).unwrap().description = Some("예전 배포용".into());
    assert!(item(&findings(&s, now()), UnattachedPolicy, "unused-policy").detail.ends_with(". 설명: 예전 배포용"));
}

#[test]
fn a_permissions_boundary_counts_as_a_place_the_policy_is_used() {
    // AWS의 AttachmentCount는 권한 경계로 쓰이는 것을 세지 않는다
    let mut s = snap();
    s.policies.get_mut(fixtures::CAROL_BOUNDARY).unwrap().attachment_count = 0;
    assert_eq!(targets(&findings(&s, now()), UnattachedPolicy), vec!["unused-policy"]);
    // 경계로 쓰는 사용자가 없어지면 붙은 곳 없는 정책이다
    s.users.iter_mut().find(|u| u.name == "carol").unwrap().boundary = None;
    assert_eq!(targets(&findings(&s, now()), UnattachedPolicy), vec!["carol-boundary", "unused-policy"]);
    // 역할의 권한 경계도 센다
    edit_role(&mut s, "ci", |r| r.boundary = Some(fixtures::CAROL_BOUNDARY.into()));
    assert_eq!(targets(&findings(&s, now()), UnattachedPolicy), vec!["unused-policy"]);
    // 그룹 등에 붙어 있으면(AttachmentCount > 0) 경계가 아니어도 붙은 곳이 있다
    edit_role(&mut s, "ci", |r| r.boundary = None);
    s.policies.get_mut(fixtures::CAROL_BOUNDARY).unwrap().attachment_count = 2;
    assert_eq!(targets(&findings(&s, now()), UnattachedPolicy), vec!["unused-policy"]);
}

#[test]
fn cli_arguments_are_shell_safe() {
    let mut s = snap();
    let hostile = "arn:aws:iam::111111111111:policy/$(touch pwned)/it's";
    let mut rec = s.policies[fixtures::UNUSED_POLICY].clone();
    rec.arn = hostile.to_string();
    rec.name = "it's".to_string();
    s.policies.insert(hostile.to_string(), rec);
    let f = findings(&s, now());
    let cli = item(&f, UnattachedPolicy, "it's").cli.clone().unwrap();
    assert_eq!(cli, "aws iam list-entities-for-policy --policy-arn 'arn:aws:iam::111111111111:policy/$(touch pwned)/it'\\''s'");
}

#[test]
fn items_are_sorted_by_name_ignoring_case() {
    let mut s = snap();
    for name in ["Zed", "amy", "Bea"] {
        let mut rec = s.policies[fixtures::UNUSED_POLICY].clone();
        rec.arn = format!("arn:aws:iam::111111111111:policy/{name}");
        rec.name = name.to_string();
        s.policies.insert(rec.arn.clone(), rec);
    }
    let names = targets(&findings(&s, now()), UnattachedPolicy).into_iter().map(str::to_owned).collect::<Vec<_>>();
    assert_eq!(names, vec!["amy", "Bea", "unused-policy", "Zed"]);
}

// ---- 배지와 마지막 사용 ----

#[test]
fn credential_badges_follow_the_same_rules() {
    let s = snap();
    assert_eq!(badge_kinds(&s, BOB), vec![BadgeKind::NoMfa, BadgeKind::OldKey, BadgeKind::UnusedKey]);
    assert_eq!(badge_kinds(&s, ALICE), vec![BadgeKind::OldKey]);
    assert_eq!(badge_kinds(&s, CAROL), vec![BadgeKind::OldKey, BadgeKind::UnusedKey, BadgeKind::Inactive]);
    assert_eq!(badge_kinds(&s, &user_arn("dave")), vec![BadgeKind::Inactive]);
    assert_eq!(badge_kinds(&s, &user_arn("erin")), vec![BadgeKind::Inactive]);
    assert!(badge_kinds(&s, &user_arn("frank")).is_empty());
    assert!(badge_kinds(&s, &user_arn("gina")).is_empty());
    assert!(badge_kinds(&s, "arn:aws:iam::111111111111:user/nobody").is_empty());
    assert!(credential_badges(&fixtures::snapshot(), BOB, now()).is_empty());
}

#[test]
fn credential_badge_labels_and_levels() {
    let badges = credential_badges(&snap(), CAROL, now());
    let shown: Vec<(&str, Level)> = badges.iter().map(|b| (b.label.as_str(), b.level)).collect();
    assert_eq!(shown, vec![("오래된 키", Level::Warn), ("안 쓰는 키", Level::Warn), ("안 쓰는 사용자", Level::Info)]);
    assert_eq!(credential_badges(&snap(), BOB, now())[0], Badge::new(BadgeKind::NoMfa, "MFA 없음", Level::Danger));
}

#[test]
fn user_last_used_is_the_latest_of_password_and_keys() {
    let s = snap();
    let iso_ago = |days: i64| Some(days_ago(days));
    assert_eq!(user_last_used(&s, ALICE), iso_ago(1));
    assert_eq!(user_last_used(&s, BOB), iso_ago(10));
    assert_eq!(user_last_used(&s, CAROL), iso_ago(100));
    // 비활성 키라도 마지막 사용은 기록이다
    assert_eq!(user_last_used(&s, &user_arn("gina")), iso_ago(40));
    assert_eq!(user_last_used(&s, &user_arn("dave")), None);
    assert_eq!(user_last_used(&s, &user_arn("erin")), None);
    assert_eq!(user_last_used(&s, "arn:aws:iam::111111111111:user/nobody"), None);
    assert_eq!(user_last_used(&fixtures::snapshot(), ALICE), None);
}
