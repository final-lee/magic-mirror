import { fireEvent, render, screen } from "@testing-library/react";
import { ArgoTokenForm } from "./ArgoTokenForm";
import { TOKEN_CANCEL, TOKEN_HELP, TOKEN_HTTP_WARNING, TOKEN_INVALID, TOKEN_LABEL, TOKEN_SUBMIT } from "./text";

const HTTPS = "https://argocd.example";

test("a password field and the one-line how-to", () => {
  render(<ArgoTokenForm url={HTTPS} message={null} busy={false} onSubmit={vi.fn()} />);
  expect(screen.getByLabelText(TOKEN_LABEL)).toHaveAttribute("type", "password");
  expect(screen.getByText(TOKEN_HELP)).toHaveTextContent("Settings → Accounts");
  expect(screen.getByText(TOKEN_HELP)).toHaveTextContent("argocd account generate-token");
  expect(screen.queryByText(TOKEN_HTTP_WARNING)).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("only http:// shows the plaintext warning", () => {
  const { rerender } = render(<ArgoTokenForm url="http://ops.example" message={null} busy={false} onSubmit={vi.fn()} />);
  expect(screen.getByText(TOKEN_HTTP_WARNING)).toBeInTheDocument();
  rerender(<ArgoTokenForm url="HTTP://argocd.example" message={null} busy={false} onSubmit={vi.fn()} />);
  expect(screen.getByText(TOKEN_HTTP_WARNING)).toBeInTheDocument();
  rerender(<ArgoTokenForm url={HTTPS} message={null} busy={false} onSubmit={vi.fn()} />);
  expect(screen.queryByText(TOKEN_HTTP_WARNING)).toBeNull();
});

test("submitting sends the trimmed token once and empties the field", () => {
  const onSubmit = vi.fn();
  render(<ArgoTokenForm url={HTTPS} message={null} busy={false} onSubmit={onSubmit} />);
  const input = screen.getByLabelText(TOKEN_LABEL);
  fireEvent.change(input, { target: { value: "  secret-token\n" } });
  fireEvent.click(screen.getByRole("button", { name: TOKEN_SUBMIT }));
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(onSubmit).toHaveBeenCalledWith("secret-token");
  expect(input).toHaveValue("");
  expect(screen.getByRole("button", { name: TOKEN_SUBMIT })).toBeDisabled();
});

test("an empty or blank token cannot be sent", () => {
  const onSubmit = vi.fn();
  render(<ArgoTokenForm url={HTTPS} message={null} busy={false} onSubmit={onSubmit} />);
  expect(screen.getByRole("button", { name: TOKEN_SUBMIT })).toBeDisabled();
  fireEvent.change(screen.getByLabelText(TOKEN_LABEL), { target: { value: "   " } });
  fireEvent.submit(screen.getByLabelText(TOKEN_LABEL).closest("form")!);
  expect(onSubmit).not.toHaveBeenCalled();
});

test("while busy the button is disabled, and the reason is shown", () => {
  render(<ArgoTokenForm url={HTTPS} message={TOKEN_INVALID} busy onSubmit={vi.fn()} />);
  expect(screen.getByRole("alert")).toHaveTextContent(TOKEN_INVALID);
  fireEvent.change(screen.getByLabelText(TOKEN_LABEL), { target: { value: "t" } });
  expect(screen.getByRole("button", { name: TOKEN_SUBMIT })).toBeDisabled();
});

test("Cancel appears only when asked for", () => {
  const onCancel = vi.fn();
  const { rerender } = render(<ArgoTokenForm url={HTTPS} message={null} busy={false} onSubmit={vi.fn()} />);
  expect(screen.queryByRole("button", { name: TOKEN_CANCEL })).toBeNull();
  rerender(<ArgoTokenForm url={HTTPS} message={null} busy={false} onSubmit={vi.fn()} onCancel={onCancel} />);
  fireEvent.click(screen.getByRole("button", { name: TOKEN_CANCEL }));
  expect(onCancel).toHaveBeenCalledTimes(1);
});
