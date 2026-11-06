export type DiffKind = "same" | "add" | "del";

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

/** 이 칸 수(바뀐 구간 줄 수의 곱)를 넘으면 정밀하게 맞추지 않고 구간 전체를 지웠다 새로 쓴 것으로 본다 */
const MAX_CELLS = 4_000_000;

const lines = (text: string) => (text === "" ? [] : text.replace(/\r\n/g, "\n").split("\n"));

/** 두 글의 줄 단위 차이. 앞뒤의 같은 줄은 그대로 두고 가운데만 최장 공통 부분열로 맞춘다. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = lines(before);
  const b = lines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const out: DiffLine[] = a.slice(0, head).map((text) => ({ kind: "same", text }));
  out.push(...middle(midA, midB));
  out.push(...a.slice(a.length - tail).map((text): DiffLine => ({ kind: "same", text })));
  return out;
}

function middle(a: string[], b: string[]): DiffLine[] {
  const del = (list: string[]): DiffLine[] => list.map((text) => ({ kind: "del", text }));
  const add = (list: string[]): DiffLine[] => list.map((text) => ({ kind: "add", text }));
  if (a.length === 0 || b.length === 0 || a.length * b.length > MAX_CELLS) return [...del(a), ...add(b)];

  // lcs[i][j] = a[i..]와 b[j..]의 최장 공통 부분열 길이
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i] === b[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      out.push({ kind: "del", text: a[i++] });
    } else {
      out.push({ kind: "add", text: b[j++] });
    }
  }
  return [...out, ...del(a.slice(i)), ...add(b.slice(j))];
}

export function diffStats(diff: DiffLine[]): { added: number; removed: number } {
  return { added: diff.filter((l) => l.kind === "add").length, removed: diff.filter((l) => l.kind === "del").length };
}

export type DiffRow = DiffLine | { kind: "gap"; hidden: number };

/** 바뀐 줄 둘레 `context`줄만 남기고 나머지 같은 줄은 "n줄 생략"으로 접는다. */
export function withContext(diff: DiffLine[], context = 2): DiffRow[] {
  const near = diff.map((_, i) => diff.slice(Math.max(0, i - context), i + context + 1).some((l) => l.kind !== "same"));
  const rows: DiffRow[] = [];
  diff.forEach((line, i) => {
    if (near[i]) rows.push(line);
    else {
      const last = rows[rows.length - 1];
      if (last?.kind === "gap") last.hidden++;
      else rows.push({ kind: "gap", hidden: 1 });
    }
  });
  return rows;
}
