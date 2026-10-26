import { render, screen } from "@testing-library/react";
import { BadgeList } from "./Badges";
import { BADGES } from "./fixtures";

test("renders each badge with its label, level class and kind", () => {
  render(<BadgeList badges={[BADGES.admin, BADGES.oldKey, BADGES.serviceLinked]} />);
  const admin = screen.getByText("관리자급");
  expect(admin).toHaveClass("iam-badge", "danger");
  expect(admin).toHaveAttribute("data-kind", "admin");
  expect(screen.getByText("오래된 키")).toHaveClass("warn");
  expect(screen.getByText("서비스 연결")).toHaveClass("info");
});

test("renders nothing for an empty list", () => {
  const { container } = render(<BadgeList badges={[]} />);
  expect(container).toBeEmptyDOMElement();
});

test("can hide badge kinds that a neighbouring column already shows", () => {
  render(<BadgeList badges={[BADGES.awsManaged, BADGES.admin]} hide={["awsManaged"]} />);
  expect(screen.queryByText("AWS 관리형")).not.toBeInTheDocument();
  expect(screen.getByText("관리자급")).toBeInTheDocument();
});
