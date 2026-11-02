import { fireEvent, render, screen } from "@testing-library/react";
import { ALL, TopBar } from "./TopBar";
import { RECONNECT, YAML_CREATE } from "./text";

test("namespace select and reconnect call back; select is off until connected", () => {
  const onNamespace = vi.fn();
  const onReconnect = vi.fn();
  const props = { context: "c", identity: null, execProfile: null, profile: "p", namespaces: ["a"], namespace: ALL, onNamespace, onReconnect };
  const { rerender } = render(<TopBar {...props} connection="connecting" />);
  expect(screen.getByRole("combobox")).toBeDisabled();
  rerender(<TopBar {...props} connection="connected" />);
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "a" } });
  expect(onNamespace).toHaveBeenCalledWith("a");
  fireEvent.click(screen.getByRole("button", { name: RECONNECT }));
  expect(onReconnect).toHaveBeenCalled();
});

test("the YAML create button needs change mode and a connection", () => {
  const onCreateYaml = vi.fn();
  const props = { context: "c", identity: null, execProfile: null, profile: "p", namespaces: [], namespace: ALL, onNamespace: vi.fn(), onReconnect: vi.fn(), onCreateYaml };
  const { rerender } = render(<TopBar {...props} connection="connected" />);
  expect(screen.queryByRole("button", { name: YAML_CREATE })).not.toBeInTheDocument();
  rerender(<TopBar {...props} connection="connecting" changeMode />);
  expect(screen.getByRole("button", { name: YAML_CREATE })).toBeDisabled();
  rerender(<TopBar {...props} connection="connected" changeMode />);
  fireEvent.click(screen.getByRole("button", { name: YAML_CREATE }));
  expect(onCreateYaml).toHaveBeenCalled();
});
