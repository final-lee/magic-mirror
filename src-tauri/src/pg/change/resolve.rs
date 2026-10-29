//! 변경 하나가 연산(`Op`), 문장, 막힘의 글이 되는 길(순수 함수). `resolve`는 실패하지 않는다: 문제는 `blocks`에 담고 가능한 만큼 연산과 문장을 계속 만든다.
//! 그래서 막힌 변경도 미리보기가 SQL을 보여 줄 수 있다.
//!
//! 연산은 복제한 스냅숏에 `after::apply`로 차례로 적용하며 만든다. 그래서 한 변경 안의 뒷단계(방금 만든 그룹에 넣기, 방금 준 권한 다시 보기)가
//! 앞단계의 결과 위에서 판단된다. 권한 판단은 `Rights`가 그 스냅숏으로 한다.

use std::collections::BTreeSet;

use super::after;
use super::model::{AttributesSet, GrantItem, GrantTarget, PgChange, PresetChoice, PresetKind};
use super::rights::Rights;
use super::sql_text::{self, privilege_list, AttrClause, OnClause, Statement};
use super::text::target_label;
use crate::iam::clock::parse_iso;
use crate::pg::eval::{offers, Ctx, Eval, Obj, PrivKind};
use crate::pg::model::{MEMBERSHIP_OPTIONS_SINCE, AclEntry, ClusterSnapshot, DbSnapshot, DefaultObjType, MemberRec, Privilege, RelKind, RoleRec, SessionRec};
use crate::pg::summary::{is_system_role, RDS_SUPERUSER};

/// 구성원을 넣고 뺄 수 있는 시스템 그룹
const OPEN_SYSTEM_GROUPS: [&str; 11] = [
    "rds_superuser",
    "rds_iam",
    "rds_password",
    "rds_replication",
    "pg_read_all_data",
    "pg_write_all_data",
    "pg_monitor",
    "pg_read_all_settings",
    "pg_read_all_stats",
    "pg_stat_scan_tables",
    "pg_signal_backend",
];
/// 역할 이름으로 쓸 수 없는 예약어(대소문자 구분 없이)
const RESERVED_NAMES: [&str; 5] = ["public", "none", "current_role", "current_user", "session_user"];
const READ_REPLICA: &str = "읽기 전용 복제본이라 바꿀 수 없어요";
const BAD_NAME: &str = "역할 이름이 올바르지 않아요. 1~63바이트이고 pg_로 시작하지 않아야 해요";
const RESERVED_NAME: &str = "이 이름은 PostgreSQL이 예약해 둬서 쓸 수 없어요";
const PUBLIC_ROLE: &str = "PUBLIC이라는 이름의 역할은 이 앱에서 바꿀 수 없어요";
const NO_PRIVILEGES: &str = "권한을 하나 이상 골라야 해요";
const NO_ITEMS: &str = "바꿀 객체가 없어요";
const SCHEMAS_WITH_SCHEMA: &str = "스키마의 기본 권한은 모든 스키마에만 줄 수 있어요";
const UNDO_AFTER_MORE: &str = "만든 뒤에 객체나 권한이 생겨서 되돌릴 수 없어요";
const OWN_PASSWORD: &str = "지금 로그인한 역할이라 여기서 비밀번호를 바꿀 수 없어요";
const DROP_LOGIN: &str = "앱이 로그인한 역할은 삭제할 수 없어요";
const TRUNCATED: &str = "객체가 많아 일부만 읽었어요. 영향에 없는 객체에도 적용돼요";

fn system_role_text(role: &str) -> String {
    format!("시스템 역할이라 바꿀 수 없어요: {role}")
}

fn unknown_role_text(role: &str) -> String {
    format!("역할을 찾을 수 없어요: {role}")
}

// ───────────────────────── 연산 ─────────────────────────

