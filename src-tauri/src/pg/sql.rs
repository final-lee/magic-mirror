//! SQL 문장에 이름과 값을 넣는 길. 식별자는 `ident`, 값은 `literal`, 권한을 받는 쪽은 `grantee`로만 넣는다.
//! 둘 다 `postgres_protocol::escape`를 감싼 것이다(libpq의 `PQescapeInternal`을 옮긴 것). 키워드와 권한 이름은 열거형에서만 오고,
//! 이 세 함수 밖에서는 이름을 문장에 `format!`으로 끼워 넣지 않는다(함수 인자 목록 하나만 예외다: `change::sql_text::OnClause::Routine`).

use postgres_protocol::escape::{escape_identifier, escape_literal};

/// 식별자(역할·데이터베이스·스키마·객체 이름)를 큰따옴표로 감싼다. 이름 안의 큰따옴표는 둘로 적는다: `a"b` → `"a""b"`
pub fn ident(name: &str) -> String {
    escape_identifier(name)
}

/// 값(문자열 상수)을 작은따옴표로 감싼다. 안의 작은따옴표는 둘로 적는다. 역슬래시가 있으면 `E'…'` 꼴이 되고 역슬래시도 둘로 적어서,
/// 서버의 `standard_conforming_strings` 설정이 어떻든 같게 읽힌다.
/// `escape_literal`은 `E'…'` 꼴 앞에 공백을 하나 붙인다(식별자 바로 뒤에 이어 붙여도 깨지지 않게). 이 앱의 문장은 키워드 뒤에 늘 공백을 두므로 뗀다.
pub fn literal(value: &str) -> String {
    escape_literal(value).trim_start().to_string()
}

/// 권한을 받는 쪽. 글자 그대로 `PUBLIC`이면 모든 역할을 뜻하는 키워드고, 그 밖의 이름은 식별자다.
/// 이름이 `PUBLIC`인 역할은 만들 수 없다(서버가 예약해 둔 이름이다).
pub fn grantee(name: &str) -> String {
    if name == "PUBLIC" {
        "PUBLIC".to_string()
    } else {
        ident(name)
    }
}

#[cfg(test)]
mod tests;
