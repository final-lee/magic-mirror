import { fireEvent, render, screen, within } from "@testing-library/react";
import { ec2Perms, iamPerms, s3Perms } from "./fixtures";
import { PermissionMatrix } from "./PermissionMatrix";

const services = [ec2Perms, iamPerms, s3Perms];

function setup(props: Partial<React.ComponentProps<typeof PermissionMatrix>> = {}) {
  const onSelect = vi.fn();
  render(<PermissionMatrix services={services} adminLike={false} selected={null} onSelect={onSelect} {...props} />);
  return { onSelect };
}

const row = (name: string) => screen.getByRole("rowheader", { name: new RegExp(name) }).closest("tr") as HTMLElement;

test("renders one row per service with allowed/total in the five level columns", () => {
  setup();
  expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["서비스", "목록", "읽기", "쓰기", "권한 관리", "태그"]);
  const s3 = row("Amazon S3");
  const cells = within(s3).getAllByRole("cell");
  expect(cells.map((c) => c.textContent?.replace(/\s+/g, ""))).toEqual(["5/5", "40/40", "6/60◐2⊘1", "0/12", "0/8"]);
  // 해당 수준의 작업이 아예 없으면 대시
  const ec2 = within(row("Amazon EC2")).getAllByRole("cell");
  expect(ec2[2].textContent).toBe("10/300");
  expect(ec2[3].textContent).toBe("–");
  expect(ec2[4].textContent).toBe("–");
});

test("shows the service prefix next to the name", () => {
  setup();
  expect(within(row("Amazon S3")).getByText("s3")).toBeInTheDocument();
});

test("conditional and denied counts appear as markers with explanations", () => {
  setup();
  const write = screen.getByRole("button", { name: "Amazon S3 쓰기 허용 6/60, 조건부 2, 거부·경계 1" });
  expect(within(write).getByTitle("조건부 2")).toBeInTheDocument();
  expect(within(write).getByTitle("거부·경계 1")).toBeInTheDocument();
});

test("marks rows that include dangerous actions", () => {
  setup();
  expect(within(row("IAM")).getByLabelText("위험한 작업 포함")).toBeInTheDocument();
  expect(within(row("Amazon S3")).queryByLabelText("위험한 작업 포함")).not.toBeInTheDocument();
});

test("clicking a cell with grants reports the service and level", () => {
  const { onSelect } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Amazon S3 읽기 허용 40/40" }));
  expect(onSelect).toHaveBeenCalledWith({ prefix: "s3", name: "Amazon S3", level: "read" });
});

test("cells without any grant are not clickable", () => {
  const { onSelect } = setup();
  expect(screen.queryByRole("button", { name: /Amazon S3 권한 관리/ })).not.toBeInTheDocument();
  fireEvent.click(within(row("Amazon S3")).getByText("0/12"));
  expect(onSelect).not.toHaveBeenCalled();
});

test("the selected cell is pressed", () => {
  setup({ selected: { prefix: "s3", level: "write" } });
  expect(screen.getByRole("button", { name: /Amazon S3 쓰기/ })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: /Amazon S3 읽기/ })).toHaveAttribute("aria-pressed", "false");
});

test("the filter box narrows services by name or prefix", () => {
  setup();
  const box = screen.getByRole("searchbox", { name: "서비스 필터" });
  fireEvent.change(box, { target: { value: "ec2" } });
  expect(screen.getByRole("rowheader", { name: /Amazon EC2/ })).toBeInTheDocument();
  expect(screen.queryByRole("rowheader", { name: /Amazon S3/ })).not.toBeInTheDocument();
  fireEvent.change(box, { target: { value: "amazon" } });
  expect(screen.getAllByRole("rowheader")).toHaveLength(2);
  fireEvent.change(box, { target: { value: "없는서비스" } });
  expect(screen.getByText("조건에 맞는 서비스가 없어요")).toBeInTheDocument();
});

test("admin-like principals get a banner", () => {
  setup({ adminLike: true });
  expect(screen.getByText("모든 서비스의 모든 작업이 허용돼요")).toBeInTheDocument();
});

test("no banner for ordinary principals", () => {
  setup();
  expect(screen.queryByText("모든 서비스의 모든 작업이 허용돼요")).not.toBeInTheDocument();
});

test("a principal without any permission shows an empty message", () => {
  setup({ services: [] });
  expect(screen.getByText("허용된 권한이 없어요")).toBeInTheDocument();
});
