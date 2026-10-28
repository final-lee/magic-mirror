//! 변경(2단계)의 순수한 부분. 데이터베이스에 닿는 코드는 하나도 없다: 문장을 돌리는 일은 `exec`가 한다.
//!
//! - `model`: 계약의 변경 종류(`PgChange`)와 그 부품. 화면이 보낸 변경이 그대로 이 값으로 읽힌다.
//! - `sql_text`: 변경이 되는 SQL 문장을 만든다. 이름과 값은 `pg::sql`로만 넣고, 비밀번호 자리는 `Part::Password`로 비워 둔다.
//! - `text`: 화면에 나가는 한 줄 요약과 이름표

pub mod model;
pub mod sql_text;
pub mod text;
