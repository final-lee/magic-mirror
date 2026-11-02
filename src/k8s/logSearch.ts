import { createElement, type ReactNode } from "react";

/** 대소문자를 가리지 않는 찾기. 원래 글의 위치로 맞추므로(소문자로 바꾸면 길이가 달라지는 글자가 있다) 정규식으로 찾는다. */
export function searchPattern(query: string): RegExp | null {
  return query ? new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu") : null;
}

/** 줄 안의 일치를 원래 글의 [시작, 끝]으로 */
export function matchRanges(line: string, re: RegExp): [number, number][] {
  const out: [number, number][] = [];
  re.lastIndex = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    out.push([m.index, m.index + m[0].length]);
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

/** 일치하는 곳을 <mark>로 감싼 조각들. 찾는 말이 없거나 일치가 없으면 글 그대로 */
export function highlight(text: string, re: RegExp | null): ReactNode {
  const ranges = re ? matchRanges(text, re) : [];
  if (ranges.length === 0) return text;
  const out: ReactNode[] = [];
  let at = 0;
  for (const [from, to] of ranges) {
    if (from > at) out.push(text.slice(at, from));
    out.push(createElement("mark", { key: from }, text.slice(from, to)));
    at = to;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}
