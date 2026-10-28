use super::*;

/// 식별자 하나를 읽어 이름을 돌려준다. 바깥 큰따옴표 안에서 큰따옴표는 반드시 둘씩 짝이고, 짝이 안 맞거나 따옴표 뒤에 다른 것이 오면 None이다.
/// 서버가 이 글자를 읽는 규칙 그대로라서, 이것이 입력으로 돌아오면 문장 한가운데에서 식별자가 끝나는 일이 없다.
fn unquote_ident(quoted: &str) -> Option<String> {
    let inner = quoted.strip_prefix('"')?.strip_suffix('"')?;
    let mut name = String::new();
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c == '"' && chars.next() != Some('"') {
            return None;
        }
        name.push(c);
    }
    Some(name)
}

/// 문자열 상수 하나를 읽어 값을 돌려준다. `'…'`에서는 작은따옴표가 둘씩 짝이고, `E'…'`에서는 역슬래시도 둘씩 짝이다(역슬래시 하나는 다음 글자를 이스케이프한다).
fn unquote_literal(quoted: &str) -> Option<String> {
    let (escape_form, rest) = match quoted.strip_prefix('E') {
        Some(rest) => (true, rest),
        None => (false, quoted),
    };
    let inner = rest.strip_prefix('\'')?.strip_suffix('\'')?;
    let mut value = String::new();
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        match c {
            '\'' if chars.next() != Some('\'') => return None,
            '\\' if escape_form && chars.next() != Some('\\') => return None,
            _ => {}
        }
        value.push(c);
    }
    Some(value)
}

/// 따옴표·역슬래시·세미콜론·주석·여러 줄·한글이 섞인 입력
const NASTY: [&str; 9] = [
    "alice",
    "a\"b",
    "x\"); DROP TABLE t;--",
    "O'Brien",
    "a\\b",
    "it's a\\b",
    "'; DROP ROLE x;--",
    "line one\nline two",
    "앱_읽기 \"따옴표\" '작은' \\",
];

#[test]
fn ident_wraps_a_name_in_double_quotes() {
    assert_eq!(ident("alice"), "\"alice\"");
}

#[test]
fn ident_doubles_a_double_quote_inside_the_name() {
    assert_eq!(ident("a\"b"), "\"a\"\"b\"");
}

#[test]
fn a_name_made_to_break_out_of_the_quotes_stays_one_identifier() {
    assert_eq!(ident("x\"); DROP TABLE t;--"), "\"x\"\"); DROP TABLE t;--\"");
}

#[test]
fn ident_keeps_non_ascii_names() {
    assert_eq!(ident("앱_읽기"), "\"앱_읽기\"");
}

#[test]
fn every_identifier_reads_back_as_exactly_the_name_it_was_made_from() {
    for name in NASTY {
        assert_eq!(unquote_ident(&ident(name)).as_deref(), Some(name), "{name}");
    }
}

#[test]
fn literal_wraps_a_value_in_single_quotes() {
    assert_eq!(literal("2027-01-01T00:00:00Z"), "'2027-01-01T00:00:00Z'");
}

#[test]
fn literal_doubles_a_single_quote_inside_the_value() {
    assert_eq!(literal("O'Brien"), "'O''Brien'");
}

#[test]
fn a_value_with_a_backslash_takes_the_escape_string_form_and_doubles_the_backslash() {
    assert_eq!(literal("a\\b"), "E'a\\\\b'");
    // 따옴표도 함께 있으면 둘 다 둘씩 짝이다
    assert_eq!(literal("it's a\\b"), "E'it''s a\\\\b'");
}

#[test]
fn a_literal_never_starts_with_the_space_that_escape_literal_puts_before_the_escape_form() {
    for value in NASTY {
        let quoted = literal(value);
        assert!(quoted.starts_with('\'') || quoted.starts_with("E'"), "{value}: {quoted}");
    }
}

#[test]
fn every_literal_reads_back_as_exactly_the_value_it_was_made_from() {
    for value in NASTY {
        assert_eq!(unquote_literal(&literal(value)).as_deref(), Some(value), "{value}");
    }
}

#[test]
fn only_the_exact_word_public_is_the_keyword() {
    assert_eq!(grantee("PUBLIC"), "PUBLIC");
    assert_eq!(grantee("alice"), "\"alice\"");
    // 다른 철자는 식별자로 감싼다. `Public`은 보통 역할의 이름이다. 소문자 `public`도 감싸 주지만, 서버는 따옴표를 친 "public"을 PUBLIC(모든 역할)으로 읽는다:
    // 이 함수는 그것을 막지 못하니 부르는 쪽이 스냅숏의 역할 이름이나 글자 그대로의 PUBLIC만 넘긴다(서버의 규칙은 라이브 시험이 붙들어 둔다).
    // 반대로 이름이 `PUBLIC`인 역할은 만들 수 있지만 이 함수로는 가리킬 수 없다: "PUBLIC"은 늘 키워드다
    assert_eq!(grantee("public"), "\"public\"");
    assert_eq!(grantee("Public"), "\"Public\"");
    // 이름 안에 든 PUBLIC은 키워드가 아니다
    assert_eq!(grantee("PUBLIC; DROP"), "\"PUBLIC; DROP\"");
}
