//! 로그인한 DB 사용자가 무엇을 할 수 있나(순수 함수). PostgreSQL 14~16의 규칙을 서버 소스대로 옮겼다:
//! `user.c`(`CreateRole`, `AlterRole`, `DropRole`, `check_role_membership_authorization`, `check_role_grantor`),
//! `acl.c`(`select_best_grantor`, `select_best_admin`, `roles_is_member_of`, `is_admin_of_role`, `has_privs_of_role`),
//! `aclchk.c`(`ExecAlterDefaultPrivilegesStmt`), `signalfuncs.c`(`pg_signal_backend`).
//! 막힘의 글은 전역 제약의 문구 그대로다. 미리보기가 거짓말을 하지 않게, 서버가 막을 일은 여기서도 막는다.

use std::collections::BTreeSet;

use super::sql_text::AttrClause;
use crate::pg::eval::{Ctx, Eval, Obj};
use crate::pg::model::{ClusterSnapshot, DbSnapshot, MemberRec, Privilege, RoleRec, SessionRec, MEMBERSHIP_OPTIONS_SINCE};
use crate::pg::summary::RDS_SUPERUSER;

const RDS_PASSWORD: &str = "rds_password";
const PG_SIGNAL_BACKEND: &str = "pg_signal_backend";
const PG_DATABASE_OWNER: &str = "pg_database_owner";

pub(super) const OWN_SESSION: &str = "이 앱의 세션은 끊을 수 없어요";
pub(super) const TERMINATE_RIGHTS: &str = "이 세션을 끊을 권한이 없어요. pg_signal_backend 권한이 있어야 해요";
pub(super) const CREATE_RIGHTS: &str = "역할을 만들 권한이 없어요. CREATEROLE이 있어야 해요";
pub(super) const CREATEDB_RIGHTS: &str = "CREATEDB를 주거나 빼려면 로그인한 역할에도 CREATEDB가 있어야 해요";
pub(super) const PASSWORD_RESTRICTED: &str = "비밀번호나 만료일을 바꾸려면 로그인한 역할이 rds_password 구성원이어야 해요(rds.restrict_password_commands가 켜져 있어요)";
/// 알터·삭제 권한 글의 둘째 문장. 삭제 글(`drop_text`)이 같은 요구를 쓴다
const ALTER_REQUIREMENT_BEFORE: &str = "CREATEROLE이 있어야 해요";
const ALTER_REQUIREMENT_FROM: &str = "CREATEROLE과 이 역할에 대한 ADMIN OPTION이 있어야 해요";

fn requirement(version: i32) -> &'static str {
    if version >= MEMBERSHIP_OPTIONS_SINCE {
        ALTER_REQUIREMENT_FROM
    } else {
        ALTER_REQUIREMENT_BEFORE
    }
}

pub(super) fn superuser_session_text(role: &str) -> String {
    format!("superuser 세션은 끊을 수 없어요: {role}")
}

pub(super) fn superuser_target_text(role: &str) -> String {
    format!("superuser나 REPLICATION 역할은 바꿀 수 없어요: {role}")
}

fn alter_text(role: &str, version: i32) -> String {
    format!("{role} 역할을 바꿀 권한이 없어요. {}", requirement(version))
}

fn drop_text(role: &str, version: i32) -> String {
    format!("{role} 역할을 삭제할 권한이 없어요. {}", requirement(version))
}

fn membership_text(group: &str, version: i32) -> String {
    if version >= MEMBERSHIP_OPTIONS_SINCE {
        format!("{group} 역할의 구성원을 바꿀 권한이 없어요. {group} 역할에 대한 ADMIN OPTION이 있어야 해요")
    } else {
        format!("{group} 역할의 구성원을 바꿀 권한이 없어요. CREATEROLE이나 {group} 역할에 대한 ADMIN OPTION이 있어야 해요")
    }
}

fn admin_not_inherited_text(group: &str) -> String {
    format!("{group} 역할의 구성원을 바꿀 수 없어요. ADMIN OPTION을 가진 역할의 권한을 물려받아야 해요")
}

