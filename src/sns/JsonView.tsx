import type { ReactNode } from "react";

// 문자열(뒤에 `:`가 붙으면 키), true/false/null, 숫자
const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/** 들여쓴 JSON 글을 키·문자열·숫자·값(true/false/null)별로 칠한다. 필터 정책·배달 정책처럼 짧은 JSON용 */
export function JsonView({ value, label }: { value: unknown; label: string }) {
  const text = JSON.stringify(value, null, 2);
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > cursor) parts.push(text.slice(cursor, at));
    const [, str, colon, literal] = m;
    const cls = str ? (colon ? "sns-json-key" : "sns-json-str") : literal ? "sns-json-lit" : "sns-json-num";
    parts.push(
      <span key={at} className={cls}>
        {str ?? m[0]}
      </span>,
    );
    if (colon) parts.push(colon);
    cursor = at + m[0].length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return (
    <pre className="raw sns-json" aria-label={label}>
      {parts}
    </pre>
  );
}
