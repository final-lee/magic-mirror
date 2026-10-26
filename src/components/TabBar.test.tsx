import { fireEvent, render, screen } from "@testing-library/react";
import { TabBar } from "./TabBar";

const tabs = [
  { id: "resources", title: "리소스", closable: false },
  { id: "explorer", title: "S3 탐색기", closable: false },
  { id: "diff:1", title: "⇄ index.html", closable: true },
];

test("activates and closes tabs", () => {
  const onActivate = vi.fn();
  const onClose = vi.fn();
  render(<TabBar tabs={tabs} active="explorer" onActivate={onActivate} onClose={onClose} />);
  expect(screen.getByRole("tab", { name: "S3 탐색기" })).toHaveAttribute("aria-selected", "true");
  expect(screen.queryByRole("button", { name: "리소스 닫기" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "⇄ index.html" }));
  expect(onActivate).toHaveBeenCalledWith("diff:1");
  fireEvent.click(screen.getByRole("button", { name: "⇄ index.html 닫기" }));
  expect(onClose).toHaveBeenCalledWith("diff:1");
  expect(onActivate).toHaveBeenCalledTimes(1);
});