fn defaults_text(creator: &str, version: i32) -> String {
    if version >= MEMBERSHIP_OPTIONS_SINCE {
        format!("{creator} 역할의 기본 권한을 바꿀 수 없어요. 로그인한 역할이 {creator} 역할의 권한을 물려받아야 해요")
    } else {
        format!("{creator} 역할의 기본 권한을 바꿀 수 없어요. 로그인한 역할이 {creator} 역할의 구성원이어야 해요")
    }
}

/// 구성원 관계를 거둘 때 어느 부여를 거둘 수 있나
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Revocations {
    /// 거둘 부여의 부여자들(`GRANTED BY`로 이름을 댄다). 160000 전에는 부여자가 없어서 빈 문자열 하나가 "그냥 `REVOKE`"를 뜻한다
    pub rows: Vec<String>,
    /// 거둘 수 없어서 남는 부여의 부여자들
    pub remaining: Vec<String>,
}

/// 로그인한 DB 사용자의 처지. 스냅숏 한 쌍에서 `Eval` 하나를 만들어 쓴다
pub struct Rights<'a> {
    cluster: &'a ClusterSnapshot,
    login: &'a str,
    record: Option<&'a RoleRec>,
    eval: Eval<'a>,
}

impl<'a> Rights<'a> {
    /// 로그인한 DB 사용자는 `cluster.login_user`다
    pub fn new(cluster: &'a ClusterSnapshot, db: &'a DbSnapshot) -> Rights<'a> {
        let login = cluster.login_user.as_str();
        Rights { cluster, login, record: cluster.roles.iter().find(|r| r.name == login), eval: Eval::new(&Ctx { cluster, db }) }
    }

    pub fn login(&self) -> &'a str {
        self.login
    }

    fn version(&self) -> i32 {
        self.cluster.version_num
    }

    fn since_16(&self) -> bool {
        self.version() >= MEMBERSHIP_OPTIONS_SINCE
    }

    /// 로그인한 역할 자신의 속성(속성은 상속되지 않는다)
    fn own(&self, pick: impl Fn(&RoleRec) -> bool) -> bool {
        self.record.is_some_and(pick)
    }

    pub fn superuser(&self) -> bool {
        self.own(|r| r.superuser)
    }

    /// `has_privs_of_role`: 자기 자신, superuser, 또는 상속으로 닿는 역할
    pub fn has_privs_of(&self, role: &str) -> bool {
        self.superuser() || self.login == role || self.eval.privilege_order(self.login).iter().any(|r| r.role == role)
    }

    /// `is_member_of_role`: 상속하는지와 상관없이 구성원 관계가 어떻게든 이어진다
    pub fn member_of(&self, role: &str) -> bool {
        self.superuser() || self.login == role || self.eval.member_closure(self.login).iter().any(|r| r == role)
    }

    /// 1단계의 `canManage`: rds_superuser의 권한을 물려받거나, 자기 CREATEROLE이 있거나, superuser다
    pub fn can_manage(&self) -> bool {
        self.superuser() || self.own(|r| r.create_role) || self.eval.privilege_order(self.login).iter().any(|r| r.role == RDS_SUPERUSER)
    }

    /// `is_admin_of_role`: 로그인한 역할이나 그 구성원 관계 사슬(상속하든 말든) 위의 역할이 `group`에 ADMIN OPTION을 가졌다. 그룹 자신은 세지 않는다
    fn admin_reachable(&self, group: &str) -> bool {
        self.login != group && self.eval.member_closure(self.login).iter().any(|r| r != group && self.eval.membership_admin(r, group))
    }

    fn role_rec(&self, name: &str) -> Option<&'a RoleRec> {
        self.cluster.roles.iter().find(|r| r.name == name)
    }

    pub fn create_role(&self) -> Result<(), String> {
        if self.superuser() || self.own(|r| r.create_role) {
            Ok(())
        } else {
            Err(CREATE_RIGHTS.to_string())
        }
    }

    /// 비밀번호와 만료일을 바꾸는 명령. `rds.restrict_password_commands`가 켜져 있으면 `rds_password`의 구성원(어떤 사슬이든)이어야 한다
    pub fn password_commands(&self) -> Result<(), String> {
        if !self.cluster.restrict_password_commands || self.member_of(RDS_PASSWORD) {
            Ok(())
        } else {
            Err(PASSWORD_RESTRICTED.to_string())
        }
    }

    /// 역할을 바꾸는 권한(`AlterRole`). `clauses`가 비어 있어도 같은 판단이다(비밀번호 재설정)
    pub fn alter(&self, role: &RoleRec, clauses: &[AttrClause]) -> Result<(), String> {
        if self.superuser() {
            return Ok(());
        }
        // 서버는 160000 전에는 둘 다 superuser를 요구하고 160000부터는 superuser 대상만 막는다. 문서의 규칙은 REPLICATION이 아닌 역할만이라 그쪽을 따른다
        if role.superuser || role.replication {
            return Err(superuser_target_text(&role.name));
        }
        if !self.own(|r| r.create_role) || (self.since_16() && !self.admin_reachable(&role.name)) {
            return Err(alter_text(&role.name, self.version()));
        }
        if self.since_16() && clauses.iter().any(|c| matches!(c, AttrClause::CreateDb(_))) && !self.own(|r| r.create_db) {
            return Err(CREATEDB_RIGHTS.to_string());
        }
        if clauses.iter().any(|c| matches!(c, AttrClause::ValidUntil(_))) {
            self.password_commands()?;
        }
        Ok(())
    }

    /// 역할을 지우는 권한(`DropRole`)
    pub fn drop(&self, role: &RoleRec) -> Result<(), String> {
        if self.superuser() {
            return Ok(());
        }
        if role.superuser || role.replication {
            return Err(superuser_target_text(&role.name));
        }
        if !self.own(|r| r.create_role) || (self.since_16() && !self.admin_reachable(&role.name)) {
            return Err(drop_text(&role.name, self.version()));
        }
        Ok(())
    }

    /// `group`의 구성원 관계를 바꿀 권한(`check_role_membership_authorization`): superuser 그룹은 superuser가, 그 밖에는 superuser이거나
    /// 구성원 관계 사슬(상속하든 말든) 어디에선가 ADMIN OPTION이 닿아야 한다. 160000 전에는 로그인한 역할 자신의 CREATEROLE도 된다.
    /// 부여자를 찾지는 않는다: 거두는 쪽은 `GRANTED BY`로 부여자를 직접 대서 이것만 통과하면 된다
    pub fn membership_authorization(&self, group: &str) -> Result<(), String> {
        let version = self.version();
        if group == PG_DATABASE_OWNER {
            return Err(membership_text(group, version));
        }
        if self.role_rec(group).is_some_and(|g| g.superuser) && !self.superuser() {
            return Err(superuser_target_text(group));
        }
        if self.superuser() || self.admin_reachable(group) || (!self.since_16() && self.own(|r| r.create_role)) {
            Ok(())
        } else {
            Err(membership_text(group, version))
        }
    }

    /// 구성원 관계를 줄 권한과, 서버가 부여자로 적는 역할(`check_role_grantor`).
    /// 160000부터는 superuser면 부트스트랩 superuser, 아니면 자기 부여에 ADMIN이 있으면 자기 자신, 아니면 상속으로 닿는 첫 ADMIN 역할이다.
    /// 160000 전에는 부여자가 늘 로그인한 역할이다
    pub fn membership_grantor(&self, group: &str) -> Result<String, String> {
        self.membership_authorization(group)?;
        if !self.since_16() {
            return Ok(self.login.to_string());
        }
        if self.superuser() {
            return Ok(self.cluster.bootstrap_superuser.clone());
        }
        // 서버가 부여자를 찾는 길(`select_best_admin`)은 상속하는 사슬만 따른다. 상속하지 않는 관계로만 ADMIN에 닿으면 허락은 되는데 부여자가 없다
        self.eval
            .privilege_order(self.login)
            .into_iter()
            .map(|r| r.role)
            .find(|r| r != group && self.eval.membership_admin(r, group))
            .ok_or_else(|| admin_not_inherited_text(group))
    }

    /// `member`를 `group`에서 거둘 때 어느 부여를 거둘 수 있나
    // QB5(안전한 삭제)가 쓴다. 그때까지는 시험 빌드에서만 컴파일한다(`allow`를 쓰지 않으려고)