/// 서버에서 일어나는 일 하나. `blocks`가 비어 있으면 문장 하나가 연산 하나와 짝이다(`Resolved::ops`와 `statements`는 같은 순서다).
/// 막힌 변경은 미리보기에 SQL을 보이려고 연산 없는 문장을 둘 수 있으니(새 역할의 이름이 막힌 때) 짝지어 쓰지 않는다
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Op {
    CreateRole { name: String, login: bool, connection_limit: i32, valid_until: Option<String>, password: bool },
    AlterRole { role: String, clauses: Vec<AttrClause> },
    SetPassword { role: String },
    DropRole { role: String },
    /// `grantor`는 서버가 부여자로 적는 역할이다(`Rights::membership_grantor`)
    GrantRole { group: String, member: String, admin: bool, grantor: String },
    /// 160000부터는 부여 하나를 `GRANTED BY granted_by`로 거둔다. 그 전에는 `granted_by`가 없고 `row_grantor`는 쌍의 부여자다
    RevokeRole { group: String, member: String, admin_only: bool, granted_by: Option<String>, row_grantor: String },
    /// `effects`는 ACL이 실제로 바뀌는 항목들이다(이미 있는 항목을 또 주거나 없는 항목을 거두는 것은 없다)
    Privileges { add: bool, on: OnTarget, privileges: Vec<Privilege>, grantee: String, effects: Vec<AclEffect> },
    DefaultAcl { creator: String, schema: Option<String>, object_type: DefaultObjType, privileges: Vec<Privilege>, grantee: String, add: bool },
    Terminate { pid: i32, role: String, backend_start: Option<String> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OnTarget {
    Database(String),
    Schema(String),
    Relation(String, String),
    Sequence(String, String),
    Function(String, String, String),
    AllTables(String),
    AllSequences(String),
}

impl OnTarget {
    pub fn clause(&self) -> OnClause<'_> {
        match self {
            OnTarget::Database(name) => OnClause::Database(name),
            OnTarget::Schema(name) => OnClause::Schema(name),
            OnTarget::Relation(schema, name) => OnClause::Table(schema, name),
            OnTarget::Sequence(schema, name) => OnClause::Sequence(schema, name),
            OnTarget::Function(schema, name, signature) => OnClause::Routine(schema, name, signature),
            OnTarget::AllTables(schema) => OnClause::AllTables(schema),
            OnTarget::AllSequences(schema) => OnClause::AllSequences(schema),
        }
    }
}

/// ACL 항목 하나가 더해지거나 지워진다. `AllTables`와 `AllSequences`는 여기서 객체마다로 펼쳐진다
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AclEffect {
    pub object: ObjKey,
    pub privilege: Privilege,
    pub grantor: String,
}

/// 권한을 가진 객체. 시퀀스는 관계다
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ObjKey {
    Database(String),
    Schema(String),
    Relation(String, String),
    Function(String, String, String),
}

impl ObjKey {
    /// 화면에 나가는 이름표(`text::target_label`과 같은 꼴)
    pub fn label(&self) -> String {
        match self {
            ObjKey::Database(name) => format!("데이터베이스 {name}"),
            ObjKey::Schema(name) => format!("스키마 {name}"),
            ObjKey::Relation(schema, name) => format!("{schema}.{name}"),
            ObjKey::Function(schema, name, signature) => format!("{schema}.{name}({signature})"),
        }
    }
}

/// 풀린 변경
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Resolved {
    pub ops: Vec<Op>,
    pub statements: Vec<Statement>,
    /// 막힘의 글. 비어 있지 않으면 적용할 수 없다
    pub blocks: Vec<String>,
    /// 확인을 받아야 하는 글(일부만 읽은 스냅숏)
    pub confirms: Vec<String>,
    /// 거둬도 남는 권한: `${부여자} → ${객체} ${권한}`, 이름순
    pub stays: Vec<String>,
    /// 거둬도 남는 구성원 관계를 준 역할들
    pub memberships_stay: Vec<String>,
}

pub struct ResolveCtx<'a> {
    pub cluster: &'a ClusterSnapshot,
    pub db: &'a DbSnapshot,
    /// 이 앱이 연 연결들의 백엔드 pid(끊으면 안 된다)
    pub own_pids: &'a [i32],
    pub read_replica: bool,
}

pub fn resolve(ctx: &ResolveCtx, change: &PgChange) -> Resolved {
    let mut resolver = Resolver { ctx, cluster: ctx.cluster.clone(), db: ctx.db.clone(), out: Resolved::default() };
    if ctx.read_replica {
        resolver.block(READ_REPLICA);
    }
    resolver.run(change);
    resolver.out
}

// ───────────────────────── 풀이 ─────────────────────────

struct Resolver<'a> {
    ctx: &'a ResolveCtx<'a>,
    /// 지금까지의 연산이 적용된 스냅숏
    cluster: ClusterSnapshot,
    db: DbSnapshot,
    out: Resolved,
}

