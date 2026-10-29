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
use crate::pg::model::{AclEntry, ClusterSnapshot, DbSnapshot, DefaultObjType, MemberRec, Privilege, RelKind, RoleRec, SessionRec};
use crate::pg::summary::is_system_role;

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
const RDS_SUPERUSER: &str = "rds_superuser";
const READ_REPLICA: &str = "읽기 전용 복제본이라 바꿀 수 없어요";
const BAD_NAME: &str = "역할 이름이 올바르지 않아요. 1~63바이트이고 pg_로 시작하지 않아야 해요";
const RESERVED_NAME: &str = "이 이름은 PostgreSQL이 예약해 둬서 쓸 수 없어요";
const PUBLIC_ROLE: &str = "PUBLIC이라는 이름의 역할은 이 앱에서 바꿀 수 없어요";
const NO_PRIVILEGES: &str = "권한을 하나 이상 골라야 해요";
const NO_ITEMS: &str = "바꿀 객체가 없어요";
const SCHEMAS_WITH_SCHEMA: &str = "스키마의 기본 권한은 모든 스키마에만 줄 수 있어요";
const UNDO_AFTER_MORE: &str = "만든 뒤에 객체나 권한이 생겨서 되돌릴 수 없어요";
const DROP_LOGIN: &str = "앱이 로그인한 역할은 삭제할 수 없어요";
const TRUNCATED: &str = "객체가 많아 일부만 읽었어요. 영향에 없는 객체에도 적용돼요";

fn system_role_text(role: &str) -> String {
    format!("시스템 역할이라 바꿀 수 없어요: {role}")
}

fn unknown_role_text(role: &str) -> String {
    format!("역할을 찾을 수 없어요: {role}")
}

// ───────────────────────── 연산 ─────────────────────────

/// 서버에서 일어나는 일 하나. 문장 하나가 연산 하나와 짝이다(`Resolved::ops`와 `statements`는 같은 순서다)
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

/// 권한 한 건을 풀어 둔 것(스냅숏을 읽기만 해서 만든다)
struct GrantPlan {
    blocks: Vec<String>,
    op: Option<Op>,
    stays: Vec<String>,
}

fn is_table_like(kind: RelKind) -> bool {
    kind != RelKind::Sequence
}

/// 객체 종류에 있는 권한 이름. 기본 권한의 `Types`는 USAGE뿐이다
fn default_offers(object_type: DefaultObjType, p: Privilege, version: i32) -> bool {
    match object_type {
        DefaultObjType::Tables => offers(PrivKind::Table, p, version),
        DefaultObjType::Sequences => offers(PrivKind::Sequence, p, version),
        DefaultObjType::Functions => offers(PrivKind::Function, p, version),
        DefaultObjType::Schemas => offers(PrivKind::Schema, p, version),
        DefaultObjType::Types => p == Privilege::Usage,
    }
}

fn default_label(object_type: DefaultObjType) -> &'static str {
    match object_type {
        DefaultObjType::Tables => "테이블",
        DefaultObjType::Sequences => "시퀀스",
        DefaultObjType::Functions => "함수",
        DefaultObjType::Types => "타입",
        DefaultObjType::Schemas => "스키마",
    }
}

fn sorted(privileges: &[Privilege]) -> Vec<Privilege> {
    privileges.iter().copied().collect::<BTreeSet<_>>().into_iter().collect()
}

