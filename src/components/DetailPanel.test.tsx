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

test("nothing selected: no popup", () => {
  const { container } = render(<DetailPanel detail={null} onShowRaw={() => {}} onClose={() => {}} />);
  expect(container).toBeEmptyDOMElement();
});

test("renders rows, tags and actions, and closes", () => {
  const onShowRaw = vi.fn();
  const onClose = vi.fn();
  render(<DetailPanel detail={detail} onShowRaw={onShowRaw} onClose={onClose} actions={<button>EKS 탭에서 열기</button>} />);
  // 단추는 모두 제목 줄 오른쪽 도구 모음에, 서비스 단추·콘솔·원본·닫기 순서로
  const tools = screen.getByRole("heading", { name: "web" }).nextElementSibling as HTMLElement;
  expect([...tools.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["EKS 탭에서 열기", "AWS 콘솔에서 열기 ↗", "원본 데이터 보기", "닫기"]);
  expect(screen.getByText("web")).toBeInTheDocument();
  expect(screen.getByText("i-1")).toBeInTheDocument();
  expect(screen.getByText("env=prod")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "복사" }));
  expect(desktop.copy).toHaveBeenCalledWith("arn:x");
  fireEvent.click(screen.getByRole("button", { name: /콘솔에서 열기/ }));
  expect(desktop.openUrl).toHaveBeenCalledWith("https://console");
  fireEvent.click(screen.getByRole("button", { name: "원본 데이터 보기" }));
  expect(onShowRaw).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "닫기" }));
  expect(onClose).toHaveBeenCalled();
});
