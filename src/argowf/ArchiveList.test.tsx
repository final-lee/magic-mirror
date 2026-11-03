import { fireEvent, screen, within } from "@testing-library/react";
import { renderWithClient } from "../test/utils";
import { argowfApi } from "./api";
import { ago, CONN, HOUR, NOW, wf } from "./catalogFixtures";
import { ARCHIVE_EMPTY, ARCHIVE_NO_MATCH, ARCHIVE_SEARCH } from "./catalogText";
import { ArchiveList } from "./ArchiveList";

vi.mock("./api", () => ({ argowfApi: { archived: vi.fn() } }));
const m = vi.mocked(argowfApi);

const ROWS = [
  wf({ name: "old-run", uid: "u-old", phase: "Succeeded", startedAt: ago(48 * HOUR), finishedAt: ago(47 * HOUR), archived: true }),
  wf({
    name: "nightly-x",
    uid: "u-new",
    phase: "Failed",
    message: "OOMKilled",
    cron: "nightly",
    startedAt: ago(2 * HOUR),
    finishedAt: ago(HOUR),
    archived: true,
  }),
];

function setup(selected: string | null = null) {
  const handlers = { onOpen: vi.fn(), onTokenError: vi.fn() };
  renderWithClient(<ArchiveList conn={CONN} live selected={selected} {...handlers} />);
  return handlers;
}

beforeEach(() => {
  vi.resetAllMocks();
  // 상대 시각("2시간 전")이 기준 시각 NOW로 정해지게 Date만 고정한다(타이머는 그대로)
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  m.archived.mockResolvedValue({ rows: ROWS, continueToken: null, resourceVersion: null });
});
afterEach(() => vi.useRealTimers());

describe("ArchiveList", () => {
  test("서버 조건과 다음 페이지를 보낸다", async () => {
    m.archived.mockImplementation(async (_conn, query) =>
      query.continueToken ? { rows: [ROWS[0]], continueToken: null, resourceVersion: null } : { rows: [ROWS[1]], continueToken: "next", resourceVersion: null },
    );
    setup();
    await screen.findByRole("row", { name: /nightly-x/ });
    fireEvent.change(screen.getByLabelText("레이블 선택자"), { target: { value: "team=ops" } });
    expect(await screen.findByRole("button", { name: "더 보기" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "더 보기" }));
    expect(await screen.findByRole("row", { name: /old-run/ })).toBeInTheDocument();
    expect(m.archived).toHaveBeenCalledWith(CONN, expect.objectContaining({ labelSelector: "team=ops", continueToken: "next" }));
  });
  test("비었거나 아카이브가 꺼진 서버면 안내한다", async () => {
    m.archived.mockResolvedValue({ rows: [], continueToken: null, resourceVersion: null });
    setup();
    expect(await screen.findByText(ARCHIVE_EMPTY)).toBeInTheDocument();
    expect(ARCHIVE_EMPTY).toBe("보관된 Workflow가 없어요. 서버에 아카이브를 켜지 않았을 수 있어요");
  });

  test("Workflows와 같은 열(상태·원천·시작·걸린 시간·메시지), 최근 시작이 위, 실패 메시지는 빨강", async () => {
    setup();
    await screen.findByRole("row", { name: /nightly-x/ });
    const body = screen.getAllByRole("row").slice(1);
    expect(body.map((r) => within(r).getAllByRole("cell")[0].textContent)).toEqual(["nightly-x", "old-run"]);
    const failed = within(body[0]).getAllByRole("cell");
    expect(failed.map((c) => c.textContent)).toEqual(["nightly-x", "batch", "Failed1/1", "⏱ nightly", "2시간 전", "1시간 0분", "OOMKilled"]);
    expect(within(body[0]).getByText("OOMKilled")).toHaveClass("err");
    expect(within(body[1]).getByText("직접")).toBeInTheDocument();
  });

  test("행을 누르면 uid로 연다. 고른 행이 표시된다", async () => {
    const { onOpen } = setup("u-old");
    const row = await screen.findByRole("row", { name: /nightly-x/ });
    expect(screen.getByRole("row", { name: /old-run/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(row);
    expect(onOpen).toHaveBeenCalledWith({ kind: "archived", uid: "u-new" });
  });

  test("검색", async () => {
    setup();
    await screen.findByRole("row", { name: /nightly-x/ });
    fireEvent.change(screen.getByRole("textbox", { name: ARCHIVE_SEARCH }), { target: { value: "nightly" } });
    expect(screen.queryByRole("row", { name: /old-run/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: ARCHIVE_SEARCH }), { target: { value: "zzzzqq" } });
    expect(screen.getByText(ARCHIVE_NO_MATCH)).toBeInTheDocument();
  });
});
