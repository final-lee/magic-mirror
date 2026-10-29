//! 변경(2단계)의 순수한 부분. 데이터베이스에 닿는 코드는 하나도 없다: 문장을 돌리는 일은 `exec`가 한다.
//!
//! - `model`: 계약의 변경 종류(`PgChange`)와 그 부품. 화면이 보낸 변경이 그대로 이 값으로 읽힌다.
//! - `sql_text`: 변경이 되는 SQL 문장을 만든다. 이름과 값은 `pg::sql`로만 넣고, 비밀번호 자리는 `Part::Password`로 비워 둔다.
//! - `text`: 화면에 나가는 한 줄 요약과 이름표
//! - `resolve`: 변경 하나가 연산과 문장과 막힘의 글이 된다
//! - `after`: 연산을 적용한 뒤의 스냅숏
//! - `impact`: 변경이 누구의 권한을 어떻게 바꾸나, 역할과 기본 권한의 변화
//! - `warnings`: 막힘·확인·알림
//! - `inverse`: 변경을 되돌리는 변경들
//! - `preview`: 변경 하나와 장바구니의 미리보기
//! - `rights`: 로그인한 DB 사용자가 무엇을 할 수 있나(서버 규칙대로), 서버가 부여자로 적는 역할

pub mod after;
pub mod digest;
pub mod impact;
pub mod inverse;
pub mod model;
pub mod preview;
pub mod resolve;
pub mod rights;
pub mod sql_text;
pub mod text;
pub mod warnings;

#[cfg(test)]
pub(crate) mod support;
