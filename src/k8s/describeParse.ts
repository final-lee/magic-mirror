/**
 * `kubectl describe` 글을 들여쓰기로 나눈 나무. 들여쓰기는 단계마다 2칸이 아닐 때도 있어(Deployment의 컨테이너는 3칸)
 * 부모보다 깊으면 자식으로 본다.
 */
export type DescribeNode =
  | { t: "field"; key: string; /** 첫 줄 값과 값 열에 맞춘 이어지는 줄(Labels·Annotations·Tolerations) */ value: string[]; children: DescribeNode[] }
  | { t: "table"; headers: string[]; rows: string[][] }
  | { t: "text"; text: string };

const indentOf = (line: string) => line.length - line.trimStart().length;
const blank = (line: string | undefined) => line === undefined || line.trim() === "";
const DASHES = /^\s*-+(\s+-+)*\s*$/;
/** `키:` 또는 `키:  값`. 키에 두 칸 띄움은 없다(있으면 표의 줄이다). 콜론 뒤가 바로 글자면(`--addr=:8080`, URL) 키가 아니다 */
const FIELD = /^(\s*)([^\s:](?:[^:]*[^\s:])?):(?:(\s+)(.*\S))?\s*$/;

function fieldMatch(line: string): { key: string; value: string | null; valueCol: number } | null {
  const m = FIELD.exec(line);
  if (!m || m[2].includes("  ")) return null;
  const value = m[4] ?? null;
  return { key: m[2], value, valueCol: value === null ? -1 : m[1].length + m[2].length + 1 + m[3].length };
}

/** 열의 시작 위치로 줄을 자른다(tabwriter로 맞춘 열) */
function cells(line: string, starts: number[]): string[] {
  return starts.map((s, i) => line.slice(s, i + 1 < starts.length ? starts[i + 1] : undefined).trim());
}

/** 두 칸 이상 띄운 낱말의 시작 위치 */
function columnStarts(line: string): number[] {
  const starts: number[] = [];
  const re = /\S+(?: \S+)*/g;
  for (let m = re.exec(line); m; m = re.exec(line)) starts.push(m.index);
  return starts;
}

/** 줄표 줄이 없는 표(Pod의 Conditions): 머리글이 모두 대문자로 시작하는 낱말이고 같은 들여쓰기의 키 아닌 줄이 뒤따른다 */
function headerOnlyTable(lines: string[], i: number): number[] | null {
  const starts = columnStarts(lines[i]);
  if (starts.length < 2) return null;
  if (!cells(lines[i], starts).every((h) => /^[A-Z][A-Za-z ]*$/.test(h))) return null;
  const next = lines[i + 1];
  if (blank(next) || indentOf(next) !== indentOf(lines[i]) || fieldMatch(next) || DASHES.test(next)) return null;
  return starts;
}

function block(lines: string[], start: number, parentIndent: number): [DescribeNode[], number] {
  const nodes: DescribeNode[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }
    const ind = indentOf(line);
    if (ind <= parentIndent) break;
    // 머리글 + 줄표 줄이면 표
    const dashed = !blank(lines[i + 1]) && indentOf(lines[i + 1]) === ind && DASHES.test(lines[i + 1]);
    const starts = dashed ? columnStarts(lines[i + 1]) : fieldMatch(line) ? null : headerOnlyTable(lines, i);
    if (starts) {
      const headers = cells(line, starts);
      const rows: string[][] = [];
      let j = i + (dashed ? 2 : 1);
      while (j < lines.length && !blank(lines[j]) && indentOf(lines[j]) >= ind) rows.push(cells(lines[j++], starts));
      nodes.push({ t: "table", headers, rows });
      i = j;
      continue;
    }
    const field = fieldMatch(line);
    if (!field) {
      nodes.push({ t: "text", text: line.trim() });
      i++;
      continue;
    }
    const value = field.value === null ? [] : [field.value];
    let j = i + 1;
    // 값 열에 맞춘 줄은 같은 값의 이어지는 줄이다
    if (field.value !== null) {
      while (j < lines.length && !blank(lines[j]) && indentOf(lines[j]) >= field.valueCol) value.push(lines[j++].trim());
    }
    const [children, next] = block(lines, j, ind);
    nodes.push({ t: "field", key: field.key, value, children });
    i = next;
  }
  return [nodes, i];
}

export function parseDescribe(text: string): DescribeNode[] {
  const lines = text.replace(/\r/g, "").split("\n");
  const nodes: DescribeNode[] = [];
  let i = 0;
  // 맨 위 줄이 들여쓰기 없이 시작하지 않는 이상한 글도 잃지 않게 끝까지 읽는다
  while (i < lines.length) {
    const [part, next] = block(lines, i, -1);
    nodes.push(...part);
    i = next === i ? i + 1 : next;
  }
  return nodes;
}
