import { render, screen } from "@testing-library/react";
import { BadgeList } from "./Badges";
import { BADGES } from "./fixtures";

test("renders each badge with its label and kind, in the IAM badge look", () => {
  render(<BadgeList badges={[BADGES.admin, BADGES.createRole, BADGES.iamAuth]} />);
  const admin = screen.getByText("관리자급");
  expect(admin).toHaveClass("iam-badge");
  expect(admin).toHaveAttribute("data-kind", "admin");
  expect(screen.getByText("CREATEROLE")).toHaveAttribute("data-kind", "createRole");
  expect(screen.getByText("IAM 인증")).toHaveAttribute("data-kind", "iamAuth");
});

test("the level picks the colour: high is danger, medium is warn, info stays info", () => {
  render(<BadgeList badges={[BADGES.admin, BADGES.bypassRls, BADGES.loginRole]} />);
  expect(screen.getByText("관리자급")).toHaveClass("danger");
  expect(screen.getByText("BYPASSRLS")).toHaveClass("warn");
  expect(screen.getByText("앱이 로그인한 역할")).toHaveClass("info");
});

test("keeps the order the backend sent", () => {
  render(<BadgeList badges={[BADGES.admin, BADGES.iamAuth, BADGES.loginRole]} />);
  expect(Array.from(document.querySelectorAll(".iam-badge")).map((e) => e.textContent)).toEqual(["관리자급", "IAM 인증", "앱이 로그인한 역할"]);
});

test("renders nothing for an empty list", () => {
  const { container } = render(<BadgeList badges={[]} />);
  expect(container).toBeEmptyDOMElement();
});
