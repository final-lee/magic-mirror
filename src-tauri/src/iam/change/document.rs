//! 정책 문서와 이름 검사: JSON 문법, 크기 한도, 인라인 정책 이름. AWS가 거절할 것이 뻔한 입력을 미리 막는다.

use super::IamChange;
use crate::iam::eval::find_principal;
use crate::iam::model::Snapshot;
use crate::iam::policy::{decode_document, parse_document};
use crate::iam::view::PrincipalKind;

/// 관리형 정책 문서의 한도(공백을 뺀 글자 수).
pub(super) const MANAGED_LIMIT: usize = 6_144;
/// 인라인 정책 이름의 최대 길이.
pub(super) const MAX_NAME: usize = 128;

/// AWS가 세는 정책 크기: 공백을 뺀 글자 수. 들여쓴 JSON을 그대로 보내도 한도에 영향이 없다.
pub(super) fn size(document: &str) -> usize {
    document.chars().filter(|c| !c.is_whitespace()).count()
}

/// 한 사용자·그룹·역할에 붙은 인라인 정책 전체의 한도(공백을 뺀 글자 수).
fn inline_limit(kind: PrincipalKind) -> usize {
    match kind {
        PrincipalKind::User => 2_048,
        PrincipalKind::Group => 5_120,
        PrincipalKind::Role => 10_240,
    }
}

fn kind_label(kind: PrincipalKind) -> &'static str {
    match kind {
        PrincipalKind::User => "사용자",
        PrincipalKind::Group => "그룹",
        PrincipalKind::Role => "역할",
    }
}

/// 천 단위로 쉼표를 찍는다(6144 → "6,144").
fn commas(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, digit) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// 인라인 정책 이름 규칙(영문자·숫자·`+=,.@_-`, 1~128자)을 어기면 그 이유.
pub(super) fn name_problem(name: &str) -> Option<String> {
    if name.is_empty() {
        return Some("인라인 정책 이름을 입력해야 해요".to_string());
    }
    if name.chars().count() > MAX_NAME {
        return Some(format!("인라인 정책 이름은 {MAX_NAME}자까지 쓸 수 있어요"));
    }
    if !name.bytes().all(|b| b.is_ascii_alphanumeric() || b"_+=,.@-".contains(&b)) {
        return Some("인라인 정책 이름에는 영문자, 숫자, + = , . @ _ - 만 쓸 수 있어요".to_string());
    }
    None
}

/// 인라인 정책을 넣은 뒤의 크기가 한도를 넘으면 그 이유. 같은 이름으로 덮어쓰는 이전 정책은 빼고 센다.
fn inline_size_problem(s: &Snapshot, target: &str, name: &str, document: &str) -> Option<String> {
    let principal = find_principal(s, target)?;
    let others: usize = principal.inline().iter().filter(|p| !p.name.eq_ignore_ascii_case(name)).map(|p| size(&decode_document(&p.raw))).sum();
    let this = size(document);
    let (limit, total) = (inline_limit(principal.kind()), others + this);
    (total > limit).then(|| {
        let split = if others > 0 { format!(" (다른 인라인 정책 {}자 + 이 정책 {}자)", commas(others), commas(this)) } else { String::new() };
        format!(
            "{} 인라인 정책은 모두 합쳐 공백을 뺀 {}자까지 쓸 수 있어요. 이 변경 뒤에는 {}자예요{split}",
            kind_label(principal.kind()),
            commas(limit),
            commas(total)
        )
    })
}

/// 변경에 실린 정책 문서·이름이 막혀야 하는 이유들(한국어). 문서를 싣지 않는 변경은 빈 목록이다.
/// 인라인 정책의 한도는 한 사용자·그룹·역할에 붙은 인라인 정책 전체의 합이므로, 같은 이름으로 덮어쓰는 이전 문서는 빼고 센다.
pub(super) fn problems(s: &Snapshot, c: &IamChange) -> Vec<String> {
    let mut out = Vec::new();
    match c {
        IamChange::PutInlinePolicy { target, name, document } => {
            out.extend(name_problem(name));
            out.extend(parse_document(document).err());
            out.extend(inline_size_problem(s, target, name, document));
        }
        IamChange::UpdateManagedPolicy { document, .. } => {
            out.extend(parse_document(document).err());
            let n = size(document);
            if n > MANAGED_LIMIT {
                out.push(format!("정책 문서가 너무 커요. 공백을 뺀 글자 수가 {}자인데, 관리형 정책은 {}자까지 쓸 수 있어요", commas(n), commas(MANAGED_LIMIT)));
            }
        }
        _ => {}
    }
    out
}
