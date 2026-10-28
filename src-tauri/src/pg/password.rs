//! 새 비밀번호: 만들고, 문장에 넣을 SCRAM-SHA-256 검증값으로 바꾼다.
//! 평문은 `NewPassword` 안에만 있고 밖으로 나가는 길은 `expose` 하나다(비밀번호를 만들거나 다시 정한 `pg_apply`의 결과가 한 번 부른다).
//! 문장에는 평문이 아니라 검증값(`ScramHash`)만 들어간다. 미리보기와 변경 기록에는 둘 다 나가지 않고 `MASK`가 대신 보인다.
//!
//! 두 타입에는 `Clone`·`Display`·`Serialize`가 없고 `Debug`는 값을 가린다(`NewPassword(••••••••)`): 로그나 오류에 실수로 찍혀도 새지 않는다.
//! `Debug`를 `derive`하지 않는다. 같은 약속을 지켜야 하는 다른 타입(`exec`의 `Step`, `PgApplyResult`)과 함께 `hygiene` 시험이 본다.

use std::fmt;

use postgres_protocol::password::scram_sha_256;
use rand::RngExt;

use super::sql::literal;

/// 비밀번호 자리를 가리는 글자. 미리보기의 `PASSWORD '••••••••'`와 `Debug` 출력이 쓴다
pub const MASK: &str = "••••••••";

/// 새 비밀번호의 글자들. 헷갈리는 `I`, `O`, `l`, `0`, `1`은 뺐다
const ALPHABET: &[u8; 57] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/// 새 비밀번호의 길이
const LENGTH: usize = 24;

/// 이 앱이 만든 비밀번호의 평문
pub struct NewPassword(String);

impl NewPassword {
    /// 알파벳에서 24글자를 뽑는다. `rand::rng()`는 운영체제의 난수로 씨를 받고 다시 씨를 받는 암호학적 난수 생성기다.
    /// 글자마다 `random_range`로 뽑으니 알파벳 크기에 치우침이 없다.
    pub fn generate() -> NewPassword {
        let mut rng = rand::rng();
        NewPassword((0..LENGTH).map(|_| char::from(ALPHABET[rng.random_range(0..ALPHABET.len())])).collect())
    }

    /// 서버에 보낼 검증값. 호출마다 소금이 달라서 같은 비밀번호도 매번 다른 값이 나온다
    pub fn scram(&self) -> ScramHash {
        ScramHash(scram_sha_256(self.0.as_bytes()))
    }

    /// 평문을 꺼낸다. 비밀번호를 만들거나 다시 정한 `pg_apply`의 결과가 부른다(그 결과를 받는 화면이 한 번 보여 준다)
    pub fn expose(self) -> String {
        self.0
    }
}

impl fmt::Debug for NewPassword {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "NewPassword({MASK})")
    }
}

/// 비밀번호의 SCRAM-SHA-256 검증값(`SCRAM-SHA-256$4096:소금$저장 키:서버 키`). 이것으로는 로그인할 수 없지만 서버에는 이것만 보낸다
pub struct ScramHash(String);

impl ScramHash {
    /// 문장에 넣는 꼴: 작은따옴표로 감싼 값. 검증값에는 따옴표도 역슬래시도 없다
    pub fn sql_literal(&self) -> String {
        literal(&self.0)
    }
}

impl fmt::Debug for ScramHash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ScramHash({MASK})")
    }
}

#[cfg(test)]
mod tests;
