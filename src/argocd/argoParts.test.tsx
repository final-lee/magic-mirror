import { render, screen } from "@testing-library/react";
import { ArgoBadge, argoTone, shortRev } from "./argoParts";

test.each([
  ["Synced", "ok"],
  ["Healthy", "ok"],
  ["Succeeded", "ok"],
  ["UpToDate", "ok"],
  ["OutOfSync", "warn"],
  ["Progressing", "warn"],
  ["Running", "warn"],
  ["Degraded", "bad"],
  ["Missing", "bad"],
  ["Failed", "bad"],
  ["Error", "bad"],
  ["Suspended", "dim"],
  ["Unknown", "dim"],
  ["Whatever", "dim"],
])("%s is %s", (status, tone) => {
  expect(argoTone(status)).toBe(tone);
});

test("no status has the dim tone and draws no badge", () => {
  expect(argoTone(null)).toBe("dim");
  expect(argoTone(undefined)).toBe("dim");
  const { container } = render(<ArgoBadge status={null} />);
  expect(container).toBeEmptyDOMElement();
});

test("a badge carries the tone class and the title", () => {
  render(<ArgoBadge status="Degraded" title="Health 상태" />);
  const badge = screen.getByText("Degraded");
  expect(badge).toHaveClass("argo-badge", "argo-bad");
  expect(badge).toHaveAttribute("title", "Health 상태");
});

test("a 40-digit commit hash shortens to 7 characters; tags and chart versions stay", () => {
  expect(shortRev("0123456789abcdef0123456789abcdef01234567")).toBe("0123456");
  expect(shortRev("0123456789ABCDEF0123456789ABCDEF01234567")).toBe("0123456");
  expect(shortRev("1.2.3")).toBe("1.2.3");
  expect(shortRev("main")).toBe("main");
  // 40자가 아니면 해시로 보지 않는다
  expect(shortRev("0123456789abcdef")).toBe("0123456789abcdef");
});
