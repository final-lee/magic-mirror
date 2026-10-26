//! 자격 증명 보고서(CSV) 읽기. 열은 위치가 아니라 머리글 이름으로 찾는다.

use crate::iam::model::CredRow;

/// 보고서에서 "값이 없다"는 뜻으로 쓰는 말.
fn is_missing(value: &str) -> bool {
    let value = value.trim();
    value.is_empty() || ["N/A", "no_information", "not_supported"].iter().any(|missing| value.eq_ignore_ascii_case(missing))
}

fn time_value(value: &str) -> Option<String> {
    (!is_missing(value)).then(|| value.trim().to_string())
}

/// `true`만 켜짐이다. `false`와 `not_supported`(루트의 비밀번호)는 꺼짐이다.
fn flag(value: &str) -> bool {
    value.trim().eq_ignore_ascii_case("true")
}

/// 따옴표(`"a,b"`, `""`)를 알아보는 CSV 한 줄 나누기.
fn split_line(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if quoted && chars.peek() == Some(&'"') => {
                current.push('"');
                chars.next();
            }
            '"' => quoted = !quoted,
            ',' if !quoted => fields.push(std::mem::take(&mut current)),
            c => current.push(c),
        }
    }
    fields.push(current);
    fields
}

#[derive(Clone, Copy)]
struct KeyColumns {
    active: Option<usize>,
    rotated: Option<usize>,
    last_used: Option<usize>,
}

struct Columns {
    width: usize,
    user: usize,
    arn: usize,
    created: Option<usize>,
    password_enabled: Option<usize>,
    password_last_used: Option<usize>,
    mfa: Option<usize>,
    keys: [KeyColumns; 2],
}

impl Columns {
    /// `user`와 `arn` 열이 없으면 쓸 수 없는 보고서다.
    fn from_header(header: &[String]) -> Option<Columns> {
        let find = |name: &str| header.iter().position(|h| h.trim().eq_ignore_ascii_case(name));
        let key = |n: u8| KeyColumns {
            active: find(&format!("access_key_{n}_active")),
            rotated: find(&format!("access_key_{n}_last_rotated")),
            last_used: find(&format!("access_key_{n}_last_used_date")),
        };
        Some(Columns {
            width: header.len(),
            user: find("user")?,
            arn: find("arn")?,
            created: find("user_creation_time"),
            password_enabled: find("password_enabled"),
            password_last_used: find("password_last_used"),
            mfa: find("mfa_active"),
            keys: [key(1), key(2)],
        })
    }
}

/// 사용자 이름에는 쉼표를 쓸 수 있다. 따옴표 없이 적혀 열이 남으면 이름과 ARN(둘 다 이름으로 끝난다)을 다시 합친다.
/// 맞지 않으면 None이다.
fn rejoin_commas(mut fields: Vec<String>, cols: &Columns) -> Option<Vec<String>> {
    let extra = fields.len() - cols.width;
    if !extra.is_multiple_of(2) || cols.user != 0 || cols.arn != 1 {
        return None;
    }
    let k = extra / 2;
    let user = fields[..=k].join(",");
    let arn = fields[k + 1..=2 * k + 1].join(",");
    if !arn.ends_with(&user) {
        return None;
    }
    let mut merged = vec![user, arn];
    merged.extend(fields.drain(2 * k + 2..));
    Some(merged)
}

fn parse_row(cols: &Columns, mut fields: Vec<String>) -> Option<CredRow> {
    if fields.len() > cols.width {
        fields = rejoin_commas(fields, cols)?;
    }
    if fields.len() < cols.width {
        return None;
    }
    let get = |column: Option<usize>| column.map_or("", |i| fields[i].as_str());
    let key = |k: KeyColumns| (flag(get(k.active)), time_value(get(k.rotated)), time_value(get(k.last_used)));
    let (key1_active, key1_rotated, key1_last_used) = key(cols.keys[0]);
    let (key2_active, key2_rotated, key2_last_used) = key(cols.keys[1]);
    Some(CredRow {
        user: fields[cols.user].trim().to_string(),
        arn: fields[cols.arn].trim().to_string(),
        created_at: time_value(get(cols.created)),
        password_enabled: flag(get(cols.password_enabled)),
        password_last_used: time_value(get(cols.password_last_used)),
        mfa_active: flag(get(cols.mfa)),
        key1_active,
        key1_rotated,
        key1_last_used,
        key2_active,
        key2_rotated,
        key2_last_used,
    })
}

