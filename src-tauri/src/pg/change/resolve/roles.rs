//! 속성, 비밀번호, 삭제, 세션 끊기를 푸는 일

use super::*;

impl Resolver<'_> {
    pub(super) fn attributes(&mut self, role: &str, set: &AttributesSet) {
        if !(self.known_role(role) && self.changeable(role)) {
            return;
        }
        let Some(rec) = self.role_rec(role).cloned() else { return };
        let mut clauses = Vec::new();
        if rec.login != set.login {
            clauses.push(AttrClause::Login(set.login));
        }
        if rec.create_db != set.create_db {
            clauses.push(AttrClause::CreateDb(set.create_db));
        }
        if rec.create_role != set.create_role {
            clauses.push(AttrClause::CreateRole(set.create_role));
        }
        if rec.inherit != set.inherit {
            clauses.push(AttrClause::Inherit(set.inherit));
        }
        if rec.conn_limit != set.connection_limit {
            clauses.push(AttrClause::ConnectionLimit(set.connection_limit));
        }
        if !same_time(rec.valid_until.as_deref(), set.valid_until.as_deref()) {
            clauses.push(AttrClause::ValidUntil(set.valid_until.clone()));
        }
        if clauses.is_empty() {
            return;
        }
        if let Err(text) = self.rights().alter(&rec, &clauses) {
            self.block(text);
        }
        let statement = sql_text::alter_role(role, &clauses);
        self.push(Op::AlterRole { role: role.into(), clauses }, statement);
    }

    pub(super) fn password(&mut self, role: &str) {
        if !(self.known_role(role) && self.changeable(role)) {
            return;
        }
        let Some(rec) = self.role_rec(role).cloned() else { return };
        if role == self.cluster.login_user {
            // 서버는 허락하지만 저장된 로그인이 쓸 수 없게 되니 이 앱은 막는다
            self.block(OWN_PASSWORD);
        } else if let Err(text) = self.rights().alter(&rec, &[]) {
            self.block(text);
        }
        if let Err(text) = self.rights().password_commands() {
            self.block(text);
        }
        self.push(Op::SetPassword { role: role.into() }, sql_text::alter_role_password(role));
    }

    pub(super) fn drop_role(&mut self, role: &str) {
        if !(self.known_role(role) && self.changeable(role)) {
            return;
        }
        if role == self.cluster.login_user {
            self.block(DROP_LOGIN);
        }
        let Some(rec) = self.role_rec(role).cloned() else { return };
        if let Err(text) = self.rights().drop(&rec) {
            self.block(text);
        }
        if self.has_leftovers(role) {
            self.block(UNDO_AFTER_MORE);
        }
        self.push(Op::DropRole { role: role.into() }, sql_text::drop_role(role));
    }

    /// 역할이 실행 데이터베이스에 객체를 갖거나, ACL이나 기본 권한에 이름이 있거나, 구성원 관계의 부여자인가
    fn has_leftovers(&self, role: &str) -> bool {
        let named = |acl: &[AclEntry]| acl.iter().any(|e| e.grantor == role || e.grantee.as_deref() == Some(role));
        let database = self.cluster.databases.iter().find(|d| d.name == self.db.database);
        database.is_some_and(|d| d.owner == role || named(&d.acl))
            || self.db.owner == role
            || self.db.schemas.iter().any(|s| s.owner == role || named(&s.acl))
            || self.db.relations.iter().any(|r| r.owner == role || named(&r.acl))
            || self.db.functions.iter().any(|f| f.owner == role || named(&f.acl))
            || self.db.default_acls.iter().any(|d| d.creator == role || named(&d.acl))
            || self.cluster.members.iter().any(|m| m.grants.iter().any(|g| g.grantor == role))
    }

    pub(super) fn terminate(&mut self, pid: i32, role: &str, backend_start: Option<&str>) {
        let known = self.cluster.sessions.iter().find(|s| s.pid == pid).cloned();
        let known_start = known.as_ref().map(|s| s.backend_start.clone());
        // 스냅숏에 없는 세션도 변경이 말하는 역할로 판단한다(문장이 pid와 역할을 맞춰 보고 없으면 "세션이 이미 끝났어요")
        let session = known.unwrap_or_else(|| SessionRec {
            pid,
            role: Some(role.to_string()),
            database: None,
            client_addr: None,
            application_name: String::new(),
            state: None,
            backend_start: None,
            query_start: None,
            wait_event: None,
        });
        if let Err(text) = self.rights().terminate(&session, self.ctx.own_pids) {
            self.block(text);
        }
        // 문장의 시작 시각 확인: 스냅숏이 세션의 시작 시각을 알면 그 값, 세션은 보이는데 시작 시각이 안 보이면(권한이 없는 로그인) 확인을 뺀다.
        // 변경이 든 시각이 스냅숏의 것과 다르면 pid를 이어받은 다른 세션이니 그 시각 그대로 둬서 문장이 "세션이 이미 끝났어요"로 실패하게 한다
        let guard_start = match &known_start {
            Some(Some(seen)) => match backend_start {
                Some(wanted) if !same_time(Some(seen), Some(wanted)) => Some(wanted.to_string()),
                _ => Some(seen.clone()),
            },
            Some(None) => None,
            None => backend_start.map(str::to_string),
        };
        let statement = sql_text::terminate(pid, role, guard_start.as_deref());
        self.push(Op::Terminate { pid, role: role.into(), backend_start: guard_start }, statement);
    }

}

/// 같은 시각인가. 초 아래는 서버가 읽어 줄 때 버려지니 초까지만 본다
fn same_time(snapshot: Option<&str>, wanted: Option<&str>) -> bool {
    match (snapshot, wanted) {
        (None, None) => true,
        (Some(a), Some(b)) => parse_iso(a).zip(parse_iso(b)).map_or(a == b, |(a, b)| a == b),
        _ => false,
    }
}
