import { fireEvent, render, screen } from "@testing-library/react";
import { DetailPanel } from "./DetailPanel";
import { desktop } from "../api/desktop";
import type { DetailData } from "../lib/detail";

vi.mock("../api/desktop", () => ({ desktop: { copy: vi.fn(), openUrl: vi.fn() } }));

const detail: DetailData = {
  title: "web",
  subtitle: "EC2 · Instances",
  rows: [{ label: "Instance ID", value: "i-1" }],
  tags: { env: "prod" },
  copy: { label: "ARN", value: "arn:x" },
  consoleUrl: "https://console",
  raw: "raw text",
};

test("empty state", () => {
  render(<DetailPanel detail={null} onShowRaw={() => {}} />);
  expect(screen.getByText("리소스를 선택하세요")).toBeInTheDocument();
});

test("renders rows, tags and actions", () => {
  const onShowRaw = vi.fn();
  render(<DetailPanel detail={detail} onShowRaw={onShowRaw} />);
  expect(screen.getByText("web")).toBeInTheDocument();
  expect(screen.getByText("i-1")).toBeInTheDocument();
  expect(screen.getByText("env=prod")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "복사" }));
  expect(desktop.copy).toHaveBeenCalledWith("arn:x");
  fireEvent.click(screen.getByRole("button", { name: /콘솔에서 열기/ }));
  expect(desktop.openUrl).toHaveBeenCalledWith("https://console");
  fireEvent.click(screen.getByRole("button", { name: "원본 데이터 보기" }));
  expect(onShowRaw).toHaveBeenCalled();
});
