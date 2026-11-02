import { useMemo } from "react";

export type YamlTokenKind = "key" | "str" | "num" | "bool" | "comment" | "punct" | "mask" | "plain";
export interface YamlToken {
  kind: YamlTokenKind;
  text: string;
}

const MASK = "••••";
const NUMBER = /^[-+]?(\d[\d_]*(\.\d*)?([eE][-+]?\d+)?|\.\d+|0x[\da-fA-F]+|0o[0-7]+|\.inf|\.nan)$/;
const BOOL = /^(true|false|null|~|True|False|Null|TRUE|FALSE|NULL)$/;
// 키: 따옴표 문자열이나, `: `·`#` 앞까지의 평문
const KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"{[\]},&*!|>%@`-][^#]*?|-[^\s#][^#]*?)(\s*:)(?=\s|$)/;
const BLOCK = /^[|>][-+0-9]*$/;

/** 값 하나(주석 앞까지)를 갈래에 맞게 */
function scalar(value: string): YamlToken[] {
  const t = value.trim();
  if (t === "") return value ? [{ kind: "plain", text: value }] : [];
  const lead = value.slice(0, value.indexOf(t));
  const tail = value.slice(lead.length + t.length);
  const kind: YamlTokenKind =
    t === MASK || t === `"${MASK}"` || t === `'${MASK}'`
      ? "mask"
      : BLOCK.test(t) || /^[{[\]},]+$/.test(t) || t === "{}" || t === "[]"
        ? "punct"
        : BOOL.test(t)
          ? "bool"
          : NUMBER.test(t)
            ? "num"
            : "str";
  return [...(lead ? [{ kind: "plain" as const, text: lead }] : []), { kind, text: t }, ...(tail ? [{ kind: "plain" as const, text: tail }] : [])];
}

/** 값과 뒤 주석(` #`부터)을 나눈다. 따옴표 안의 `#`은 주석이 아니다. */
function valueAndComment(rest: string): [string, string] {
  let quote: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (quote) {
      if (c === quote && rest[i - 1] !== "\\") quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(rest[i - 1]))) {
      return [rest.slice(0, i), rest.slice(i)];
    }
  }
  return [rest, ""];
}

/**
 * YAML을 줄마다 토큰으로 자른다. 줄의 토큰을 이어 붙이면 원래 줄과 같다(글자를 빼거나 더하지 않는다).
 * 완전한 파서가 아니라 화면 색칠용이다: 키, 문자열, 숫자, 참·거짓·null, 주석, 기호, 블록 문자열(`|`, `>`), 가린 값(••••).
 */
export function tokenizeYaml(text: string): YamlToken[][] {
  const out: YamlToken[][] = [];
  // 블록 문자열(`key: |`)이 시작된 줄의 들여쓰기. 그보다 깊은 줄과 빈 줄은 문자열이다.
  let blockIndent: number | null = null;
  for (const line of text.split("\n")) {
    const indent = line.length - line.trimStart().length;
    if (blockIndent !== null) {
      if (line.trim() === "" || indent > blockIndent) {
        out.push(line ? [{ kind: "str", text: line }] : []);
        continue;
      }
      blockIndent = null;
    }
    const tokens: YamlToken[] = [];
    let rest = line;
    const push = (kind: YamlTokenKind, s: string) => {
      if (s) tokens.push({ kind, text: s });
      rest = rest.slice(s.length);
    };
    push("plain", rest.slice(0, indent));
    if (/^(---|\.\.\.)(\s|$)/.test(rest)) {
      push("punct", rest.slice(0, 3));
    }
    if (rest.startsWith("#")) {
      push("comment", rest);
      out.push(tokens);
      continue;
    }
    // 목록 표시 `- ` (여러 겹일 수 있다)
    for (let m = /^-(\s+|$)/.exec(rest); m; m = /^-(\s+|$)/.exec(rest)) {
      push("punct", "-");
      push("plain", m[1]);
    }
    const key = KEY.exec(rest);
    if (key) {
      push("key", key[1]);
      push("punct", key[2]);
    }
    const [value, comment] = valueAndComment(rest);
    const valueTokens = scalar(value);
    tokens.push(...valueTokens);
    if (comment) tokens.push({ kind: "comment", text: comment });
    if (valueTokens.some((t) => t.kind === "punct" && BLOCK.test(t.text))) blockIndent = indent;
    out.push(tokens);
  }
  return out;
}

/** 테마 색으로 칠한 YAML. 마우스로 고른 글자는 원래 YAML 그대로 복사된다. */
export function YamlView({ text }: { text: string }) {
  const lines = useMemo(() => tokenizeYaml(text), [text]);
  return (
    <pre className="k8s-yaml mono">
      {lines.map((tokens, i) => (
        <span key={i}>
          {tokens.map((t, j) => (t.kind === "plain" ? t.text : <span key={j} className={`y-${t.kind}`}>{t.text}</span>))}
          {i < lines.length - 1 ? "\n" : null}
        </span>
      ))}
    </pre>
  );
}
