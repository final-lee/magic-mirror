import { fireEvent, render, screen } from "@testing-library/react";
import { UpdateBanner } from "./UpdateBanner";
import type { Updater } from "../lib/useUpdater";

function updater(over: Partial<Updater> = {}): Updater {
  return {
    state: { kind: "available", version: "0.2.0", notes: null },
    showBanner: true,
    checkNow: vi.fn(),
    install: vi.fn(),
    dismiss: vi.fn(),
    ...over,
  } as Updater;
}

test("offers update now / later", () => {
  const u = updater();
  render(<UpdateBanner updater={u} transfersActive={false} />);
  expect(screen.getByText(/0\.2\.0/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "지금 업데이트" }));
  expect(u.install).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "나중에" }));
  expect(u.dismiss).toHaveBeenCalled();
});

test("waits while transfers are running", () => {
  const u = updater();
  render(<UpdateBanner updater={u} transfersActive />);
  fireEvent.click(screen.getByRole("button", { name: "지금 업데이트" }));
  expect(u.install).not.toHaveBeenCalled();
  expect(screen.getByText(/파일 전송이 끝난 뒤에/)).toBeInTheDocument();
});

test("shows download progress", () => {
  render(<UpdateBanner updater={updater({ state: { kind: "downloading", version: "0.2.0", percent: 40 } })} transfersActive={false} />);
  expect(screen.getByText(/40%/)).toBeInTheDocument();
});

test("renders nothing when hidden", () => {
  const { container } = render(<UpdateBanner updater={updater({ showBanner: false })} transfersActive={false} />);
  expect(container).toBeEmptyDOMElement();
});
