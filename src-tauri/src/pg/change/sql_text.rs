//! 변경이 되는 SQL 문장. 순수 함수들이라 문장을 만들 뿐 보내지는 않는다(보내는 것은 `exec`다).
//!
//! 문장은 `ident`·`literal`·`grantee`(`pg::sql`)와 고정된 키워드로만 짠다. 권한 이름과 객체 종류의 키워드는 열거형에서만 온다.
//! 비밀번호 자리는 글이 아니라 `Part::Password`로 비워 둔다. 그래서 미리보기와 변경 기록에는 `PASSWORD '••••••••'`가 나가고(`Statement::shown`),
//! 서버에 보낼 때만 검증값이 들어간다(`Statement::run`). 글을 찾아 바꾸지 않고 조각을 이어 붙이니, 이름에 가림 글자가 들어 있어도 이름은 그대로다.

use std::collections::BTreeSet;

use crate::pg::model::{DefaultObjType, Privilege};
use crate::pg::password::{ScramHash, MASK};
use crate::pg::sql::{self, ident, literal};

/// `terminate`의 문장이 아무 줄도 못 찾았을 때의 오류 문구: 세션이 이미 끝났거나, 그 사이 다른 세션이 그 pid를 이어받았다
pub(crate) const SESSION_GONE: &str = "세션이 이미 끝났어요";

/// 문장의 한 조각
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Part {
    Text(String),
    /// `PASSWORD '검증값'` 한 덩어리가 들어갈 자리. 키워드까지 이 자리에 든다
    Password,
}

/// 서버에 보낼 문장 하나. 조각들을 이으면 문장이 된다(비어 있는 `Text`는 없고, `Text`끼리 이웃하지 않는다)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Statement {
    pub parts: Vec<Part>,
    /// 문장이 돌려준 첫 줄의 첫 칸이 `true`가 아니거나 줄이 없으면 실패로 보고 이 문구를 오류로 쓴다. 없으면 결과를 보지 않는다
    pub expect: Option<&'static str>,
}

impl Statement {
    /// 글 한 덩어리로 된 문장
    fn plain(text: String) -> Statement {
        Statement { parts: vec![Part::Text(text)], expect: None }
    }

    /// 미리보기와 변경 기록에 나가는 글: 비밀번호 자리는 `PASSWORD '••••••••'`
    pub fn shown(&self) -> String {
        self.parts
            .iter()
            .map(|part| match part {
                Part::Text(text) => text.clone(),
                Part::Password => format!("PASSWORD '{MASK}'"),
            })
            .collect()
    }

    /// 서버에 보낼 글: 비밀번호 자리는 `PASSWORD <검증값>`. 비밀번호 자리가 있는 문장에 검증값을 안 주는 것은 만든 쪽의 잘못이지 사용자 입력이 아니라 패닉이다.
    pub fn run(&self, hash: Option<&ScramHash>) -> String {
        self.parts
            .iter()
            .map(|part| match part {
                Part::Text(text) => text.clone(),
                Part::Password => format!("PASSWORD {}", hash.expect("비밀번호 자리가 있는 문장에는 검증값이 있어야 해요").sql_literal()),
            })
            .collect()
    }
}

/// `ALTER ROLE`의 속성 한 칸
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttrClause {
    Login(bool),
    CreateDb(bool),
    CreateRole(bool),
    Inherit(bool),
    /// -1은 제한 없음
    ConnectionLimit(i32),
    /// None은 만료 없음(`infinity`)
    ValidUntil(Option<String>),
}

impl AttrClause {
    /// 문장에서 놓이는 자리. 호출하는 쪽이 어떤 순서로 주든 이 순서로 나온다(선언 순서와 같다)
    fn rank(&self) -> u8 {
        match self {
            AttrClause::Login(_) => 0,
            AttrClause::CreateDb(_) => 1,
            AttrClause::CreateRole(_) => 2,
            AttrClause::Inherit(_) => 3,
            AttrClause::ConnectionLimit(_) => 4,
            AttrClause::ValidUntil(_) => 5,
        }
    }

    fn sql(&self) -> String {
        let flag = |on: bool, word: &str| if on { word.to_string() } else { format!("NO{word}") };
        match self {
            AttrClause::Login(on) => flag(*on, "LOGIN"),
            AttrClause::CreateDb(on) => flag(*on, "CREATEDB"),
            AttrClause::CreateRole(on) => flag(*on, "CREATEROLE"),
            AttrClause::Inherit(on) => flag(*on, "INHERIT"),
            AttrClause::ConnectionLimit(limit) => format!("CONNECTION LIMIT {limit}"),
            AttrClause::ValidUntil(None) => "VALID UNTIL 'infinity'".to_string(),
            AttrClause::ValidUntil(Some(until)) => format!("VALID UNTIL {}", literal(until)),
        }
    }
}

