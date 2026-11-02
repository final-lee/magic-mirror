import { fireEvent, render, screen } from "@testing-library/react";
import { ArgoServerEditor } from "./ArgoServerEditor";
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
  render(<ArgoServerEditor servers={SERVERS} onChange={vi.fn()} />);
  expect(screen.getByText("stg")).toBeInTheDocument();
  expect(screen.getByText("http://ops.example")).toBeInTheDocument();
});

test("adding appends a trimmed name and an address without the trailing slash, then clears the inputs", () => {
  const onChange = vi.fn();
  render(<ArgoServerEditor servers={SERVERS} onChange={onChange} />);
  fill("  dev ", " https://dev.example/// ");
  expect(onChange).toHaveBeenCalledWith([...SERVERS, { name: "dev", url: "https://dev.example" }]);
  expect(screen.getByLabelText(SERVER_NAME)).toHaveValue("");
  expect(screen.getByLabelText(SERVER_URL)).toHaveValue("");
});

test.each([
  ["no name", "", "https://dev.example"],
  ["not an http(s) address", "dev", "ftp://dev.example"],
  ["no host", "dev", "https://"],
  ["a bare word", "dev", "dev.example"],
])("%s is refused with a message and nothing is saved", (_why, name, url) => {
  const onChange = vi.fn();
  render(<ArgoServerEditor servers={SERVERS} onChange={onChange} />);
  fill(name, url);
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent(SERVER_INVALID);
});

test("an address that is already there (even with a trailing slash) is refused", () => {
  const onChange = vi.fn();
  render(<ArgoServerEditor servers={SERVERS} onChange={onChange} />);
  fill("again", "https://stg.example/");
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent(SERVER_DUPLICATE);
});

test("removing drops exactly that server", () => {
  const onChange = vi.fn();
  render(<ArgoServerEditor servers={SERVERS} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: serverRemoveLabel("stg") }));
  expect(onChange).toHaveBeenCalledWith([SERVERS[1]]);
});
