import { act, fireEvent, render, screen } from "@testing-library/react";
import { desktop } from "../api/desktop";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../test/utils";
import { k8sApi } from "./api";
import { ForwardsView } from "./ForwardsView";
import { FORWARD_CLOSE, FORWARD_HEALTHY, FORWARD_NO_POD, FORWARD_OPEN_BROWSER, FORWARDS_EMPTY, LIST_NO_MATCH, forwardTarget } from "./text";
import { findFor, findInputs } from "./testFind";
import type { K8sForward } from "./types";

vi.mock("./api", () => ({ k8sApi: { forwardList: vi.fn(), forwardClose: vi.fn() } }));
vi.mock("../api/desktop", () => ({ desktop: { openUrl: vi.fn(), copy: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
const m = vi.mocked(k8sApi);
const T = { profile: "app", region: "r", cluster: "c" };
const OTHER = { profile: "app", region: "r", cluster: "other" };

const forward = (over: Partial<K8sForward> = {}): K8sForward => ({ id: 1, localPort: 18080, target: T, namespace: "dev", kind: "service", name: "web", remotePort: 80, pod: "web-1", error: null, ...over });

function setup() {
  render(withClientAndSso(<ForwardsView target={T} ssoProfile="p" />, newQueryClient(), ssoLoginStub()));
}

beforeEach(() => vi.clearAllMocks());

test("lists this cluster's forwards with their address and pod, and not another cluster's", async () => {
  m.forwardList.mockResolvedValue([forward(), forward({ id: 2, target: OTHER, name: "elsewhere" })]);
  setup();
  expect(await screen.findByText(forwardTarget(forward()))).toBeInTheDocument();
  expect(screen.getByText("127.0.0.1:18080")).toBeInTheDocument();
  expect(screen.getByText("web-1")).toBeInTheDocument();
  expect(screen.getByText(FORWARD_HEALTHY)).toBeInTheDocument();
  expect(screen.queryByText(/elsewhere/)).not.toBeInTheDocument();
});

test("shows the last connection error and a service with no ready pod", async () => {
  m.forwardList.mockResolvedValue([forward({ error: "연결이 거절됐어요" }), forward({ id: 2, pod: null, localPort: 18081 })]);
  setup();
  expect(await screen.findByText("연결이 거절됐어요")).toBeInTheDocument();
  expect(screen.getByText(FORWARD_NO_POD)).toBeInTheDocument();
});

test("empty when this cluster has none", async () => {
  m.forwardList.mockResolvedValue([forward({ target: OTHER })]);
  setup();
  expect(await screen.findByText(FORWARDS_EMPTY)).toBeInTheDocument();
});

test("opens in the browser and closes one forward, then re-reads the list", async () => {
  m.forwardList.mockResolvedValueOnce([forward()]).mockResolvedValue([]);
  m.forwardClose.mockResolvedValue(null);
  setup();
  fireEvent.click(await screen.findByRole("button", { name: FORWARD_OPEN_BROWSER }));
  expect(desktop.openUrl).toHaveBeenCalledWith("http://127.0.0.1:18080");
  fireEvent.click(screen.getByRole("button", { name: FORWARD_CLOSE }));
  await act(async () => {});
  expect(m.forwardClose).toHaveBeenCalledWith(1);
  expect(await screen.findByText(FORWARDS_EMPTY)).toBeInTheDocument();
});

test("⌘F finds forwards by target, address or pod; nothing is visible before it, and a miss says so", async () => {
  m.forwardList.mockResolvedValue([forward(), forward({ id: 2, name: "db", localPort: 15432, pod: "db-0" })]);
  setup();
  await screen.findByText(forwardTarget(forward()));
  expect(findInputs()).toHaveLength(0);
  findFor("15432");
  expect(screen.getByText("127.0.0.1:15432")).toBeInTheDocument();
  expect(screen.queryByText("127.0.0.1:18080")).not.toBeInTheDocument();
  findFor("nothing-like-this");
  expect(screen.getByText(LIST_NO_MATCH)).toBeInTheDocument();
});
