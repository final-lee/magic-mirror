import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { desktop } from "../api/desktop";
import { newQueryClient, ssoLoginStub, withClientAndSso } from "../test/utils";
import { k8sApi } from "./api";
import { ObjectForwards } from "./ForwardActions";
import { COPIED, FORWARD_CLOSE, FORWARD_COPY_URL, FORWARD_NO_POD, FORWARD_OPEN_BROWSER, FORWARDS_HERE, forwardTarget } from "./text";
import type { K8sForward } from "./types";

vi.mock("./api", () => ({ k8sApi: { forwardList: vi.fn(), forwardClose: vi.fn() } }));
vi.mock("../api/desktop", () => ({ desktop: { openUrl: vi.fn(), copy: vi.fn() } }));
vi.mock("../api/client", () => ({ api: { ssoLogin: vi.fn() } }));
const m = vi.mocked(k8sApi);
const T = { profile: "app", region: "r", cluster: "c" };
const forward = (over: Partial<K8sForward> = {}): K8sForward => ({ id: 1, localPort: 18080, target: T, namespace: "dev", kind: "pod", name: "web-1", remotePort: 8080, pod: "web-1", error: null, ...over });

function setup(kind: "pod" | "service", name: string) {
  render(withClientAndSso(<ObjectForwards target={T} ssoProfile="p" namespace="dev" kind={kind} name={name} live />, newQueryClient(), ssoLoginStub()));
}
const rows = () => within(screen.getByRole("region", { name: FORWARDS_HERE })).getAllByText(/^(Pod|Service) /).map((e) => e.textContent);

beforeEach(() => vi.clearAllMocks());

test("a pod shows its own forwards and the service forwards that run through it, nothing from other objects or clusters", async () => {
  m.forwardList.mockResolvedValue([
    forward(),
    forward({ id: 2, kind: "service", name: "web", remotePort: 80, localPort: 18081, pod: "web-1" }),
    forward({ id: 3, name: "web-2", pod: "web-2" }),
    forward({ id: 4, target: { ...T, cluster: "other" } }),
    forward({ id: 5, namespace: "prod" }),
  ]);
  setup("pod", "web-1");
  expect(await screen.findByText(forwardTarget(forward()))).toBeInTheDocument();
  expect(rows()).toEqual([forwardTarget(forward()), forwardTarget({ kind: "service", namespace: "dev", name: "web", remotePort: 80 }), "Pod web-1"]);
});

test("a service shows only its own forwards with the pod it is on; nothing is drawn when none is open", async () => {
  m.forwardList.mockResolvedValue([forward({ id: 2, kind: "service", name: "web", remotePort: 80, pod: null })]);
  setup("service", "web");
  expect(await screen.findByText(FORWARD_NO_POD)).toBeInTheDocument();
  m.forwardList.mockResolvedValue([]);
  const { container } = render(withClientAndSso(<ObjectForwards target={T} ssoProfile="p" namespace="dev" kind="service" name="other" live />, newQueryClient(), ssoLoginStub()));
  await act(async () => {});
  expect(container).toBeEmptyDOMElement();
});

test("open in browser, copy the address and stop from the detail", async () => {
  m.forwardList.mockResolvedValueOnce([forward()]).mockResolvedValue([]);
  m.forwardClose.mockResolvedValue(null);
  setup("pod", "web-1");
  fireEvent.click(await screen.findByRole("button", { name: FORWARD_OPEN_BROWSER }));
  expect(desktop.openUrl).toHaveBeenCalledWith("http://127.0.0.1:18080");
  fireEvent.click(screen.getByRole("button", { name: FORWARD_COPY_URL }));
  expect(desktop.copy).toHaveBeenCalledWith("http://127.0.0.1:18080");
  expect(screen.getByRole("button", { name: COPIED })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: FORWARD_CLOSE }));
  await act(async () => {});
  expect(m.forwardClose).toHaveBeenCalledWith(1);
  await waitFor(() => expect(screen.queryByRole("region", { name: FORWARDS_HERE })).not.toBeInTheDocument());
});