/// `GRANT`·`REVOKE`의 `ON` 뒤: 권한을 주고받는 객체
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OnClause<'a> {
    Database(&'a str),
    Schema(&'a str),
    /// (스키마, 이름). 테이블·뷰·구체화 뷰·파티션 테이블·외부 테이블이 모두 `TABLE`이다
    Table(&'a str, &'a str),
    Sequence(&'a str, &'a str),
    /// (스키마, 이름, 인자 목록).
    /// **이 한 곳만 이름을 `ident`로 감싸지 않은 글이 들어간다.** 인자 목록은 사용자가 쓴 이름이 아니라 서버가 찍어 준 글(`pg_get_function_identity_arguments`:
    /// `a integer, b text`)이고, 형 이름은 식별자 규칙이 달라 `ident`로 감쌀 수 없다. 그래서 그대로 쓰되, 스냅숏의 함수와 정확히 맞는다고 확인한 대상에만 쓴다
    /// (그 확인은 이 함수들을 부르는 쪽, 변경을 문장으로 푸는 `resolve`의 몫이다). 이 함수들은 확인하지 않는다.
    Routine(&'a str, &'a str, &'a str),
    AllTables(&'a str),
    AllSequences(&'a str),
}

impl OnClause<'_> {
    fn sql(&self) -> String {
        match self {
            OnClause::Database(name) => format!("DATABASE {}", ident(name)),
            OnClause::Schema(name) => format!("SCHEMA {}", ident(name)),
            OnClause::Table(schema, name) => format!("TABLE {}.{}", ident(schema), ident(name)),
            OnClause::Sequence(schema, name) => format!("SEQUENCE {}.{}", ident(schema), ident(name)),
            OnClause::Routine(schema, name, signature) => format!("ROUTINE {}.{}({signature})", ident(schema), ident(name)),
            OnClause::AllTables(schema) => format!("ALL TABLES IN SCHEMA {}", ident(schema)),
            OnClause::AllSequences(schema) => format!("ALL SEQUENCES IN SCHEMA {}", ident(schema)),
        }
    }
}

/// 권한 목록의 글. `Privilege`의 선언 순서로 한 번씩만 적는다: 호출하는 쪽이 준 순서와 상관없이 같은 문장이 나와야 미리보기를 비교할 수 있다.
/// 화면의 요약(`text`)도 같은 글을 쓴다: 요약이 보여 주는 권한과 문장이 주는 권한은 순서까지 같다
pub(super) fn privilege_list(privileges: &[Privilege]) -> String {
    privileges.iter().copied().collect::<BTreeSet<_>>().into_iter().map(Privilege::as_str).collect::<Vec<_>>().join(", ")
}

// ───────────────────────── 역할 ─────────────────────────

/// `CREATE ROLE`. 비밀번호 자리는 `with_password`일 때 `LOGIN`/`NOLOGIN` 바로 뒤에 둔다. 제한이 -1이거나 만료가 없으면 그 칸은 쓰지 않는다
pub fn create_role(name: &str, login: bool, with_password: bool, connection_limit: i32, valid_until: Option<&str>) -> Statement {
    let mut head = format!("CREATE ROLE {} {}", ident(name), if login { "LOGIN" } else { "NOLOGIN" });
    let mut tail = String::new();
    if connection_limit != -1 {
        tail.push_str(&format!(" CONNECTION LIMIT {connection_limit}"));
    }
    if let Some(until) = valid_until {
        tail.push_str(&format!(" VALID UNTIL {}", literal(until)));
    }
    if !with_password {
        head.push_str(&tail);
        return Statement::plain(head);
    }
    head.push(' ');
    let mut parts = vec![Part::Text(head), Part::Password];
    if !tail.is_empty() {
        parts.push(Part::Text(tail));
    }
    Statement { parts, expect: None }
}

/// `ALTER ROLE … <속성들>`. 준 속성만, 고정된 순서(로그인, CREATEDB, CREATEROLE, 상속, 접속 제한, 만료)로 쓴다.
/// 속성이 하나도 없으면 문법에 맞지 않는 문장이 되니 부르는 쪽이 빈 목록으로 부르지 않는다.
pub fn alter_role(role: &str, clauses: &[AttrClause]) -> Statement {
    let mut ordered: Vec<&AttrClause> = clauses.iter().collect();
    ordered.sort_by_key(|clause| clause.rank());
    let words: Vec<String> = ordered.iter().map(|clause| clause.sql()).collect();
    Statement::plain(format!("ALTER ROLE {} {}", ident(role), words.join(" ")))
}

/// `ALTER ROLE … PASSWORD …`: 새 비밀번호의 검증값을 넣을 자리가 있는 문장
pub fn alter_role_password(role: &str) -> Statement {
    Statement { parts: vec![Part::Text(format!("ALTER ROLE {} ", ident(role))), Part::Password], expect: None }
}

pub fn drop_role(role: &str) -> Statement {
    Statement::plain(format!("DROP ROLE {}", ident(role)))
}

// ───────────────────────── 구성원 관계 ─────────────────────────

/// `GRANT group TO member`. `admin`이면 `WITH ADMIN OPTION`. `inherit_true`이면 `WITH INHERIT TRUE`를 더한다(PG16부터 있는 문법이라 PG16의 삭제 계획만 쓴다).
/// 옵션이 둘이면 PG16 문법대로 쉼표로 잇는다
pub fn grant_role(group: &str, member: &str, admin: bool, inherit_true: bool) -> Statement {
    let options: Vec<&str> = [admin.then_some("ADMIN OPTION"), inherit_true.then_some("INHERIT TRUE")].into_iter().flatten().collect();
    let with = if options.is_empty() { String::new() } else { format!(" WITH {}", options.join(", ")) };
    Statement::plain(format!("GRANT {} TO {}{with}", ident(group), ident(member)))
}

/// `REVOKE group FROM member`. `admin_only`면 ADMIN OPTION만 거둔다. `granted_by`는 거둘 부여를 준 쪽(PG16부터 부여마다 부여자가 있다)
pub fn revoke_role(group: &str, member: &str, admin_only: bool, granted_by: Option<&str>) -> Statement {
    let admin = if admin_only { "ADMIN OPTION FOR " } else { "" };
    let by = granted_by.map_or(String::new(), |grantor| format!(" GRANTED BY {}", ident(grantor)));
    Statement::plain(format!("REVOKE {admin}{} FROM {}{by}", ident(group), ident(member)))
}

// ───────────────────────── 객체 권한 ─────────────────────────

/// `GRANT <권한들> ON <객체> TO <받는 쪽>`. 받는 쪽이 `PUBLIC`이면 모든 역할이다
pub fn grant_privileges(privileges: &[Privilege], on: &OnClause, grantee: &str) -> Statement {
    Statement::plain(format!("GRANT {} ON {} TO {}", privilege_list(privileges), on.sql(), sql::grantee(grantee)))
}

/// `REVOKE <권한들> ON <객체> FROM <받는 쪽>`
pub fn revoke_privileges(privileges: &[Privilege], on: &OnClause, grantee: &str) -> Statement {
    Statement::plain(format!("REVOKE {} ON {} FROM {}", privilege_list(privileges), on.sql(), sql::grantee(grantee)))
}

/// `ALTER DEFAULT PRIVILEGES FOR ROLE <만드는 역할> [IN SCHEMA <스키마>] GRANT|REVOKE <권한들> ON <객체 종류> TO|FROM <받는 쪽>`.
/// 스키마가 없으면 모든 스키마의 기본 권한이다
pub fn alter_default_privileges(creator: &str, schema: Option<&str>, add: bool, privileges: &[Privilege], object_type: DefaultObjType, grantee: &str) -> Statement {
    let objects = match object_type {
        DefaultObjType::Tables => "TABLES",
        DefaultObjType::Sequences => "SEQUENCES",
        DefaultObjType::Functions => "FUNCTIONS",
        DefaultObjType::Types => "TYPES",
        DefaultObjType::Schemas => "SCHEMAS",
    };
    let scope = schema.map_or(String::new(), |schema| format!(" IN SCHEMA {}", ident(schema)));
    let (verb, direction) = if add { ("GRANT", "TO") } else { ("REVOKE", "FROM") };
    Statement::plain(format!(
        "ALTER DEFAULT PRIVILEGES FOR ROLE {}{scope} {verb} {} ON {objects} {direction} {}",
        ident(creator),
        privilege_list(privileges),
        sql::grantee(grantee)
    ))
}

// ───────────────────────── 세션, 소유권 ─────────────────────────

/// 세션을 끊는다. pid와 역할이 그대로이고(그 사이 다른 세션이 pid를 이어받지 않았고), 시작 시각을 알면 그 초까지 같을 때만 끊는다.
/// 맞는 세션이 없으면 줄이 없어서 `expect`의 문구가 오류가 된다
pub fn terminate(pid: i32, role: &str, backend_start: Option<&str>) -> Statement {
    let started = backend_start.map_or(String::new(), |start| format!(" AND date_trunc('second', backend_start) = {}::timestamptz", literal(start)));
    Statement {
        parts: vec![Part::Text(format!("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = {pid} AND usename = {}{started}", literal(role)))],
        expect: Some(SESSION_GONE),
    }
}

/// 역할이 가진 객체를 다른 역할에게 넘긴다
pub fn reassign_owned(role: &str, to: &str) -> Statement {
    Statement::plain(format!("REASSIGN OWNED BY {} TO {}", ident(role), ident(to)))
}

/// 역할이 가진 객체를 지우고 그 역할이 받은 권한을 거둔다(현재 데이터베이스에서)
pub fn drop_owned(role: &str) -> Statement {
    Statement::plain(format!("DROP OWNED BY {}", ident(role)))
}

#[cfg(test)]
mod tests;
