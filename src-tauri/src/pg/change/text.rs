//! 화면에 나가는 변경 문구: 한 줄 요약과 이름표. 받침에 따라 달라지는 조사(을/를, 이/가)는 쓰지 않는다: 역할과 객체 이름은 영문일 때가 많아 맞게 고를 수 없다.
//! 이름은 쌍점 뒤에 두거나 화살표로 잇는다.

use super::model::{GrantItem, GrantTarget, PgChange};
use super::sql_text::privilege_list;

/// `PUBLIC`(모든 역할)을 사람이 읽는 글로 쓴다. 그 밖의 이름은 그대로다
pub fn grantee_label(name: &str) -> String {
    if name == "PUBLIC" {
        "모든 역할(PUBLIC)".to_string()
    } else {
        name.to_string()
    }
}

/// 권한을 주고받는 객체의 이름표
pub fn target_label(target: &GrantTarget) -> String {
    match target {
        GrantTarget::Database { name } => format!("데이터베이스 {name}"),
        GrantTarget::Schema { name } => format!("스키마 {name}"),
        GrantTarget::Relation { schema, name } | GrantTarget::Sequence { schema, name } => format!("{schema}.{name}"),
        GrantTarget::Function { schema, name, signature } => format!("{schema}.{name}({signature})"),
        GrantTarget::AllTables { schema } => format!("{schema} 스키마의 모든 테이블"),
        GrantTarget::AllSequences { schema } => format!("{schema} 스키마의 모든 시퀀스"),
    }
}

/// 권한 요약의 "무엇을": 객체가 하나면 그 이름표와 권한들, 여럿이면 개수
fn what(items: &[GrantItem]) -> String {
    match items {
        [item] => format!("{} {}", target_label(&item.target), privilege_list(&item.privileges)),
        _ => format!("객체 {}개", items.len()),
    }
}

/// 변경 한 줄 요약
pub fn summary(change: &PgChange) -> String {
    match change {
        PgChange::CreateRole { name, .. } => format!("역할 만들기: {name}"),
        PgChange::Membership { group, member, add, admin } => {
            let what = match (*admin, *add) {
                (false, true) => "그룹에 넣기",
                (false, false) => "그룹에서 빼기",
                (true, true) => "ADMIN OPTION 주기",
                (true, false) => "ADMIN OPTION 빼기",
            };
            format!("{what}: {member} → {group}")
        }
        PgChange::Attributes { role, .. } => format!("속성 바꾸기: {role}"),
        PgChange::Password { role } => format!("비밀번호 재설정: {role}"),
        PgChange::Grant { grantee, add, items, .. } => {
            format!("{}: {} · {}", if *add { "권한 주기" } else { "권한 빼기" }, grantee_label(grantee), what(items))
        }
        PgChange::DefaultPrivilege { creator, grantee, add, .. } => {
            format!("{}: {creator} → {}", if *add { "기본 권한 주기" } else { "기본 권한 빼기" }, grantee_label(grantee))
        }
        PgChange::DropRole { role } => format!("역할 삭제: {role}"),
        PgChange::Terminate { pid, role, .. } => format!("세션 끊기: {role} (pid {pid})"),
    }
}

#[cfg(test)]
mod tests;
