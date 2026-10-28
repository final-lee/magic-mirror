//! 시험 도구 자체의 시험: 도구가 만드는 값이 서버가 주는 모양과 서로 맞아야 그것으로 하는 시험을 믿을 수 있다.

use super::*;

fn oid_of(cluster: &ClusterSnapshot, name: &str) -> u32 {
    cluster.roles.iter().find(|r| r.name == name).unwrap_or_else(|| panic!("{name} 역할이 없어요")).oid
}

#[test]
fn a_bare_role_has_no_oid_until_a_cluster_numbers_it() {
    assert_eq!(role("alice").oid, 0);
    assert_eq!(login("alice").oid, 0);
}

#[test]
fn a_cluster_gives_every_role_a_different_oid_in_name_order() {
    for version in [PG14, PG16] {
        let cluster = app_scene(version).cluster;
        let oids: Vec<u32> = cluster.roles.iter().map(|r| r.oid).collect();
        assert_eq!(oids, [16_384, 16_385, 16_386, 16_387, 16_388, 16_389], "alice, app_owner, app_read, app_write, bob, carol");
        assert!(cluster.roles.windows(2).all(|pair| pair[0].name < pair[1].name && pair[0].oid < pair[1].oid));
    }
}

#[test]
fn the_oid_follows_the_name_and_not_the_order_the_roles_were_given_in() {
    let cluster = cluster(PG16, vec![role("zed"), role("alpha"), role("mid")], vec![], vec![]);
    assert!(oid_of(&cluster, "alpha") < oid_of(&cluster, "mid") && oid_of(&cluster, "mid") < oid_of(&cluster, "zed"));
    let all: std::collections::HashSet<u32> = cluster.roles.iter().map(|r| r.oid).collect();
    assert_eq!(all.len(), 3, "OID는 서로 달라야 해요");
    // 역할 목록의 순서는 건드리지 않는다
    assert_eq!(cluster.roles.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["zed", "alpha", "mid"]);
}

#[test]
fn system_roles_get_the_lower_oids_like_on_a_server_and_each_group_follows_name_order() {
    let names = ["zed", "rds_superuser", "alpha", "pg_read_all_data", "rdsadmin", "pg_monitor", "rds_iam"];
    let cluster = cluster(PG16, names.iter().map(|name| role(name)).collect(), vec![], vec![]);
    // 시스템 역할(`pg_`, `rds_`, `rdsadmin` …)이 먼저 10000부터 이름순이고, 나머지는 16384부터 이름순이다. 역할 목록의 순서는 그대로다
    let oids: Vec<(&str, u32)> = cluster.roles.iter().map(|r| (r.name.as_str(), r.oid)).collect();
    assert_eq!(
        oids,
        [("zed", 16_385), ("rds_superuser", 10_003), ("alpha", 16_384), ("pg_read_all_data", 10_001), ("rdsadmin", 10_004), ("pg_monitor", 10_000), ("rds_iam", 10_002)]
    );
    // 서버처럼 시스템 역할은 어떤 사용자 역할보다 OID가 작고, 서버가 직접 만든 역할의 OID(16384 아래)에 든다
    let (system, other): (Vec<_>, Vec<_>) = cluster.roles.iter().partition(|r| is_system_role(&r.name));
    assert_eq!((system.len(), other.len()), (5, 2));
    assert!(system.iter().all(|s| s.oid < 16_384 && other.iter().all(|o| s.oid < o.oid)));
}

#[test]
fn a_cluster_with_no_roles_is_fine() {
    assert!(cluster(PG16, vec![], vec![], vec![]).roles.is_empty());
}

#[test]
fn the_new_cluster_fields_have_the_values_of_an_rds_cluster_with_nothing_set() {
    let cluster = cluster(PG16, vec![], vec![], vec![]);
    assert_eq!(cluster.bootstrap_superuser, "rdsadmin");
    assert_eq!(cluster.bootstrap_superuser, BOOTSTRAP);
    assert_eq!(cluster.createrole_self_grant, "");
    assert!(!cluster.restrict_password_commands);
}

#[test]
fn a_member_without_options_has_one_grant_without_options() {
    let m = member("alice", "app_write");
    assert_eq!((m.admin, m.inherit, m.set), (false, None, None));
    assert_eq!(m.grants, [MemberGrant { grantor: BOOTSTRAP.into(), admin: false, inherit: None, set: None }]);
}

#[test]
fn a_member_with_options_has_one_grant_with_the_same_options() {
    let m = member_with("alice", "app_write", false, true);
    assert_eq!((m.admin, m.inherit, m.set), (false, Some(false), Some(true)));
    assert_eq!(m.grants, [MemberGrant { grantor: BOOTSTRAP.into(), admin: false, inherit: Some(false), set: Some(true) }]);
    // 서버가 옵션 하나만 비워 주는 모양도 만든다
    let half = member_options("alice", "app_write", Some(true), None);
    assert_eq!((half.inherit, half.set), (Some(true), None));
    assert_eq!(half.grants[0].inherit, Some(true));
    assert_eq!(half.grants[0].set, None);
}

#[test]
fn the_merged_options_of_every_scene_membership_equal_its_only_grant() {
    for version in [PG15, PG16] {
        for m in app_scene(version).cluster.members {
            assert_eq!(m.grants.len(), 1, "{} → {}", m.member, m.group);
            let grant = &m.grants[0];
            assert_eq!((m.admin, m.inherit, m.set), (grant.admin, grant.inherit, grant.set), "{} → {}", m.member, m.group);
            assert_eq!(grant.grantor, BOOTSTRAP);
        }
    }
}
