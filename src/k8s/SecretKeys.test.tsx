import { act, fireEvent, render, screen } from "@testing-library/react";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../test/utils";
import { k8sApi } from "./api";
import { SecretKeys } from "./SecretKeys";
import { BASE64_NOTE, HIDE_VALUE, NO_SECRET_PERMISSION, SHOW_VALUE, byteSize } from "./text";
import type { K8sSecretValue } from "./types";

vi.mock("./api", () => ({ k8sApi: { secretValue: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
const m = vi.mocked(k8sApi);

const T = { profile: "app", region: "r", cluster: "c" };
const KEYS = [{ key: "password", size: 7 }, { key: "blob", size: 2 }];

function setup(props: Partial<Parameters<typeof SecretKeys>[0]> = {}) {
  const qc = newQueryClient();
  const ui = (p: Partial<Parameters<typeof SecretKeys>[0]>) =>
    withClientAndSso(<SecretKeys target={T} ssoProfile="prod-ro" namespace="web" name="db" keys={KEYS} canRead="yes" {...props} {...p} />, qc, ssoLoginStub());
  const r = render(ui({}));
  return { qc, rerender: (p: Partial<Parameters<typeof SecretKeys>[0]>) => r.rerender(ui(p)), unmount: r.unmount };
}
const showButtons = () => screen.getAllByRole("button", { name: SHOW_VALUE });

beforeEach(() => vi.clearAllMocks());

test("lists keys with sizes and reads a value only when asked", async () => {
  m.secretValue.mockResolvedValue({ text: "hunter2", encoding: "utf8" });
  setup();
  expect(screen.getByText("password")).toBeInTheDocument();
  expect(screen.getByText(byteSize(7))).toBeInTheDocument();
  expect(m.secretValue).not.toHaveBeenCalled();
  fireEvent.click(showButtons()[0]);
  expect(await screen.findByText("hunter2")).toBeInTheDocument();
  expect(m.secretValue).toHaveBeenCalledWith(T, "web", "db", "password", "prod-ro");
  fireEvent.click(screen.getByRole("button", { name: HIDE_VALUE }));
  expect(screen.queryByText("hunter2")).toBeNull();
});

test("binary values come with a base64 note", async () => {
  m.secretValue.mockResolvedValue({ text: "//4=", encoding: "base64" });
  setup();
  fireEvent.click(showButtons()[1]);
  expect(await screen.findByText("//4=")).toBeInTheDocument();
  expect(screen.getByText(BASE64_NOTE)).toBeInTheDocument();
});

test("values never reach the query cache", async () => {
  m.secretValue.mockResolvedValue({ text: "hunter2", encoding: "utf8" });
  const { qc } = setup();
  fireEvent.click(showButtons()[0]);
  await screen.findByText("hunter2");
  const cached = JSON.stringify(qc.getQueryCache().getAll().map((q) => q.state.data));
  expect(cached).not.toContain("hunter2");
});

test("switching to another Secret drops shown values and ignores a late answer", async () => {
  let resolve!: (v: K8sSecretValue) => void;
  m.secretValue.mockReturnValueOnce(new Promise((r) => (resolve = r)));
  m.secretValue.mockResolvedValueOnce({ text: "first", encoding: "utf8" });
  const { rerender } = setup();
  fireEvent.click(showButtons()[0]);
  rerender({ name: "other" });
  await act(async () => resolve({ text: "late-secret", encoding: "utf8" }));
  expect(screen.queryByText("late-secret")).toBeNull();
  rerender({ name: "db" });
  fireEvent.click(showButtons()[0]);
  expect(await screen.findByText("first")).toBeInTheDocument();
  rerender({ namespace: "other-ns" });
  expect(screen.queryByText("first")).toBeNull();
});

test("unmounting forgets the value", async () => {
  m.secretValue.mockResolvedValue({ text: "hunter2", encoding: "utf8" });
  const first = setup();
  fireEvent.click(showButtons()[0]);
  await screen.findByText("hunter2");
  first.unmount();
  setup();
  expect(screen.queryByText("hunter2")).toBeNull();
});

test("no permission disables the button with a reason", () => {
  setup({ canRead: "no" });
  for (const b of showButtons()) {
    expect(b).toBeDisabled();
    expect(b).toHaveAttribute("title", NO_SECRET_PERMISSION);
  }
});

test("an error is shown next to the key and can be retried", async () => {
  m.secretValue.mockRejectedValueOnce({ kind: "network", message: "끊겼어요" });
  m.secretValue.mockResolvedValueOnce({ text: "hunter2", encoding: "utf8" });
  setup();
  fireEvent.click(showButtons()[0]);
  expect(await screen.findByText(/끊겼어요/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  expect(await screen.findByText("hunter2")).toBeInTheDocument();
});

test("access denied shows the permission error without a retry", async () => {
  m.secretValue.mockRejectedValueOnce({ kind: "accessDenied", action: "get secrets" });
  setup();
  fireEvent.click(showButtons()[0]);
  expect(await screen.findByText("권한 없음 (get secrets)")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "다시 시도" })).toBeNull();
});

test("unknown permission allows reading", () => {
  setup({ canRead: "unknown" });
  expect(showButtons()[0]).toBeEnabled();
});

test("switching target clears a revealed value", async () => {
  m.secretValue.mockResolvedValue({ text: "hunter2", encoding: "utf8" });
  const { rerender } = setup();
  fireEvent.click(showButtons()[0]);
  await screen.findByText("hunter2");
  rerender({ target: { ...T, cluster: "other" } });
  expect(screen.queryByText("hunter2")).toBeNull();
});

test("concurrent key reads stay independently busy", async () => {
  let resolveFirst!: (v: K8sSecretValue) => void;
  let resolveSecond!: (v: K8sSecretValue) => void;
  m.secretValue.mockReturnValueOnce(new Promise((r) => (resolveFirst = r)));
  m.secretValue.mockReturnValueOnce(new Promise((r) => (resolveSecond = r)));
  setup();
  fireEvent.click(showButtons()[0]);
  fireEvent.click(showButtons()[1]);
  await act(async () => resolveSecond({ text: "second", encoding: "utf8" }));
  expect(showButtons()[0]).toBeDisabled();
  await act(async () => resolveFirst({ text: "first", encoding: "utf8" }));
  expect(screen.getByText("first")).toBeInTheDocument();
  expect(screen.getByText("second")).toBeInTheDocument();
});

test("a pending value is discarded after unmount", async () => {
  let resolve!: (v: K8sSecretValue) => void;
  m.secretValue.mockReturnValueOnce(new Promise((r) => (resolve = r)));
  const first = setup();
  fireEvent.click(showButtons()[0]);
  first.unmount();
  setup();
  await act(async () => resolve({ text: "late-secret", encoding: "utf8" }));
  expect(screen.queryByText("late-secret")).toBeNull();
});
