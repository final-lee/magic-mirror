import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { desktop } from "../api/desktop";
import { binary, bytes } from "./fixtures";
import { ValueViewer } from "./ValueViewer";
import type { KvValue } from "./types";

vi.mock("../api/desktop", () => ({ desktop: { copy: vi.fn(async () => {}), openUrl: vi.fn() } }));

function show(value: KvValue, over: Partial<React.ComponentProps<typeof ValueViewer>> = {}) {
  const onMore = vi.fn();
  render(<ValueViewer value={value} total={null} hasMore={false} fetching={false} onMore={onMore} {...over} />);
  return { onMore };
}

describe("strings", () => {
  test("plain text is shown as it is, with its size", () => {
    show({ type: "string", value: bytes("hello valkey"), truncated: false });
    expect(screen.getByText("hello valkey")).toBeInTheDocument();
    expect(screen.getByText("12바이트")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "JSON" })).not.toBeInTheDocument();
  });

  test("JSON opens as a tree that folds and unfolds, with the text view next to it", () => {
    const doc = '{"id":42,"owner":{"team":{"name":"kim"}}}';
    show({ type: "string", value: bytes(doc), truncated: false });
    expect(screen.getByRole("button", { name: "JSON" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText('"id"')).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    // 처음에는 두 단계까지 펼쳐 있다: owner(1)는 열려 있고, team(2)은 접혀 있다
    expect(screen.getByText('"team"')).toBeInTheDocument();
    expect(screen.queryByText('"name"')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /"team"/ }));
    expect(screen.getByText('"name"')).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /"team"/ }));
    expect(screen.queryByText('"name"')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "모두 펼치기" }));
    expect(screen.getByText('"name"')).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "모두 접기" }));
    expect(screen.getByText('"id"')).toBeInTheDocument();
    expect(screen.queryByText('"team"')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "텍스트" }));
    expect(screen.getByText(doc)).toBeInTheDocument();
  });

  test("a binary string shows hex first and Base64 next, never as text", () => {
    show({ type: "string", value: binary(0xff, 0xfe, 0x00, 0x41), truncated: false });
    expect(screen.queryByRole("button", { name: "텍스트" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "16진수" })).toHaveAttribute("aria-pressed", "true");
    const table = screen.getByRole("table", { name: "16진수" });
    expect(within(table).getByText("ff fe 00 41")).toBeInTheDocument();
    expect(within(table).getByText("...A")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Base64" }));
    expect(screen.getByText("//4AQQ==")).toBeInTheDocument();
  });

  test("copies the exact bytes of the view that is open", async () => {
    show({ type: "string", value: binary(1, 2, 3), truncated: false });
    fireEvent.click(screen.getByRole("button", { name: "Base64" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "값 복사" })));
    expect(desktop.copy).toHaveBeenLastCalledWith("AQID");
    expect(await screen.findByText("복사했어요")).toBeInTheDocument();
  });

  test("a value cut at 1 MiB says so", () => {
    show({ type: "string", value: bytes("abc"), truncated: true });
    expect(screen.getByText("앞 1MiB만 보여요")).toBeInTheDocument();
  });

  test("JSON (ReJSON) values open as a tree too", () => {
    show({ type: "json", text: '{"a":{"b":1}}', truncated: false });
    expect(screen.getByRole("button", { name: "JSON" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText('"a"')).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "16진수" })).not.toBeInTheDocument();
  });

  test("JSON cut off in the middle falls back to text", () => {
    show({ type: "json", text: '{"a":{"b":', truncated: true });
    expect(screen.getByText('{"a":{"b":')).toBeInTheDocument();
    expect(screen.getByText("앞 1MiB만 보여요")).toBeInTheDocument();
  });
});

