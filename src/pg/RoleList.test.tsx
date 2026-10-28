import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { ROLES, alice, appOwner, appRead, bob, rdsSuperuser } from "./fixtures";
import { RoleList } from "./RoleList";
import { DEFAULT_KINDS, type RoleKindsValue } from "./RoleKinds";

type Props = React.ComponentProps<typeof RoleList>;

/** 칩 상태는 PgTab이 들고 있다(상세를 보고 돌아와도 남도록). 여기서는 같은 일을 하는 작은 부모를 쓴다. */
function Harness(props: Partial<Props> & { initialKinds?: RoleKindsValue }) {
  const [kinds, setKinds] = useState(props.initialKinds ?? DEFAULT_KINDS);
  return (
    <RoleList roles={ROLES} filter="" kinds={kinds} onKinds={setKinds} selectedId={null} onSelect={vi.fn()} onOpen={vi.fn()} {...props} />
  );
}

const bodyRows = () => screen.getAllByRole("row").slice(1);
const names = () => bodyRows().map((r) => within(r).getAllByRole("cell")[0].querySelector(".iam-name")!.textContent);
const rowOf = (name: string) => screen.getByText(name).closest("tr") as HTMLElement;
const cells = (name: string) => within(rowOf(name)).getAllByRole("cell");

test("has the columns 이름, 종류, 소속 그룹, 구성원, 세션 and 만료일, and the table is named", () => {
  render(<Harness />);
  expect(screen.getByRole("table", { name: "역할 목록" })).toBeInTheDocument();
  expect(screen.getAllByRole("columnheader").map((h) => h.textContent?.replace(/[▲▼]/g, "").trim())).toEqual([
    "이름",
    "종류",
    "소속 그룹",
    "구성원",
    "세션",
    "만료일",
  ]);
});

test("lists users and groups by name, and keeps the system roles out until asked", () => {
  render(<Harness />);
  expect(names()).toEqual(["alice", "app_owner", "app_read", "app_write", "bob", "iam_admin", "postgres"]);
  expect(screen.queryByText("rds_superuser")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: "시스템 역할 보기" }));
  expect(names()).toEqual(["alice", "app_owner", "app_read", "app_write", "bob", "iam_admin", "pg_read_all_data", "postgres", "rds_iam", "rds_superuser"]);
  fireEvent.click(screen.getByRole("checkbox", { name: "시스템 역할 보기" }));
  expect(screen.queryByText("rds_superuser")).not.toBeInTheDocument();
});

test("the chips 사용자 and 그룹 are on at first and each hides its own kind", () => {
  render(<Harness />);
  expect(screen.getByRole("checkbox", { name: "사용자" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "그룹" })).toBeChecked();
  fireEvent.click(screen.getByRole("checkbox", { name: "사용자" }));
  expect(names()).toEqual(["app_read", "app_write"]);
  fireEvent.click(screen.getByRole("checkbox", { name: "사용자" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "그룹" }));
  expect(names()).toEqual(["alice", "app_owner", "bob", "iam_admin", "postgres"]);
});

test("a locked-out user (LOGIN off) is a 그룹, as PostgreSQL does not tell them apart", () => {
  const locked = { ...alice, name: "locked_user", kind: "group" as const, attributes: { ...alice.attributes, login: false } };
  render(<Harness roles={[alice, locked]} />);
  fireEvent.click(screen.getByRole("checkbox", { name: "사용자" }));
  expect(names()).toEqual(["locked_user"]);
  expect(cells("locked_user")[1].textContent).toBe("그룹");
});

test("the toolbar filter matches names, ignoring case, and nothing else", () => {
  const { rerender } = render(<Harness filter="APP" />);
  expect(names()).toEqual(["app_owner", "app_read", "app_write"]);
  rerender(<Harness filter="  iam_  " />);
  expect(names()).toEqual(["iam_admin"]); // 가장자리 공백은 무시한다
  // 주석("orders 스키마를 …")이나 배지 이름은 대상이 아니다
  rerender(<Harness filter="orders" />);
  expect(screen.getByText("조건에 맞는 역할이 없어요")).toBeInTheDocument();
  rerender(<Harness filter="관리자급" />);
  expect(screen.getByText("조건에 맞는 역할이 없어요")).toBeInTheDocument();
});

test("the filter also applies to the system roles that were switched on", () => {
  render(<Harness filter="rds" initialKinds={{ ...DEFAULT_KINDS, system: true }} />);
  expect(names()).toEqual(["rds_iam", "rds_superuser"]);
});

