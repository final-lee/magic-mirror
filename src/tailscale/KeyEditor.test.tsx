import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "../api/invoke";
import { desktop } from "../api/desktop";
import { KeyEditor } from "./KeyEditor";
import * as t from "./keyEditorText";

vi.mock("../api/invoke", () => ({ invoke: vi.fn() }));
vi.mock("../api/desktop", () => ({ desktop: { copy: vi.fn() } }));

test("previews auth-key capabilities before creating and shows the secret only in the result", async () => {
  vi.mocked(invoke).mockResolvedValue({ id: "k1", key: "one-time" });
  render(<KeyEditor tailnet="example.com" item={null} onClose={() => {}} onDone={() => {}} />);
  fireEvent.click(screen.getByLabelText(t.REUSABLE));
  fireEvent.change(screen.getByLabelText(t.TAGS), { target: { value: "tag:ci" } });
  fireEvent.click(screen.getByRole("button", { name: t.PREVIEW }));
  expect(screen.getByText(/POST \/tailnet\/-\/keys/)).toHaveTextContent('"reusable": true');
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: t.APPLY }));
  await screen.findByText("one-time");
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("tailscale_key_save", expect.objectContaining({ tailnet: "example.com", id: null })));
  fireEvent.click(screen.getByRole("button", { name: t.COPY }));
  expect(desktop.copy).toHaveBeenCalledWith("one-time");
});