describe("collections", () => {
  test("a hash is a field and value table, with binary values marked", () => {
    show({ type: "hash", entries: [{ field: bytes("name"), value: bytes("kim") }, { field: bytes("blob"), value: binary(0xde, 0xad) }] }, { total: 2 });
    const table = screen.getByRole("table", { name: "해시 필드" });
    expect(within(table).getByText("name")).toBeInTheDocument();
    expect(within(table).getByText("kim")).toBeInTheDocument();
    expect(within(table).getByText("바이너리")).toBeInTheDocument();
    expect(within(table).getByText("de ad")).toBeInTheDocument();
    expect(screen.getByText("2개 읽음 / 전체 2개")).toBeInTheDocument();
  });

  test("a list shows the index from where it starts", () => {
    show({ type: "list", start: 200, items: [bytes("job-a"), bytes("job-b")] });
    const rows = within(screen.getByRole("table", { name: "리스트 원소" })).getAllByRole("row");
    expect(within(rows[1]).getByText("200")).toBeInTheDocument();
    expect(within(rows[2]).getByText("201")).toBeInTheDocument();
  });

  test("a set lists its members", () => {
    show({ type: "set", members: [bytes("red"), bytes("green")] });
    expect(within(screen.getByRole("table", { name: "셋 멤버" })).getByText("green")).toBeInTheDocument();
  });

  test("a sorted set shows rank, score and member", () => {
    show({ type: "zset", start: 0, members: [{ member: bytes("kim"), score: 1500 }, { member: bytes("lee"), score: 1200.5 }] });
    const rows = within(screen.getByRole("table", { name: "정렬 셋 멤버" })).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("01500kim");
    expect(rows[2]).toHaveTextContent("11200.5lee");
  });

  test("a stream shows its summary and entries", () => {
    show({
      type: "stream",
      summary: { length: 3, groups: 1, firstId: "1-0", lastId: "3-0" },
      entries: [{ id: "1-0", fields: [{ field: bytes("event"), value: bytes("login") }] }, { id: "2-0", fields: [{ field: bytes("event"), value: binary(0xff) }] }],
    });
    expect(screen.getByText("첫 ID").nextElementSibling).toHaveTextContent("1-0");
    expect(screen.getByText("마지막 ID").nextElementSibling).toHaveTextContent("3-0");
    const table = screen.getByRole("table", { name: "스트림 항목" });
    expect(within(table).getByText("login")).toBeInTheDocument();
    expect(within(table).getByText("ff")).toBeInTheDocument();
  });

  test("[더 읽기] reads the next page and is gone at the end", () => {
    const { onMore } = show({ type: "list", start: 0, items: [bytes("a")] }, { hasMore: true, total: 450 });
    expect(screen.getByText("1개 읽음 / 전체 450개")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "더 읽기" }));
    expect(onMore).toHaveBeenCalled();
  });

  test("while the next page is coming the button waits", () => {
    show({ type: "set", members: [bytes("a")] }, { hasMore: true, fetching: true });
    expect(screen.getByRole("button", { name: "읽는 중…" })).toBeDisabled();
  });

  test("an empty collection says so", () => {
    show({ type: "hash", entries: [] });
    expect(screen.getByText("비어 있어요")).toBeInTheDocument();
  });

  test("a value copy button copies the value, and the Base64 of a binary one", async () => {
    show({ type: "hash", entries: [{ field: bytes("a"), value: bytes("x") }, { field: bytes("b"), value: binary(1, 2, 3) }] });
    const copies = screen.getAllByRole("button", { name: "복사" });
    await act(async () => fireEvent.click(copies[0]));
    expect(desktop.copy).toHaveBeenLastCalledWith("x");
    await act(async () => fireEvent.click(copies[1]));
    expect(desktop.copy).toHaveBeenLastCalledWith("AQID");
  });
});

test("other types say they cannot be shown", () => {
  show({ type: "other", typeName: "MBbloom--" });
  expect(screen.getByText("이 타입(MBbloom--)의 값은 보여 줄 수 없어요")).toBeInTheDocument();
});
