use std::ops::Range;
use std::time::Duration;

use serde::Serialize;
use similar::{ChangeTag, DiffTag, TextDiff as SimilarDiff};

use super::textfile::{Content, SideMeta};

pub const COLLAPSE_MIN: usize = 20;
pub const CONTEXT: usize = 3;
/// 이보다 긴 줄 쌍은 글자 단위 강조 없이 줄 전체를 강조한다(압축된 JS 등에서 느려지지 않도록).
const INLINE_MAX: usize = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RowKind {
    Equal,
    Insert,
    Delete,
    Replace,
    Collapsed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Segment {
    pub text: String,
    pub emph: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DiffLine {
    pub no: usize,
    pub segments: Vec<Segment>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffRow {
    pub kind: RowKind,
    pub left: Option<DiffLine>,
    pub right: Option<DiffLine>,
    pub hidden_rows: Vec<DiffRow>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct DiffStats {
    pub added: usize,
    pub removed: usize,
    pub changed: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TextDiff {
    pub rows: Vec<DiffRow>,
    pub hunks: Vec<usize>,
    pub stats: DiffStats,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffMode {
    Text,
    Meta,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Same,
    Different,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResult {
    pub left: SideMeta,
    pub right: SideMeta,
    pub mode: DiffMode,
    pub rows: Vec<DiffRow>,
    pub hunks: Vec<usize>,
    pub stats: DiffStats,
    pub meta_verdict: Option<Verdict>,
    pub reason: Option<String>,
}

fn line(no: usize, segments: Vec<Segment>) -> Option<DiffLine> {
    Some(DiffLine { no, segments })
}

fn plain(text: &str) -> Vec<Segment> {
    vec![Segment { text: text.to_string(), emph: false }]
}

fn row(kind: RowKind, left: Option<DiffLine>, right: Option<DiffLine>) -> DiffRow {
    DiffRow { kind, left, right, hidden_rows: Vec::new() }
}

fn push_seg(v: &mut Vec<Segment>, text: &str, emph: bool) {
    if let Some(last) = v.last_mut() {
        if last.emph == emph {
            last.text.push_str(text);
            return;
        }
    }
    v.push(Segment { text: text.to_string(), emph });
}

/// 한 줄 쌍의 글자 단위 차이를 강조 구간으로 만든다.
fn inline(a: &str, b: &str) -> (Vec<Segment>, Vec<Segment>) {
    if a.len() + b.len() > INLINE_MAX {
        return (vec![Segment { text: a.into(), emph: true }], vec![Segment { text: b.into(), emph: true }]);
    }
    let d = SimilarDiff::from_chars(a, b);
    let (mut l, mut r) = (Vec::new(), Vec::new());
    for ch in d.iter_all_changes() {
        match ch.tag() {
            ChangeTag::Equal => {
                push_seg(&mut l, ch.value(), false);
                push_seg(&mut r, ch.value(), false);
            }
            ChangeTag::Delete => push_seg(&mut l, ch.value(), true),
            ChangeTag::Insert => push_seg(&mut r, ch.value(), true),
        }
    }
    (l, r)
}

fn push_replace(rows: &mut Vec<DiffRow>, stats: &mut DiffStats, o: Range<usize>, n: Range<usize>, old: &[&str], new: &[&str]) {
    let pairs = o.len().min(n.len());
    for k in 0..pairs {
        let (a, b) = (o.start + k, n.start + k);
        let (l, r) = inline(old[a], new[b]);
        rows.push(row(RowKind::Replace, line(a + 1, l), line(b + 1, r)));
        stats.changed += 1;
    }
    for (a, text) in old.iter().enumerate().take(o.end).skip(o.start + pairs) {
        rows.push(row(RowKind::Delete, line(a + 1, plain(text)), None));
        stats.removed += 1;
    }
    for (b, text) in new.iter().enumerate().take(n.end).skip(n.start + pairs) {
        rows.push(row(RowKind::Insert, None, line(b + 1, plain(text))));
        stats.added += 1;
    }
}

fn flush_equal(run: &mut Vec<DiffRow>, out: &mut Vec<DiffRow>) {
    if run.len() > COLLAPSE_MIN {
        let tail = run.split_off(run.len() - CONTEXT);
        let middle = run.split_off(CONTEXT);
        out.append(run);
        out.push(DiffRow { kind: RowKind::Collapsed, left: None, right: None, hidden_rows: middle });
        out.extend(tail);
    } else {
        out.append(run);
    }
}

fn collapse(rows: Vec<DiffRow>) -> Vec<DiffRow> {
    let mut out = Vec::new();
    let mut run = Vec::new();
    for r in rows {
        if r.kind == RowKind::Equal {
            run.push(r);
        } else {
            flush_equal(&mut run, &mut out);
            out.push(r);
        }
    }
    flush_equal(&mut run, &mut out);
    out
}

fn hunk_starts(rows: &[DiffRow]) -> Vec<usize> {
    let quiet = |k: RowKind| k == RowKind::Equal || k == RowKind::Collapsed;
    (0..rows.len())
        .filter(|&i| !quiet(rows[i].kind) && (i == 0 || quiet(rows[i - 1].kind)))
        .collect()
}

pub fn build_text_diff(old: &str, new: &str) -> TextDiff {
    let old_lines: Vec<&str> = old.lines().collect();
    let new_lines: Vec<&str> = new.lines().collect();
    let diff = SimilarDiff::configure()
        .timeout(Duration::from_secs(2))
        .diff_slices(&old_lines, &new_lines);
    let ops = diff.ops();
    let mut rows = Vec::new();
    let mut stats = DiffStats::default();
    let mut i = 0;
    while i < ops.len() {
        let (tag, o, n) = ops[i].as_tag_tuple();
        match tag {
            DiffTag::Equal => {
                for (a, b) in o.zip(n) {
                    rows.push(row(RowKind::Equal, line(a + 1, plain(old_lines[a])), line(b + 1, plain(new_lines[b]))));
                }
            }
            DiffTag::Delete => {
                if let Some((DiffTag::Insert, _, n2)) = ops.get(i + 1).map(|op| op.as_tag_tuple()) {
                    push_replace(&mut rows, &mut stats, o, n2, &old_lines, &new_lines);
                    i += 2;
                    continue;
                }
                for a in o {
                    rows.push(row(RowKind::Delete, line(a + 1, plain(old_lines[a])), None));
                    stats.removed += 1;
                }
            }
            DiffTag::Insert => {
                for b in n {
                    rows.push(row(RowKind::Insert, None, line(b + 1, plain(new_lines[b]))));
                    stats.added += 1;
                }
            }
            DiffTag::Replace => push_replace(&mut rows, &mut stats, o, n, &old_lines, &new_lines),
        }
        i += 1;
    }
    let rows = collapse(rows);
    let hunks = hunk_starts(&rows);
    TextDiff { rows, hunks, stats }
}

/// 크기가 다르면 다름, 같고 MD5가 둘 다 있으면 비교, 아니면 판단 불가.
pub fn meta_verdict(left: &SideMeta, right: &SideMeta) -> Verdict {
    if left.size != right.size {
        return Verdict::Different;
    }
    match (&left.md5, &right.md5) {
        (Some(a), Some(b)) if a == b => Verdict::Same,
        (Some(_), Some(_)) => Verdict::Different,
        _ => Verdict::Unknown,
    }
}

/// 양쪽이 텍스트면 줄 단위 비교, 아니면 메타데이터 비교(호출자가 md5를 채워 둔다).
pub fn assemble(left: SideMeta, lc: Content, right: SideMeta, rc: Content) -> DiffResult {
    if let (Content::Text(a), Content::Text(b)) = (&lc, &rc) {
        let d = build_text_diff(a, b);
        return DiffResult {
            left, right, mode: DiffMode::Text, rows: d.rows, hunks: d.hunks, stats: d.stats,
            meta_verdict: None, reason: None,
        };
    }
    let reason = if lc == Content::Binary || rc == Content::Binary { "binary" } else { "tooLarge" };
    let verdict = meta_verdict(&left, &right);
    DiffResult {
        left, right, mode: DiffMode::Meta, rows: Vec::new(), hunks: Vec::new(), stats: DiffStats::default(),
        meta_verdict: Some(verdict), reason: Some(reason.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(d: &TextDiff) -> Vec<RowKind> {
        d.rows.iter().map(|r| r.kind).collect()
    }

    fn meta(size: u64, md5: Option<&str>) -> SideMeta {
        SideMeta { label: "x".into(), size, modified: None, md5: md5.map(str::to_owned) }
    }

    #[test]
    fn identical_text_has_no_changes() {
        let d = build_text_diff("a\nb\n", "a\nb\n");
        assert_eq!(kinds(&d), vec![RowKind::Equal, RowKind::Equal]);
        assert_eq!(d.stats, DiffStats::default());
        assert!(d.hunks.is_empty());
    }

    #[test]
    fn insert_and_delete_rows() {
        let d = build_text_diff("a\nb\n", "a\nx\nb\n");
        assert_eq!(kinds(&d), vec![RowKind::Equal, RowKind::Insert, RowKind::Equal]);
        assert_eq!(d.rows[1].right.as_ref().unwrap().no, 2);
        assert_eq!(d.rows[1].left, None);
        assert_eq!(d.stats.added, 1);
        assert_eq!(d.hunks, vec![1]);

        let d = build_text_diff("a\nb\nc\n", "a\nc\n");
        assert_eq!(kinds(&d), vec![RowKind::Equal, RowKind::Delete, RowKind::Equal]);
        assert_eq!(d.stats.removed, 1);
    }

    #[test]
    fn replace_rows_have_inline_emphasis() {
        let d = build_text_diff("let x = 1;\n", "let x = 2;\n");
        assert_eq!(kinds(&d), vec![RowKind::Replace]);
        let left = &d.rows[0].left.as_ref().unwrap().segments;
        assert_eq!(
            left,
            &vec![
                Segment { text: "let x = ".into(), emph: false },
                Segment { text: "1".into(), emph: true },
                Segment { text: ";".into(), emph: false },
            ]
        );
        assert_eq!(d.stats.changed, 1);
    }

    #[test]
    fn uneven_replace_pairs_then_deletes() {
        let d = build_text_diff("a\nold1\nold2\nz\n", "a\nnew1\nz\n");
        assert_eq!(kinds(&d), vec![RowKind::Equal, RowKind::Replace, RowKind::Delete, RowKind::Equal]);
        assert_eq!(d.hunks, vec![1]);
    }

    #[test]
    fn long_equal_runs_collapse() {
        let same: String = (1..=30).map(|i| format!("line{i}\n")).collect();
        let old = format!("{same}end\n");
        let new = format!("{same}END\n");
        let d = build_text_diff(&old, &new);
        assert_eq!(d.rows.len(), 3 + 1 + 3 + 1);
        assert_eq!(d.rows[3].kind, RowKind::Collapsed);
        assert_eq!(d.rows[3].hidden_rows.len(), 24);
        assert_eq!(d.rows[0].left.as_ref().unwrap().no, 1);
        assert_eq!(d.rows[4].left.as_ref().unwrap().no, 28);
        assert_eq!(d.hunks, vec![7]);
    }

    #[test]
    fn meta_verdict_rules() {
        assert_eq!(meta_verdict(&meta(1, Some("a")), &meta(2, Some("a"))), Verdict::Different);
        assert_eq!(meta_verdict(&meta(1, Some("a")), &meta(1, Some("a"))), Verdict::Same);
        assert_eq!(meta_verdict(&meta(1, Some("a")), &meta(1, Some("b"))), Verdict::Different);
        assert_eq!(meta_verdict(&meta(1, None), &meta(1, Some("b"))), Verdict::Unknown);
    }

    #[test]
    fn assemble_picks_mode() {
        let t = assemble(meta(2, None), Content::Text("a\n".into()), meta(2, None), Content::Text("b\n".into()));
        assert_eq!(t.mode, DiffMode::Text);
        assert_eq!(t.rows.len(), 1);
        assert_eq!(t.meta_verdict, None);

        let b = assemble(meta(3, Some("x")), Content::Binary, meta(3, Some("x")), Content::Text("abc".into()));
        assert_eq!(b.mode, DiffMode::Meta);
        assert_eq!(b.reason.as_deref(), Some("binary"));
        assert_eq!(b.meta_verdict, Some(Verdict::Same));
        assert!(b.rows.is_empty());

        let l = assemble(meta(9, None), Content::TooLarge, meta(9, None), Content::Text("x".into()));
        assert_eq!(l.reason.as_deref(), Some("tooLarge"));
        assert_eq!(l.meta_verdict, Some(Verdict::Unknown));
    }

    #[test]
    fn serializes_camel_case() {
        let d = assemble(meta(1, None), Content::Text("a".into()), meta(1, None), Content::Text("a".into()));
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["mode"], "text");
        assert!(v["rows"][0]["hiddenRows"].is_array());
        assert_eq!(v["rows"][0]["kind"], "equal");
        assert!(v.get("metaVerdict").is_some());
    }
}