test("a row shows the name with its badges, the kind, the group count, the member count, the sessions and no expiry", () => {
  render(<Harness />);
  const row = cells("iam_admin");
  expect(Array.from(row[0].querySelectorAll(".iam-badge")).map((b) => b.textContent)).toEqual(["관리자급", "IAM 인증", "앱이 로그인한 역할"]);
  expect(row[0].querySelector(".iam-badge.danger")).toHaveTextContent("관리자급");
  expect(row.slice(1).map((c) => c.textContent)).toEqual(["사용자", "3", "0", "2", "없음"]);
});

test("a group shows its members, and a user with an expiry shows the date and the soon-to-expire badge", () => {
  render(<Harness />);
  expect(cells("app_read").slice(1).map((c) => c.textContent)).toEqual(["그룹", "0", "2", "0", "없음"]);
  const row = cells("bob");
  expect(within(row[0]).getByText("곧 만료")).toBeInTheDocument();
  expect(row[5].textContent).toBe("2026-11-05");
  expect(row[5].textContent).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test("a number column sorts by number, ties keep the name order, and the second click reverses it", () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("columnheader", { name: /세션/ }));
  // 세션 수: app_read·app_write·postgres 0, alice·app_owner·bob 1, iam_admin 2
  expect(names()).toEqual(["app_read", "app_write", "postgres", "alice", "app_owner", "bob", "iam_admin"]);
  fireEvent.click(screen.getByRole("columnheader", { name: /세션/ }));
  expect(names()).toEqual(["iam_admin", "alice", "app_owner", "bob", "app_read", "app_write", "postgres"]);
});

test("roles without an expiry go last whichever way the 만료일 column is sorted", () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("columnheader", { name: /만료일/ }));
  expect(names()).toEqual(["bob", "alice", "app_owner", "app_read", "app_write", "iam_admin", "postgres"]);
  fireEvent.click(screen.getByRole("columnheader", { name: /만료일/ }));
  expect(names()).toEqual(["bob", "alice", "app_owner", "app_read", "app_write", "iam_admin", "postgres"]);
});

test("click selects, double click opens, Enter opens the selected row", () => {
  const onSelect = vi.fn();
  const onOpen = vi.fn();
  render(<Harness selectedId="bob" onSelect={onSelect} onOpen={onOpen} />);
  expect(rowOf("bob")).toHaveAttribute("aria-selected", "true");
  fireEvent.click(screen.getByText("alice"));
  expect(onSelect).toHaveBeenCalledWith("alice");
  fireEvent.doubleClick(screen.getByText("iam_admin"));
  expect(onOpen).toHaveBeenCalledWith("iam_admin");
  fireEvent.keyDown(screen.getByTestId("iam-list"), { key: "Enter" });
  expect(onOpen).toHaveBeenLastCalledWith("bob");
});

test("arrow keys move the selection through the rows that are shown", () => {
  const onSelect = vi.fn();
  render(<Harness selectedId="app_write" onSelect={onSelect} />);
  fireEvent.keyDown(screen.getByTestId("iam-list"), { key: "ArrowDown" });
  expect(onSelect).toHaveBeenLastCalledWith("bob"); // 시스템 역할이 아니라 보이는 다음 행
});

test("tells apart a cluster without roles from a filter that matches none", () => {
  const { rerender } = render(<Harness roles={[]} />);
  expect(screen.getByText("역할이 없어요")).toBeInTheDocument();
  rerender(<Harness roles={[appOwner, appRead]} filter="zzz" />);
  expect(screen.getByText("조건에 맞는 역할이 없어요")).toBeInTheDocument();
  rerender(<Harness roles={[rdsSuperuser]} />);
  expect(screen.getByText("조건에 맞는 역할이 없어요")).toBeInTheDocument(); // 시스템 역할만 있으면 칩이 다 가린다
});

test("the chips stay on screen when no row matches, so the filter can be undone", () => {
  render(<Harness roles={[]} />);
  expect(screen.getByRole("checkbox", { name: "사용자" })).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: "시스템 역할 보기" })).toBeInTheDocument();
});

test("the expiry is the UTC date, as 점검 prints it, also where the local date is already the next day", () => {
  // 한국에서는 UTC 20시가 이미 다음 날이다. 점검은 "2026-11-30에 만료돼요"라고 한다
  vi.stubEnv("TZ", "Asia/Seoul");
  try {
    const late = { ...bob, attributes: { ...bob.attributes, validUntil: "2026-11-30T20:00:00Z" } };
    render(<Harness roles={[late]} />);
    expect(cells("bob")[5].textContent).toBe("2026-11-30");
  } finally {
    vi.unstubAllEnvs();
  }
});