#[cfg(test)]
    pub fn membership_revocations(&self, group: &str, member: &str) -> Revocations {
        self.revocations(group, member, false)
    }

    /// `admin_only`면 ADMIN OPTION이 있는 부여만 대상이다(ADMIN이 없는 부여에서 ADMIN을 거두면 서버가 경고만 한다)
    pub(super) fn revocations(&self, group: &str, member: &str, admin_only: bool) -> Revocations {
        let pair: Option<&MemberRec> = self.cluster.members.iter().find(|m| m.group == group && m.member == member);
        let Some(pair) = pair else { return Revocations { rows: Vec::new(), remaining: Vec::new() } };
        if !self.since_16() {
            let rows = if !admin_only || pair.admin { vec![String::new()] } else { Vec::new() };
            return Revocations { rows, remaining: Vec::new() };
        }
        let (mut rows, mut remaining) = (BTreeSet::new(), BTreeSet::new());
        for grant in pair.grants.iter().filter(|g| !admin_only || g.admin) {
            if self.has_privs_of(&grant.grantor) {
                rows.insert(grant.grantor.clone());
            } else {
                remaining.insert(grant.grantor.clone());
            }
        }
        Revocations { rows: rows.into_iter().collect(), remaining: remaining.into_iter().collect() }
    }

    /// `creator`가 만드는 객체의 기본 권한을 바꿀 권한. 160000 전에는 구성원이면 된다(NOINHERIT도), 160000부터는 권한을 물려받아야 한다
    pub fn defaults_for(&self, creator: &str) -> Result<(), String> {
        let ok = if self.since_16() { self.has_privs_of(creator) } else { self.member_of(creator) };
        if ok {
            Ok(())
        } else {
            Err(defaults_text(creator, self.version()))
        }
    }

    /// 객체 권한을 주거나 거둘 때 서버가 부여자로 적는 역할(`select_best_grantor`). 줄 수 없으면 None.
    /// 소유자이거나 superuser면 소유자다. 아니면 로그인한 역할과 그 역할이 상속하는 역할을 너비 우선(같은 깊이는 OID순)으로 보며,
    /// 물으려는 권한 모두의 GRANT OPTION을 ACL에 직접 가진 첫 역할이 부여자다. 소유자는 모든 GRANT OPTION을 가진 것으로 친다.
    /// 일부만 가진 역할은 서버가 경고(01007)와 함께 가장 많이 가진 역할로 돌리므로 여기서는 줄 수 없는 것으로 본다
    pub fn object_grantor(&self, obj: Obj, privileges: &[Privilege]) -> Option<String> {
        let owner = obj.owner();
        if self.login == owner || self.superuser() {
            return Some(owner.to_string());
        }
        let acl = obj.acl();
        self.eval
            .privilege_order(self.login)
            .into_iter()
            .map(|r| r.role)
            .find(|role| role == owner || privileges.iter().all(|&p| acl.iter().any(|e| e.grantee.as_deref() == Some(role) && e.privilege == p && e.grantable)))
    }

    /// 세션을 끊을 권한(`pg_signal_backend`)
    pub fn terminate(&self, session: &SessionRec, own_pids: &[i32]) -> Result<(), String> {
        if own_pids.contains(&session.pid) {
            return Err(OWN_SESSION.to_string());
        }
        if self.superuser() {
            return Ok(());
        }
        // 역할이 없는 백엔드도 superuser가 아니면 못 끊는다
        let target = session.role.as_deref();
        if target.is_none_or(|role| self.role_rec(role).is_some_and(|r| r.superuser)) {
            return Err(superuser_session_text(target.unwrap_or("(알 수 없음)")));
        }
        if target.is_some_and(|role| self.has_privs_of(role)) || self.has_privs_of(PG_SIGNAL_BACKEND) {
            Ok(())
        } else {
            Err(TERMINATE_RIGHTS.to_string())
        }
    }
}

#[cfg(test)]
mod tests;
