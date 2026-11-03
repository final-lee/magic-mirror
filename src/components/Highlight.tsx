import type { ReactNode } from "react";
import { highlightIndices, normalize } from "../lib/fuzzy";

/** 퍼지 검색에서 맞은 글자를 <mark>로 칠한다. tokens는 tokenize(검색어)다. 맞은 곳이 없으면 글자만 그린다. */
export function Highlight({ text, tokens }: { text: string; tokens: readonly string[] }) {
  const at = tokens.length > 0 ? highlightIndices(tokens, text) : [];
  if (at.length === 0) return <>{text}</>;
  // 위치는 NFC 기준이라 NFC로 그린다(눈에는 같다)
  const shown = normalize(text);
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < at.length; ) {
    let end = i;
    while (end + 1 < at.length && at[end + 1] === at[end] + 1) end++;
    if (at[i] > cursor) parts.push(shown.slice(cursor, at[i]));
    parts.push(
      <mark key={at[i]} className="hl">
        {shown.slice(at[i], at[end] + 1)}
      </mark>,
    );
    cursor = at[end] + 1;
    i = end + 1;
  }
  if (cursor < shown.length) parts.push(shown.slice(cursor));
  return <>{parts}</>;
}
