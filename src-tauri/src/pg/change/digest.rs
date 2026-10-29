//! 스냅숏에서 변경이 건드릴 수 있는 부분만 뽑아 순서·OID·읽은 시각에 상관없이 비교할 수 있는 줄들로 바꾼다(순수 함수).
//! `COMMIT`의 답을 못 받았을 때 다시 읽은 스냅숏이 예측한 "적용한 뒤"와 같은지 가리는 데 쓴다.
//! 세션과 역할별 설정은 변경이 건드리지 않아서 뺀다. 160000 전에는 구성원 관계의 부여자가 정보일 뿐이고 예측과 다를 수 있어서 뺀다.

use std::collections::BTreeSet;

use crate::pg::model::{AclEntry, ClusterSnapshot, DbSnapshot, MEMBERSHIP_OPTIONS_SINCE};

fn acl_lines(lines: &mut BTreeSet<String>, label: &str, owner: &str, acl: &[AclEntry]) {
    lines.insert(format!("{label} owner {owner}"));
    for e in acl {
        lines.insert(format!("{label} acl {} -> {} {} grantable={}", e.grantor, e.grantee.as_deref().unwrap_or("PUBLIC"), e.privilege.as_str(), e.grantable));
    }
}

pub fn digest(cluster: &ClusterSnapshot, db: &DbSnapshot) -> BTreeSet<String> {
    let mut lines = BTreeSet::new();
    for r in &cluster.roles {
        lines.insert(format!(
            "role {} login={} inherit={} createrole={} createdb={} repl={} bypassrls={} super={} limit={} until={:?}",
            r.name, r.login, r.inherit, r.create_role, r.create_db, r.replication, r.bypass_rls, r.superuser, r.conn_limit, r.valid_until
        ));
    }
    let grantors = cluster.version_num >= MEMBERSHIP_OPTIONS_SINCE;
    for m in &cluster.members {
        lines.insert(format!("member {} -> {} admin={} inherit={:?} set={:?}", m.member, m.group, m.admin, m.inherit, m.set));
        for g in &m.grants {
            let by = if grantors { g.grantor.as_str() } else { "-" };
            lines.insert(format!("grant {} -> {} by {by} admin={} inherit={:?} set={:?}", m.member, m.group, g.admin, g.inherit, g.set));
        }
    }
    for d in &cluster.databases {
        acl_lines(&mut lines, &format!("database {}", d.name), &d.owner, &d.acl);
    }
    for s in &db.schemas {
        acl_lines(&mut lines, &format!("schema {}", s.name), &s.owner, &s.acl);
    }
    for r in &db.relations {
        acl_lines(&mut lines, &format!("relation {}.{} {:?}", r.schema, r.name, r.kind), &r.owner, &r.acl);
    }
    for f in &db.functions {
        acl_lines(&mut lines, &format!("function {}.{}({})", f.schema, f.name, f.signature), &f.owner, &f.acl);
    }
    for d in &db.default_acls {
        lines.insert(format!("default record {} {:?} {:?}", d.creator, d.schema, d.obj_type));
        acl_lines(&mut lines, &format!("default {} {:?} {:?}", d.creator, d.schema, d.obj_type), "-", &d.acl);
    }
    lines
}

#[cfg(test)]
mod tests;