/// `read_credential_report`에서 줄만(테스트에서 보고서를 만들 때 쓴다).
#[cfg(test)]
pub fn parse_credential_report(csv: &str) -> Vec<CredRow> {
    read_credential_report(csv).0
}

/// `GetCredentialReport`가 돌려준 CSV를 사용자 한 명당 한 줄로 읽는다(루트 `<root_account>` 포함).
/// 값이 `N/A`·`no_information`·`not_supported`면 None이고, 형식이 맞지 않는 줄은 건너뛰고 그 수(빈 줄 제외)를 함께 돌려준다.
/// 건너뛴 사용자는 점검에서 빠지므로 그 수를 경고로 알린다.
pub fn read_credential_report(csv: &str) -> (Vec<CredRow>, usize) {
    let mut lines = csv.trim_start_matches('\u{feff}').lines().filter(|line| !line.trim().is_empty());
    let Some(cols) = lines.next().and_then(|header| Columns::from_header(&split_line(header))) else {
        return (Vec::new(), 0);
    };
    let mut rows = Vec::new();
    let mut unreadable = 0;
    for line in lines {
        match parse_row(&cols, split_line(line)) {
            Some(row) => rows.push(row),
            None => unreadable += 1,
        }
    }
    (rows, unreadable)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::iam::findings::sample::*;

    fn parsed() -> Vec<CredRow> {
        parse_credential_report(&csv())
    }

    fn user<'a>(rows: &'a [CredRow], name: &str) -> &'a CredRow {
        rows.iter().find(|r| r.user == name).unwrap_or_else(|| panic!("{name} 행이 없어요"))
    }

    fn some(text: String) -> Option<String> {
        Some(text)
    }

    #[test]
    fn parses_every_row_in_order() {
        let rows = parsed();
        let names: Vec<&str> = rows.iter().map(|r| r.user.as_str()).collect();
        assert_eq!(names, vec!["<root_account>", "alice", "bob", "carol", "dave", "erin", "frank", "gina"]);
    }

    #[test]
    fn root_row_keeps_not_supported_out_of_the_values() {
        let rows = parsed();
        let root = user(&rows, "<root_account>");
        assert_eq!(root.arn, ROOT_ARN);
        assert_eq!(root.created_at, some(ago(3000)));
        // `not_supported`는 비밀번호를 쓸 수 없다는 뜻이라 꺼짐으로 읽는다
        assert!(!root.password_enabled);
        assert_eq!(root.password_last_used, some(ago(5)));
        assert!(!root.mfa_active);
        assert!(root.key1_active);
        assert_eq!(root.key1_rotated, some(ago(400)));
        assert_eq!(root.key1_last_used, None);
        assert!(!root.key2_active);
        assert_eq!((root.key2_rotated.clone(), root.key2_last_used.clone()), (None, None));
    }

    #[test]
    fn a_normal_user_has_dates_and_flags() {
        let rows = parsed();
        let alice = user(&rows, "alice");
        assert_eq!(alice.arn, user_arn("alice"));
        assert_eq!(alice.created_at, some(ago(500)));
        assert!(alice.password_enabled && alice.mfa_active && alice.key1_active);
        assert_eq!(alice.password_last_used, some(ago(2)));
        assert_eq!(alice.key1_rotated, some(ago(200)));
        assert_eq!(alice.key1_last_used, some(ago(1)));
        let gina = user(&rows, "gina");
        assert!(!gina.key1_active);
        assert_eq!((gina.key1_rotated.clone(), gina.key1_last_used.clone()), (some(ago(250)), some(ago(40))));
    }

    #[test]
    fn na_and_no_information_are_none() {
        let rows = parsed();
        assert_eq!(user(&rows, "bob").key1_last_used, None);
        assert_eq!(user(&rows, "dave").password_last_used, None);
        let erin = user(&rows, "erin");
        assert!(erin.password_enabled);
        assert_eq!(erin.password_last_used, None);
        assert_eq!(erin.key1_rotated, None);
    }

    #[test]
    fn not_supported_is_no_value_in_a_time_column_too() {
        let row = line("zed", &user_arn("zed"), "not_supported".to_string(), ("true", "not_supported".to_string()), "true", ("true", "not_supported".to_string(), "no_information".to_string()), no_key());
        let rows = parse_credential_report(&format!("{HEADER}\n{row}\n"));
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].created_at.clone(), rows[0].password_last_used.clone()), (None, None));
        assert_eq!((rows[0].key1_rotated.clone(), rows[0].key1_last_used.clone()), (None, None));
        assert!(rows[0].password_enabled && rows[0].key1_active);
    }

    #[test]
    fn crlf_line_endings_bom_and_blank_lines() {
        let text = format!("\u{feff}{}\r\n\r\n{}\r\n\r\n", HEADER, rows()[1]);
        let rows = parse_credential_report(&text);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].user, "alice");
        assert_eq!(rows[0].key1_last_used, some(ago(1)));
    }

    #[test]
    fn columns_are_found_by_header_name_not_position() {
        let header = "mfa_active,arn,user,password_enabled,extra_column";
        let text = format!("{header}\ntrue,{},alice,true,whatever\nfalse,{},bob,false,x\n", user_arn("alice"), user_arn("bob"));
        let rows = parse_credential_report(&text);
        assert_eq!(rows.len(), 2);
        assert_eq!((rows[0].user.as_str(), rows[0].mfa_active, rows[0].password_enabled), ("alice", true, true));
        assert_eq!((rows[1].user.as_str(), rows[1].mfa_active, rows[1].password_enabled), ("bob", false, false));
        // 없는 열은 꺼짐·None이다
        assert!(!rows[0].key1_active);
        assert_eq!(rows[0].created_at, None);
    }

    #[test]
    fn user_names_may_contain_commas_quoted_or_not() {
        let arn = user_arn("a,b");
        let plain = line("a,b", &arn, ago(100), ("true", ago(3)), "true", ("true", ago(10), ago(2)), no_key());
        let quoted = plain.replacen(&format!("a,b,{arn},"), &format!("\"a,b\",\"{arn}\","), 1);
        assert!(quoted.starts_with("\"a,b\",\""), "{quoted}");
        for row in [plain, quoted] {
            let zed = line("zed", &user_arn("zed"), ago(5), ("false", na()), "false", no_key(), no_key());
            let rows = parse_credential_report(&format!("{HEADER}\n{row}\n{zed}\n"));
            assert_eq!(rows.len(), 2, "{row}");
            assert_eq!((rows[0].user.as_str(), rows[0].arn.as_str()), ("a,b", arn.as_str()));
            assert_eq!(rows[0].created_at, some(ago(100)));
            assert!(rows[0].password_enabled && rows[0].mfa_active && rows[0].key1_active);
            assert_eq!(rows[0].key1_last_used, some(ago(2)));
            assert_eq!(rows[1].user, "zed");
        }
    }

    #[test]
    fn rows_that_do_not_line_up_are_skipped() {
        let good = rows()[1].clone();
        let short = "short,arn:aws:iam::111111111111:user/short,2020-01-01T00:00:00+00:00";
        // 열이 남는데 이름과 ARN이 맞지 않는 줄
        let odd = format!("{},EXTRA", rows()[2]);
        let rows = parse_credential_report(&format!("{HEADER}\n{short}\n{odd}\n{good}\n"));
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].user, "alice");
    }

    #[test]
    fn skipped_rows_are_counted_so_they_can_be_reported() {
        let good = rows()[1].clone();
        let short = "short,arn:aws:iam::111111111111:user/short,2020-01-01T00:00:00+00:00";
        let odd = format!("{},EXTRA", rows()[2]);
        // 빈 줄은 읽지 못한 줄이 아니다
        let (read, unreadable) = read_credential_report(&format!("{HEADER}\n{short}\n\n{odd}\r\n{good}\n\n"));
        assert_eq!((read.len(), unreadable), (1, 2));
        assert_eq!(read[0].user, "alice");
        let (all, none) = read_credential_report(&csv());
        assert_eq!((all.len(), none), (parsed().len(), 0));
        for empty in ["", HEADER] {
            let (read, unreadable) = read_credential_report(empty);
            assert!(read.is_empty() && unreadable == 0, "{empty:?}");
        }
    }

    #[test]
    fn empty_or_unusable_input_gives_no_rows() {
        assert!(parse_credential_report("").is_empty());
        assert!(parse_credential_report(HEADER).is_empty());
        assert!(parse_credential_report("foo,bar\n1,2\n").is_empty());
    }
}