impl Resolver<'_> {
    fn block(&mut self, text: impl Into<String>) {
        let text = text.into();
        if !self.out.blocks.contains(&text) {
            self.out.blocks.push(text);
        }
    }

    fn confirm(&mut self, text: &str) {
        if !self.out.confirms.iter().any(|c| c == text) {
            self.out.confirms.push(text.to_string());
        }
    }

    fn rights(&self) -> Rights<'_> {
        Rights::new(&self.cluster, &self.db)
    }

    fn login(&self) -> String {
        self.cluster.login_user.clone()
    }

    fn version(&self) -> i32 {
        self.cluster.version_num
    }

    fn role_rec(&self, name: &str) -> Option<&RoleRec> {
        self.cluster.roles.iter().find(|r| r.name == name)
    }

    /// 연산을 스냅숏에 적용하고 연산과 문장을 함께 낸다
    fn push(&mut self, op: Op, statement: Statement) {
        after::apply(&mut self.cluster, &mut self.db, std::slice::from_ref(&op));
        self.out.ops.push(op);
        self.out.statements.push(statement);
    }

    fn run(&mut self, change: &PgChange) {
        self.check_database(change.execution_database(&self.ctx.db.database));
        match change {
            PgChange::CreateRole { name, login, groups, connection_limit, valid_until, preset } => {
                self.create_role(name, *login, groups, *connection_limit, valid_until.as_deref(), preset.as_ref())
            }
            PgChange::Membership { group, member, add, admin } => self.membership(group, member, *add, *admin),
            PgChange::Attributes { role, set } => self.attributes(role, set),
            PgChange::Password { role } => self.password(role),
            PgChange::Grant { grantee, add, items, .. } => self.grant(grantee, *add, items),
            PgChange::DefaultPrivilege { creator, schema, object_type, grantee, privileges, add, .. } => {
                self.default_privilege(creator, schema.as_deref(), *object_type, grantee, privileges, *add)
            }
            PgChange::DropRole { role } => self.drop_role(role),
            PgChange::Terminate { pid, role, backend_start } => self.terminate(*pid, role, backend_start.as_deref()),
        }
    }

    /// 변경이 도는 데이터베이스: 클러스터에 있고, 접속할 수 있고, 템플릿이나 `rdsadmin`이 아니어야 한다. 명령도 접속하기 전에 한 번 더 본다
    fn check_database(&mut self, name: &str) {
        let usable = name == self.ctx.db.database
            && !matches!(name, "template0" | "template1" | "rdsadmin")
            && self.cluster.databases.iter().find(|d| d.name == name).is_some_and(|d| d.allow_conn);
        if !usable {
            self.block(format!("이 데이터베이스에서는 바꿀 수 없어요: {name}"));
        }
    }

    // ───── 역할 이름 ─────

    /// 스냅숏에 있는 역할인가. 아니면 막힘을 담는다. 이름이 `PUBLIC`인 역할이 있으면 그 역할은 이 앱이 다루지 않는다
    fn known_role(&mut self, name: &str) -> bool {
        if name == "PUBLIC" && self.role_rec(name).is_some() {
            self.block(PUBLIC_ROLE);
            return false;
        }
        if self.role_rec(name).is_none() {
            self.block(unknown_role_text(name));
            return false;
        }
        true
    }

    /// 바꿀 역할이 시스템 역할이면 막힘을 담는다
    fn changeable(&mut self, name: &str) -> bool {
        if is_system_role(name) {
            self.block(system_role_text(name));
            return false;
        }
        true
    }

    /// 새 역할의 이름: 모양, 예약어, 이미 있는지
    fn new_name(&mut self, name: &str) -> bool {
        if name.is_empty() || name.len() > 63 || name.starts_with("pg_") || name.chars().any(char::is_control) {
            self.block(BAD_NAME);
            return false;
        }
        if RESERVED_NAMES.iter().any(|reserved| name.eq_ignore_ascii_case(reserved)) {
            self.block(RESERVED_NAME);
            return false;
        }
        if self.role_rec(name).is_some() {
            self.block(format!("이미 있는 역할이에요: {name}"));
            return false;
        }
        true
    }

    /// 권한을 받는 쪽: 글자 그대로의 `PUBLIC`이거나 스냅숏의 역할이다. `public`이나 `Public`은 서버가 모든 역할로 읽으니 역할로 치지 않는다
    fn grantee_ok(&mut self, grantee: &str) -> bool {
        if grantee == "PUBLIC" {
            return true;
        }
        self.known_role(grantee) && self.changeable(grantee)
    }

    // ───── 역할 만들기 ─────

    fn create_role(&mut self, name: &str, login: bool, groups: &[String], connection_limit: i32, valid_until: Option<&str>, preset: Option<&PresetChoice>) {
        if let Err(text) = self.rights().create_role() {
            self.block(text);
        }
        if login || valid_until.is_some() {
            if let Err(text) = self.rights().password_commands() {
                self.block(text);
            }
        }
        if let Some(preset) = preset {
            if preset.preset != PresetKind::Admin {
                self.check_preset(preset);
            }
            if preset.create_group {
                if let Some(group) = preset.group.as_deref() {
                    if self.new_name(group) {
                        let statement = sql_text::create_role(group, false, false, -1, None);
                        self.push(Op::CreateRole { name: group.into(), login: false, connection_limit: -1, valid_until: None, password: false }, statement);
                    }
                }
            }
        }
        // 이름은 그룹을 만든 뒤에 본다: 새 그룹과 이름이 같으면 이미 있는 역할이다.
        // 이름이 막혀도 뒷단계의 판단과 문장은 이어 만든다(이미 있는 역할이면 원래 역할 위에서 판단한다)
        let creatable = self.new_name(name);
        let statement = sql_text::create_role(name, login, login, connection_limit, valid_until);
        if creatable {
            self.push(Op::CreateRole { name: name.into(), login, connection_limit, valid_until: valid_until.map(str::to_string), password: login }, statement);
        } else {
            self.out.statements.push(statement);
        }
        if let Some(preset) = preset {
            self.preset_privileges(name, preset);
        }
        for group in groups {
            self.join(group, name, false);
        }
    }

    /// 프리셋이 말하는 데이터베이스와 스키마와 만드는 역할을 확인한다
    fn check_preset(&mut self, preset: &PresetChoice) {
        if let Some(database) = preset.database.as_deref() {
            self.check_database(database);
        }
        for schema in &preset.schemas {
            if !self.db.schemas.iter().any(|s| &s.name == schema) {
                self.block(format!("객체를 찾을 수 없어요: 스키마 {schema}"));
            }
        }
        if self.db.truncated && !preset.schemas.is_empty() {
            self.confirm(TRUNCATED);
        }
    }

    /// 프리셋의 권한과 구성원 관계. 관리자는 `rds_superuser`에 넣는 것이 전부고,
    /// 그 밖에는 `group`이 있고 이미 있는 그룹이면(`create_group`이 아니면) 그 그룹이 이미 권한을 가졌다고 보아 구성원 관계만 만든다
    fn preset_privileges(&mut self, name: &str, preset: &PresetChoice) {
        if preset.preset == PresetKind::Admin {
            self.join(RDS_SUPERUSER, name, false);
            return;
        }
        let holder = preset.group.as_deref().unwrap_or(name).to_string();
        if preset.group.is_none() || preset.create_group {
            self.preset_grants(&holder, preset);
        }
        if let Some(group) = preset.group.as_deref() {
            self.join(group, name, false);
        }
    }

    fn preset_grants(&mut self, holder: &str, preset: &PresetChoice) {
        use Privilege::*;
        let (tables, sequences): (&[Privilege], &[Privilege]) = match preset.preset {
            PresetKind::ReadOnly => (&[Select], &[Select]),
            PresetKind::ReadWrite => (&[Select, Insert, Update, Delete], &[Select, Usage]),
            PresetKind::Owner | PresetKind::Admin => (&[], &[]),
        };
        let schema_privileges: &[Privilege] = if preset.preset == PresetKind::Owner { &[Usage, Create] } else { &[Usage] };
        if let Some(database) = preset.database.as_deref() {
            self.grant_item(holder, true, &GrantItem { target: GrantTarget::Database { name: database.into() }, privileges: vec![Connect] });
        }
        for schema in &preset.schemas {
            self.grant_item(holder, true, &GrantItem { target: GrantTarget::Schema { name: schema.clone() }, privileges: schema_privileges.to_vec() });
            if !tables.is_empty() {
                self.grant_item(holder, true, &GrantItem { target: GrantTarget::AllTables { schema: schema.clone() }, privileges: tables.to_vec() });
                self.grant_item(holder, true, &GrantItem { target: GrantTarget::AllSequences { schema: schema.clone() }, privileges: sequences.to_vec() });
            }
        }
        if !tables.is_empty() {
            for creator in &preset.creators {
                for schema in &preset.schemas {
                    self.default_privilege(creator, Some(schema), DefaultObjType::Tables, holder, tables, true);
                    self.default_privilege(creator, Some(schema), DefaultObjType::Sequences, holder, sequences, true);
                }
            }
        }
    }

}

mod grants;
mod membership;
mod roles;

#[cfg(test)]
mod tests;
