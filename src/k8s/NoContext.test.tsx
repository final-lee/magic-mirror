import { fireEvent, render, screen } from "@testing-library/react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { NoContext } from "./NoContext";
import { COPIED, COPY, RECHECK } from "./text";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

test("copies the command and rechecks", async () => {
  const onRecheck = vi.fn();
  render(<NoContext message="msg" command="cmd" onRecheck={onRecheck} />);
  fireEvent.click(screen.getByRole("button", { name: COPY }));
  expect(await screen.findByRole("button", { name: COPIED })).toBeInTheDocument();
  expect(writeText).toHaveBeenCalledWith("cmd");
  fireEvent.click(screen.getByRole("button", { name: RECHECK }));
  expect(onRecheck).toHaveBeenCalled();
});
