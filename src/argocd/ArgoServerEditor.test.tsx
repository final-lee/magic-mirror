import { fireEvent, render, screen } from "@testing-library/react";
import { ArgoServerEditor, ArgoServerForm } from "./ArgoServerEditor";
import { SERVER_ADD, SERVER_DUPLICATE, SERVER_INVALID, SERVER_NAME, SERVER_URL, serverRemoveLabel } from "./text";
import type { ArgocdServer } from "./types";

const SERVERS: ArgocdServer[] = [
  { name: "stg", url: "https://stg.example" },
  { name: "ops", url: "http://ops.example" },
];

const fill = (name: string, url: string) => {
  fireEvent.change(screen.getByLabelText(SERVER_NAME), { target: { value: name } });
  fireEvent.change(screen.getByLabelText(SERVER_URL), { target: { value: url } });
  fireEvent.click(screen.getByRole("button", { name: SERVER_ADD }));
};

test("lists the servers with their addresses", () => {
  render(<ArgoServerEditor servers={SERVERS} onAdd={vi.fn()} onRemove={vi.fn()} />);
  expect(screen.getByText("stg")).toBeInTheDocument();
  expect(screen.getByText("http://ops.example")).toBeInTheDocument();
});

test("adding sends a trimmed name and an address without the trailing slash, then clears the inputs", () => {
  const onAdd = vi.fn();
  render(<ArgoServerForm servers={SERVERS} onAdd={onAdd} />);
  fill("  dev ", " https://dev.example/// ");
  expect(onAdd).toHaveBeenCalledWith({ name: "dev", url: "https://dev.example" });
  expect(screen.getByLabelText(SERVER_NAME)).toHaveValue("");
  expect(screen.getByLabelText(SERVER_URL)).toHaveValue("");
});

test("an empty name becomes the address's host", () => {
  const onAdd = vi.fn();
  render(<ArgoServerForm servers={SERVERS} onAdd={onAdd} />);
  fill("", "http://argocd.internal:8080/");
  expect(onAdd).toHaveBeenCalledWith({ name: "argocd.internal:8080", url: "http://argocd.internal:8080" });
});

test.each([
  ["not an http(s) address", "ftp://dev.example"],
  ["no host", "https://"],
  ["a bare word", "dev.example"],
])("%s is refused with a message and nothing is added", (_why, url) => {
  const onAdd = vi.fn();
  render(<ArgoServerForm servers={SERVERS} onAdd={onAdd} />);
  fill("dev", url);
  expect(onAdd).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent(SERVER_INVALID);
});

test("an address that is already there (even with a trailing slash) is refused", () => {
  const onAdd = vi.fn();
  render(<ArgoServerForm servers={SERVERS} onAdd={onAdd} />);
  fill("again", "https://stg.example/");
  expect(onAdd).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent(SERVER_DUPLICATE);
});

test("removing names exactly that server", () => {
  const onRemove = vi.fn();
  render(<ArgoServerEditor servers={SERVERS} onAdd={vi.fn()} onRemove={onRemove} />);
  fireEvent.click(screen.getByRole("button", { name: serverRemoveLabel("stg") }));
  expect(onRemove).toHaveBeenCalledWith("https://stg.example");
});
