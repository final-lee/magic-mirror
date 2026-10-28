use std::collections::HashSet;

use super::*;

/// 계약의 알파벳(헷갈리는 `I`, `O`, `l`, `0`, `1`이 없다). 구현의 상수를 빌리지 않고 글자 그대로 적어서, 상수가 틀리면 이 시험이 잡는다
const ALPHABET: &str = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/// `Clone`·`Display`·`Serialize` 같은 약속이 **없다**는 것을 컴파일러에게 확인시킨다. 있으면 모호한 호출이 되어 이 파일이 컴파일되지 않는다
/// (`static_assertions::assert_not_impl_any!`와 같은 방법이다).
macro_rules! assert_not_implemented {
    ($ty:ty: $($tr:path),+ $(,)?) => {$(
        const _: fn() = || {
            trait AmbiguousIfImplemented<A> {
                fn some_item() {}
            }
            impl<T: ?Sized> AmbiguousIfImplemented<()> for T {}
            impl<T: ?Sized + $tr> AmbiguousIfImplemented<u8> for T {}
            let _ = <$ty as AmbiguousIfImplemented<_>>::some_item;
        };
    )+};
}

assert_not_implemented!(NewPassword: Clone, std::fmt::Display, serde::Serialize);
assert_not_implemented!(ScramHash: Clone, std::fmt::Display, serde::Serialize);

fn plain(password: &NewPassword) -> String {
    password.0.clone()
}

#[test]
fn a_generated_password_has_24_characters_from_the_alphabet() {
    for _ in 0..1_000 {
        let text = plain(&NewPassword::generate());
        assert_eq!(text.chars().count(), 24, "{text}");
        assert!(text.chars().all(|c| ALPHABET.contains(c)), "알파벳 밖의 글자가 있어요: {text}");
    }
}

#[test]
fn a_thousand_generated_passwords_are_all_different() {
    let all: HashSet<String> = (0..1_000).map(|_| plain(&NewPassword::generate())).collect();
    assert_eq!(all.len(), 1_000);
}

#[test]
fn every_character_of_the_alphabet_turns_up() {
    // 24,000자를 뽑으면 글자마다 400번쯤 나온다. 범위를 하나 모자라게 잡으면 마지막 글자가 영영 안 나온다
    let seen: HashSet<char> = (0..1_000).flat_map(|_| plain(&NewPassword::generate()).chars().collect::<Vec<_>>()).collect();
    let wanted: HashSet<char> = ALPHABET.chars().collect();
    assert_eq!(wanted.len(), 57);
    assert_eq!(seen, wanted);
}

#[test]
fn debug_output_names_the_type_and_hides_the_value() {
    let password = NewPassword::generate();
    let hash = password.scram();
    assert_eq!(format!("{password:?}"), "NewPassword(••••••••)");
    assert_eq!(format!("{hash:?}"), "ScramHash(••••••••)");
    // 보기 좋게 찍는 꼴({:#?})과 다른 값 안에 담긴 꼴도 같다
    assert_eq!(format!("{password:#?}"), "NewPassword(••••••••)");
    assert_eq!(format!("{:?}", Some(&hash)), "Some(ScramHash(••••••••))");
}

#[test]
fn debug_output_contains_neither_the_password_nor_the_hash() {
    let password = NewPassword::generate();
    let hash = password.scram();
    let (secret, verifier) = (plain(&password), hash.0.clone());
    for shown in [format!("{password:?}"), format!("{hash:?}"), format!("{password:#?}{hash:#?}")] {
        assert!(!shown.contains(&secret) && !shown.contains(&verifier), "{shown}");
        // 해시의 앞토막도 새지 않는다
        assert!(!shown.contains("SCRAM-SHA-256"), "{shown}");
    }
}

/// `^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$`. 정규식 크레이트 없이 자리마다 본다
fn is_scram_verifier(text: &str) -> bool {
    let base64 = |part: &str| !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '='));
    let Some(rest) = text.strip_prefix("SCRAM-SHA-256$4096:") else { return false };
    let Some((salt, keys)) = rest.split_once('$') else { return false };
    let Some((stored_key, server_key)) = keys.split_once(':') else { return false };
    base64(salt) && base64(stored_key) && base64(server_key)
}

#[test]
fn the_verifier_checker_accepts_and_rejects_the_right_shapes() {
    assert!(is_scram_verifier("SCRAM-SHA-256$4096:c2FsdA==$c3RvcmVk:c2VydmVy"));
    for wrong in [
        "",
        "SCRAM-SHA-256$4096:c2FsdA==",
        "SCRAM-SHA-256$4096:$c3RvcmVk:c2VydmVy",
        "SCRAM-SHA-256$4096:c2FsdA==$c3RvcmVk",
        "SCRAM-SHA-256$4096:c2FsdA==$c3RvcmVk:c2VydmVy$extra",
        "SCRAM-SHA-256$4096:c2FsdA==$c3Rv cmVk:c2VydmVy",
        "SCRAM-SHA-256$10000:c2FsdA==$c3RvcmVk:c2VydmVy",
        "md5d41d8cd98f00b204e9800998ecf8427e",
    ] {
        assert!(!is_scram_verifier(wrong), "{wrong}");
    }
}

#[test]
fn scram_makes_a_postgres_verifier() {
    let hash = NewPassword::generate().scram();
    assert!(is_scram_verifier(&hash.0), "{}", hash.0);
}

#[test]
fn two_hashes_of_one_password_differ_because_the_salt_is_random() {
    let password = NewPassword::generate();
    assert_ne!(password.scram().0, password.scram().0);
}

#[test]
fn the_hash_goes_into_a_statement_as_a_single_quoted_literal() {
    let hash = NewPassword::generate().scram();
    assert_eq!(hash.sql_literal(), format!("'{}'", hash.0));
}

#[test]
fn expose_hands_over_the_password_it_holds() {
    let password = NewPassword::generate();
    let copy = plain(&password);
    assert_eq!(password.expose(), copy);
}
