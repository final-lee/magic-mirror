import { diffStats, lineDiff, withContext } from "./lineDiff";

const show = (before: string, after: string) => lineDiff(before, after).map((l) => `${l.kind === "same" ? " " : l.kind === "add" ? "+" : "-"}${l.text}`);

describe("lineDiff", () => {
  test("같은 글은 모두 같은 줄이에요", () => {
    expect(show("a\nb", "a\nb")).toEqual([" a", " b"]);
    expect(show("", "")).toEqual([]);
  });

  test("바뀐 줄은 지우고 새로 쓴 것으로, 앞뒤 줄은 그대로 둬요", () => {
    expect(show("a\nb\nc", "a\nB\nc")).toEqual([" a", "-b", "+B", " c"]);
  });

  test("끼워 넣은 줄과 뺀 줄은 사이의 같은 줄을 맞춰서 보여요", () => {
    expect(show("a\nb\nc\nd", "a\nx\nb\nd\ny")).toEqual([" a", "+x", " b", "-c", " d", "+y"]);
  });

  test("빈 글에서 시작하거나 빈 글로 끝나면 전부 추가·삭제예요", () => {
    expect(show("", "a\nb")).toEqual(["+a", "+b"]);
    expect(show("a\nb", "")).toEqual(["-a", "-b"]);
  });

  test("줄바꿈 CRLF는 LF와 같게 봐요", () => {
    expect(diffStats(lineDiff("a\r\nb", "a\nb"))).toEqual({ added: 0, removed: 0 });
  });

  test("아주 큰 바뀐 구간도 멈추지 않고 전부 바뀐 것으로 봐요", () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join("\n");
    expect(diffStats(lineDiff(a, b))).toEqual({ added: 3000, removed: 3000 });
  });
});

describe("withContext", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join("\n");

  test("바뀐 줄 둘레 두 줄만 남기고 나머지는 줄 수를 센 한 칸으로 접어요", () => {
    const rows = withContext(lineDiff(lines(20), lines(20).replace("l10", "X")));
    expect(rows.map((r) => (r.kind === "gap" ? `gap${r.hidden}` : `${r.kind}:${r.text}`))).toEqual([
      "gap8",
      "same:l8",
      "same:l9",
      "del:l10",
      "add:X",
      "same:l11",
      "same:l12",
      "gap7",
    ]);
  });

  test("바뀐 것이 없으면 전부 접혀요", () => {
    expect(withContext(lineDiff("a\nb\nc", "a\nb\nc"))).toEqual([{ kind: "gap", hidden: 3 }]);
  });
});
