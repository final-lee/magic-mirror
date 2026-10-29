use super::*;
use crate::pg::change::after::apply;
use crate::pg::change::resolve::{resolve, ResolveCtx};
use crate::pg::change::support::*;
use crate::pg::fixtures::*;

#[test]
fn the_same_state_is_equal_whatever_the_order_oid_or_read_time() {
    let s = admin(PG16);
    let mut other = s.cluster.clone();
    other.roles.reverse();
    other.members.reverse();
    other.fetched_at = "2030-01-01T00:00:00Z".into();
    other.roles.iter_mut().for_each(|r| r.oid += 1000);
    assert_eq!(digest(&s.cluster, &s.db), digest(&other, &s.db));
}

#[test]
fn an_applied_change_differs_and_its_prediction_matches_itself() {
    let s = admin_of(PG16, &["app_read"]);
    let change = membership("app_read", "carol", true, false);
    let resolved = resolve(&ResolveCtx { cluster: &s.cluster, db: &s.db, own_pids: &[], read_replica: false }, &change);
    let (mut cluster, mut db) = (s.cluster.clone(), s.db.clone());
    apply(&mut cluster, &mut db, &resolved.ops);
    assert_ne!(digest(&s.cluster, &s.db), digest(&cluster, &db));
    assert_eq!(digest(&cluster, &db), digest(&cluster.clone(), &db.clone()));
}

#[test]
fn before_160000_the_grantor_of_a_membership_is_not_compared() {
    let s = admin(PG15);
    let mut other = s.cluster.clone();
    for m in &mut other.members {
        m.grants.iter_mut().for_each(|g| g.grantor = "someone".into());
    }
    assert_eq!(digest(&s.cluster, &s.db), digest(&other, &s.db));
    let s16 = admin(PG16);
    let mut other16 = s16.cluster.clone();
    for m in &mut other16.members {
        m.grants.iter_mut().for_each(|g| g.grantor = "someone".into());
    }
    assert_ne!(digest(&s16.cluster, &s16.db), digest(&other16, &s16.db));
}