fn lookup<'x>(cluster: &'x ClusterSnapshot, db: &'x DbSnapshot, key: &ObjKey) -> Option<Obj<'x>> {
    match key {
        ObjKey::Database(name) => cluster.databases.iter().find(|d| &d.name == name).map(Obj::Database),
        ObjKey::Schema(name) => db.schemas.iter().find(|s| &s.name == name).map(Obj::Schema),
        ObjKey::Relation(schema, name) => db.relations.iter().find(|r| &r.schema == schema && &r.name == name).map(Obj::Relation),
        ObjKey::Function(schema, name, signature) => db.functions.iter().find(|f| &f.schema == schema && &f.name == name && &f.signature == signature).map(Obj::Function),
    }
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

    // ───── 구성원 관계 ─────

    fn membership(&mut self, group: &str, member: &str, add: bool, admin: bool) {
        let group_ok = self.known_role(group);
        let member_ok = self.known_role(member);
        if !(group_ok && member_ok) {
            return;
        }
        if add {
            self.join(group, member, admin);
        } else {
            self.leave(group, member, admin);
        }
    }

    /// 그룹의 구성원 관계를 바꿀 수 있는 역할인가(시스템 그룹은 열린 것만)
    fn group_open(&mut self, group: &str) -> bool {
        if is_system_role(group) && !OPEN_SYSTEM_GROUPS.contains(&group) {
            self.block(format!("이 시스템 역할에는 구성원을 넣거나 뺄 수 없어요: {group}"));
            return false;
        }
        true
    }

    fn join(&mut self, group: &str, member: &str, admin: bool) {
        if !(self.known_role(group) && self.known_role(member) && self.group_open(group) && self.changeable(member)) {
            return;
        }
        let grantor = match self.rights().membership_grantor(group) {
            Ok(grantor) => grantor,
            Err(text) => {
                self.block(text);
                self.login()
            }
        };
        let pair = self.cluster.members.iter().find(|m| m.group == group && m.member == member);
        let done = pair.is_some_and(|pair| {
            if self.version() >= crate::pg::model::MEMBERSHIP_OPTIONS_SINCE {
                pair.grants.iter().any(|g| g.grantor == grantor && (!admin || g.admin))
            } else {
                !admin || pair.admin
            }
        });
        if done {
            return;
        }
        self.push(Op::GrantRole { group: group.into(), member: member.into(), admin, grantor }, sql_text::grant_role(group, member, admin, false));
    }

    fn leave(&mut self, group: &str, member: &str, admin_only: bool) {
        if !(self.group_open(group) && self.changeable(member)) {
            return;
        }
        if let Err(text) = self.rights().membership_grantor(group) {
            self.block(text);
        }
        let revocations = self.rights().revocations(group, member, admin_only);
        if revocations.rows.is_empty() && !revocations.remaining.is_empty() {
            self.block(format!("{member} 역할을 {group} 역할에서 뺄 수 없어요. 이 구성원 관계는 {} 역할이 줬어요", revocations.remaining.join(", ")));
            return;
        }
        if revocations.rows.is_empty() {
            return;
        }
        for grantor in &revocations.remaining {
            if !self.out.memberships_stay.contains(grantor) {
                self.out.memberships_stay.push(grantor.clone());
            }
        }
        let from_16 = self.version() >= crate::pg::model::MEMBERSHIP_OPTIONS_SINCE;
        if from_16 {
            for grantor in &revocations.rows {
                if self.dependent_membership(group, member, grantor) {
                    self.block(format!("{member} 역할이 {group} 역할을 다른 역할에 줬어요. 그 구성원 관계부터 빼야 해요"));
                }
            }
        }
        for grantor in revocations.rows {
            let (granted_by, row_grantor) = if from_16 {
                (Some(grantor.clone()), grantor)
            } else {
                let first = self.cluster.members.iter().find(|m| m.group == group && m.member == member).and_then(|m| m.grants.first());
                (None, first.map(|g| g.grantor.clone()).unwrap_or_default())
            };
            let statement = sql_text::revoke_role(group, member, admin_only, granted_by.as_deref());
            self.push(Op::RevokeRole { group: group.into(), member: member.into(), admin_only, granted_by, row_grantor }, statement);
        }
    }

    /// `member`가 `group`에서 `grantor`가 준 부여를 잃으면, `member`가 준 다른 부여가 근거를 잃는가(서버는 의존하는 부여가 있으면 거둘 수 없다).
    /// 거두는 부여에 ADMIN이 있고, `member`가 같은 그룹의 다른 부여를 준 부여자이고, `member`에게 남는 ADMIN 부여가 없을 때다
    fn dependent_membership(&self, group: &str, member: &str, grantor: &str) -> bool {
        let rows = |m: &&MemberRec| m.group == group;
        let removed_admin = self.cluster.members.iter().filter(rows).any(|m| m.member == member && m.grants.iter().any(|g| g.grantor == grantor && g.admin));
        let grants_others = self.cluster.members.iter().filter(rows).any(|m| m.grants.iter().any(|g| g.grantor == member));
        let keeps_admin = self.cluster.members.iter().filter(rows).any(|m| m.member == member && m.grants.iter().any(|g| g.grantor != grantor && g.admin));
        removed_admin && grants_others && !keeps_admin
    }

    // ───── 속성, 비밀번호, 삭제, 세션 ─────

    fn attributes(&mut self, role: &str, set: &AttributesSet) {
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

    fn password(&mut self, role: &str) {
        if !(self.known_role(role) && self.changeable(role)) {
            return;
        }
        let Some(rec) = self.role_rec(role).cloned() else { return };
        if let Err(text) = self.rights().alter(&rec, &[]) {
            self.block(text);
        }
        if let Err(text) = self.rights().password_commands() {
            self.block(text);
        }
        self.push(Op::SetPassword { role: role.into() }, sql_text::alter_role_password(role));
    }

    fn drop_role(&mut self, role: &str) {
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

    fn terminate(&mut self, pid: i32, role: &str, backend_start: Option<&str>) {
        let known = self.cluster.sessions.iter().find(|s| s.pid == pid).cloned();
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
        self.push(Op::Terminate { pid, role: role.into(), backend_start: backend_start.map(str::to_string) }, sql_text::terminate(pid, role, backend_start));
    }

    // ───── 객체 권한 ─────

    fn grant(&mut self, grantee: &str, add: bool, items: &[GrantItem]) {
        if items.is_empty() {
            self.block(NO_ITEMS);
            return;
        }
        if !self.grantee_ok(grantee) {
            return;
        }
        for item in items {
            self.grant_item(grantee, add, item);
        }
        if self.db.truncated && items.iter().any(|i| matches!(i.target, GrantTarget::AllTables { .. } | GrantTarget::AllSequences { .. })) {
            self.confirm(TRUNCATED);
        }
    }

    fn grant_item(&mut self, grantee: &str, add: bool, item: &GrantItem) {
        let plan = self.plan_grant(grantee, add, item);
        for text in plan.blocks {
            self.block(text);
        }
        self.out.stays.extend(plan.stays);
        self.out.stays.sort();
        self.out.stays.dedup();
        if let Some(op) = plan.op {
            let Op::Privileges { add, on, privileges, grantee, .. } = &op else { return };
            let statement =
                if *add { sql_text::grant_privileges(privileges, &on.clause(), grantee) } else { sql_text::revoke_privileges(privileges, &on.clause(), grantee) };
            self.push(op, statement);
        }
    }

    /// 대상이 가리키는 객체들과 그 객체의 권한 종류. 스냅숏에 없으면 None
    fn locate(&self, target: &GrantTarget) -> Option<(PrivKind, Vec<ObjKey>)> {
        let in_schema = |schema: &str, pick: fn(RelKind) -> bool| -> Option<Vec<ObjKey>> {
            self.db.schemas.iter().any(|s| s.name == schema).then(|| {
                let mut keys: Vec<ObjKey> =
                    self.db.relations.iter().filter(|r| r.schema == schema && pick(r.kind)).map(|r| ObjKey::Relation(r.schema.clone(), r.name.clone())).collect();
                keys.sort();
                keys
            })
        };
        match target {
            GrantTarget::Database { name } => self.cluster.databases.iter().any(|d| &d.name == name).then(|| (PrivKind::Database, vec![ObjKey::Database(name.clone())])),
            GrantTarget::Schema { name } => self.db.schemas.iter().any(|s| &s.name == name).then(|| (PrivKind::Schema, vec![ObjKey::Schema(name.clone())])),
            GrantTarget::Relation { schema, name } => self
                .db
                .relations
                .iter()
                .any(|r| &r.schema == schema && &r.name == name && is_table_like(r.kind))
                .then(|| (PrivKind::Table, vec![ObjKey::Relation(schema.clone(), name.clone())])),
            GrantTarget::Sequence { schema, name } => self
                .db
                .relations
                .iter()
                .any(|r| &r.schema == schema && &r.name == name && r.kind == RelKind::Sequence)
                .then(|| (PrivKind::Sequence, vec![ObjKey::Relation(schema.clone(), name.clone())])),
            GrantTarget::Function { schema, name, signature } => self
                .db
                .functions
                .iter()
                .any(|f| &f.schema == schema && &f.name == name && &f.signature == signature)
                .then(|| (PrivKind::Function, vec![ObjKey::Function(schema.clone(), name.clone(), signature.clone())])),
            GrantTarget::AllTables { schema } => in_schema(schema, is_table_like).map(|keys| (PrivKind::Table, keys)),
            GrantTarget::AllSequences { schema } => in_schema(schema, |kind| kind == RelKind::Sequence).map(|keys| (PrivKind::Sequence, keys)),
        }
    }

    fn plan_grant(&self, grantee: &str, add: bool, item: &GrantItem) -> GrantPlan {
        let mut plan = GrantPlan { blocks: Vec::new(), op: None, stays: Vec::new() };
        let label = target_label(&item.target);
        if item.privileges.is_empty() {
            plan.blocks.push(NO_PRIVILEGES.to_string());
            return plan;
        }
        let Some((kind, keys)) = self.locate(&item.target) else {
            plan.blocks.push(format!("객체를 찾을 수 없어요: {label}"));
            return plan;
        };
        let privileges = sorted(&item.privileges);
        let wrong: Vec<&Privilege> = privileges.iter().filter(|&&p| !offers(kind, p, self.version())).collect();
        for p in &wrong {
            plan.blocks.push(format!("{label}에는 {} 권한이 없어요", p.as_str()));
        }
        if !wrong.is_empty() {
            return plan;
        }

        let rights = self.rights();
        let eval = Eval::new(&Ctx { cluster: &self.cluster, db: &self.db });
        let grantee_name = (grantee != "PUBLIC").then_some(grantee);
        let mut effects = Vec::new();
        let mut cannot: Vec<(String, String)> = Vec::new(); // (객체 이름표, 소유자)
        for key in &keys {
            let Some(obj) = lookup(&self.cluster, &self.db, key) else { continue };
            let grantor = rights.object_grantor(obj, &privileges).unwrap_or_else(|| {
                cannot.push((key.label(), obj.owner().to_string()));
                rights.login().to_string()
            });
            let acl = obj.acl();
            for &privilege in &privileges {
                let held = acl.iter().find(|e| e.grantor == grantor && e.grantee.as_deref() == grantee_name && e.privilege == privilege);
                if add {
                    if held.is_none() {
                        effects.push(AclEffect { object: key.clone(), privilege, grantor: grantor.clone() });
                    }
                    continue;
                }
                for other in acl.iter().filter(|e| e.grantor != grantor && e.grantee.as_deref() == grantee_name && e.privilege == privilege) {
                    plan.stays.push(format!("{} → {} {}", other.grantor, key.label(), privilege.as_str()));
                }
                if let Some(entry) = held {
                    effects.push(AclEffect { object: key.clone(), privilege, grantor: grantor.clone() });
                    if entry.grantable && self.loses_dependents(&eval, obj, entry) {
                        plan.blocks.push(format!(
                            "{} 역할이 {}의 {} 권한을 다른 역할에 다시 줬어요. 그 권한부터 빼야 해요",
                            grantee,
                            key.label(),
                            privilege.as_str()
                        ));
                    }
                }
            }
        }
        if !cannot.is_empty() {
            plan.blocks.push(grant_rights_text(add, &cannot, &privileges));
        }
        plan.stays.sort();
        plan.stays.dedup();
        plan.op = Some(Op::Privileges { add, on: on_target(&item.target), privileges, grantee: grantee.to_string(), effects });
        plan
    }

    /// 거두는 항목이 GRANT OPTION을 가졌고, 받은 쪽이 그 권한을 다른 역할에 다시 줬는데, 다른 길로도 GRANT OPTION을 갖지 못하는가.
    /// 서버는 이때 CASCADE 없이는 거두지 못한다(`aclupdate`와 `recursive_revoke`)
    fn loses_dependents(&self, eval: &Eval, obj: Obj, entry: &AclEntry) -> bool {
        let Some(holder) = entry.grantee.as_deref() else { return false };
        let (owner, acl) = (obj.owner(), obj.acl());
        if holder == owner || !acl.iter().any(|e| e.grantor == holder && e.privilege == entry.privilege) {
            return false;
        }
        let grantable = |e: &&AclEntry, who: Option<&str>| e.grantee.as_deref() == who && e.privilege == entry.privilege && e.grantable;
        let other_entry = acl.iter().any(|e| e.grantor != entry.grantor && (grantable(&e, Some(holder)) || grantable(&e, None)));
        let inherited = eval.privilege_order(holder).iter().skip(1).any(|r| r.role == owner || acl.iter().any(|e| grantable(&e, Some(&r.role))));
        !(other_entry || inherited)
    }

    // ───── 기본 권한 ─────

    fn default_privilege(&mut self, creator: &str, schema: Option<&str>, object_type: DefaultObjType, grantee: &str, privileges: &[Privilege], add: bool) {
        if !(self.known_role(creator) && self.changeable(creator)) {
            return;
        }
        if let Some(schema) = schema {
            if object_type == DefaultObjType::Schemas {
                self.block(SCHEMAS_WITH_SCHEMA);
            } else if !self.db.schemas.iter().any(|s| s.name == schema) {
                self.block(format!("객체를 찾을 수 없어요: 스키마 {schema}"));
            }
        }
        if privileges.is_empty() {
            self.block(NO_PRIVILEGES);
            return;
        }
        let wrong: Vec<Privilege> = privileges.iter().copied().filter(|&p| !default_offers(object_type, p, self.version())).collect();
        for p in &wrong {
            self.block(format!("{}에는 {} 권한이 없어요", default_label(object_type), p.as_str()));
        }
        if !wrong.is_empty() || !self.grantee_ok(grantee) {
            return;
        }
        if let Err(text) = self.rights().defaults_for(creator) {
            self.block(text);
        }
        let privileges = sorted(privileges);
        let statement = sql_text::alter_default_privileges(creator, schema, add, &privileges, object_type, grantee);
        self.push(Op::DefaultAcl { creator: creator.into(), schema: schema.map(str::to_string), object_type, privileges, grantee: grantee.into(), add }, statement);
    }
}

fn on_target(target: &GrantTarget) -> OnTarget {
    match target {
        GrantTarget::Database { name } => OnTarget::Database(name.clone()),
        GrantTarget::Schema { name } => OnTarget::Schema(name.clone()),
        GrantTarget::Relation { schema, name } => OnTarget::Relation(schema.clone(), name.clone()),
        GrantTarget::Sequence { schema, name } => OnTarget::Sequence(schema.clone(), name.clone()),
        GrantTarget::Function { schema, name, signature } => OnTarget::Function(schema.clone(), name.clone(), signature.clone()),
        GrantTarget::AllTables { schema } => OnTarget::AllTables(schema.clone()),
        GrantTarget::AllSequences { schema } => OnTarget::AllSequences(schema.clone()),
    }
}

/// 줄 수 없는(뺄 수 없는) 객체들의 글. 하나면 그 객체와 소유자를, 여럿이면 개수와 처음 셋과 소유자들을 말한다
fn grant_rights_text(add: bool, cannot: &[(String, String)], privileges: &[Privilege]) -> String {
    let mut cannot = cannot.to_vec();
    cannot.sort();
    let (particle, verb) = if add { ("에", "줄") } else { ("에서", "뺄") };
    let list = privilege_list(privileges);
    match cannot.as_slice() {
        [(object, owner)] => format!("{object}{particle} {list} 권한을 {verb} 수 없어요. 소유자 {owner} 역할의 권한을 물려받거나 GRANT OPTION이 있어야 해요"),
        _ => {
            let sample: Vec<&str> = cannot.iter().take(3).map(|(object, _)| object.as_str()).collect();
            let owners: BTreeSet<&str> = cannot.iter().map(|(_, owner)| owner.as_str()).collect();
            format!(
                "객체 {}개{particle} {list} 권한을 {verb} 수 없어요(예: {}). 소유자({}) 역할의 권한을 물려받거나 GRANT OPTION이 있어야 해요",
                cannot.len(),
                sample.join(", "),
                owners.into_iter().collect::<Vec<_>>().join(", ")
            )
        }
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

#[cfg(test)]
mod tests;
