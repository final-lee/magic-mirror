import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../test/utils";
import { k8sApi } from "./api";
import { EventsView } from "./EventsView";
import { EVENTS } from "./kinds";
import { LIST_NO_MATCH, LOADING, NO_EVENTS, WARNINGS_ONLY } from "./text";
import { findFor, findInputs } from "./testFind";
import type { K8sRow, K8sWatchMessage } from "./types";

vi.mock("./api", () => ({ k8sApi: { watch: vi.fn(), unwatch: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
const m = vi.mocked(k8sApi);
let n = 0;
let T = { profile: "app", region: "r", cluster: "c" };
let emit: (msg: K8sWatchMessage) => void = () => {};

const ev = (name: string, type: string, lastSeen: string, ns = "prod"): K8sRow => ({
  uid: name, name, namespace: ns, resourceVersion: "1", createdAt: null, labels: {}, problems: [],
  values: { type, reason: `R-${name}`, object: `Pod/${name}`, message: `m-${name}`, count: "2", lastSeen },
});

beforeEach(() => {
  vi.clearAllMocks();
  T = { ...T, cluster: `c${n++}` };
  m.unwatch.mockResolvedValue(null);
  m.watch.mockImplementation(async (_t, _k, _ns, _p, onMessage) => {
    emit = onMessage;
    return 1;
  });
});

function setup(namespace: string | null = "prod") {
  render(withClientAndSso(<EventsView target={T} context="ctx" sessionEpoch={1} ssoProfile="p" live namespace={namespace} now={Date.parse("2026-10-30T12:00:00Z")} />, newQueryClient(), ssoLoginStub()));
}
const messages = () => screen.queryAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[4].textContent);

test("watches events in the namespace and shows newest first", async () => {
  setup();
  expect(screen.getByText(LOADING)).toBeInTheDocument();
  await vi.waitFor(() => expect(m.watch).toHaveBeenCalledWith(T, EVENTS, "prod", "p", expect.any(Function)));
  act(() => emit({ type: "reset", rows: [ev("a", "Normal", "2026-10-30T11:00:00Z"), ev("b", "Warning", "2026-10-30T11:58:00Z")] }));
  expect(messages()).toEqual(["m-b", "m-a"]);
  expect(screen.getByText("2m")).toBeInTheDocument();
  expect(screen.getByText("Pod/b")).toBeInTheDocument();
});

test("event rows support vim movement", async () => {
  setup();
  await vi.waitFor(() => expect(m.watch).toHaveBeenCalled());
  act(() => emit({ type: "reset", rows: [ev("a", "Normal", "2026-10-30T11:00:00Z"), ev("b", "Warning", "2026-10-30T11:58:00Z")] }));
  const table = screen.getByRole("table");
  const rows = within(table).getAllByRole("row").slice(1);
  fireEvent.keyDown(table, { key: "j" });
  expect(rows[0]).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(table, { key: "G", shiftKey: true });
  expect(rows[1]).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(table, { key: "k" });
  expect(rows[0]).toHaveAttribute("aria-selected", "true");
});

test("Warning only", async () => {
  setup();
  await vi.waitFor(() => expect(m.watch).toHaveBeenCalled());
  act(() => emit({ type: "reset", rows: [ev("a", "Normal", "2026-10-30T11:00:00Z"), ev("b", "Warning", "2026-10-30T11:58:00Z")] }));
  fireEvent.click(screen.getByRole("checkbox", { name: WARNINGS_ONLY }));
  expect(messages()).toEqual(["m-b"]);
});

test("all namespaces watches cluster-wide and names the namespace", async () => {
  setup(null);
  await vi.waitFor(() => expect(m.watch).toHaveBeenCalledWith(T, EVENTS, null, "p", expect.any(Function)));
  act(() => emit({ type: "reset", rows: [ev("a", "Normal", "2026-10-30T11:00:00Z", "kube-system")] }));
  expect(screen.getByText("kube-system/Pod/a")).toBeInTheDocument();
});

test("empty", async () => {
  setup();
  await vi.waitFor(() => expect(m.watch).toHaveBeenCalled());
  act(() => emit({ type: "reset", rows: [] }));
  expect(screen.getByText(NO_EVENTS)).toBeInTheDocument();
});

test("a watch error is shown", async () => {
  setup();
  await vi.waitFor(() => expect(m.watch).toHaveBeenCalled());
  act(() => emit({ type: "error", error: { kind: "accessDenied", action: "list events" }, fatal: true }));
  expect(screen.getByText("권한 없음 (list events)")).toBeInTheDocument();
});

test("⌘F opens a find line above the events (none before), filters by reason, object or message, and Esc brings every event back", async () => {
  setup();
  await vi.waitFor(() => expect(m.watch).toHaveBeenCalled());
  act(() => emit({ type: "reset", rows: [ev("a", "Normal", "2026-10-30T11:00:00Z"), ev("b", "Warning", "2026-10-30T11:58:00Z")] }));
  expect(findInputs()).toHaveLength(0);
  findFor("R-a");
  expect(messages()).toEqual(["m-a"]);
  findFor("nothing-like-this");
  expect(screen.getByText(LIST_NO_MATCH)).toBeInTheDocument();
  fireEvent.keyDown(findInputs()[0], { key: "Escape" });
  expect(messages()).toEqual(["m-b", "m-a"]);
});
