import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { invoke } from "../api/invoke";
import { DescribeView } from "./DescribeView";
import { PODS } from "./kinds";
import type { K8sObjectView } from "./types";

vi.mock("../api/invoke", () => ({ invoke: vi.fn() }));

const target = { profile: "p", region: "r", cluster: "c" };
const objectRef = { kind: PODS, namespace: "demo", name: "web" };
const view = { kind: PODS, row: { name: "web", namespace: "demo", values: {} }, conditions: [], containers: [], events: [] } as unknown as K8sObjectView;
/** 정리한 보기의 키·값 한 줄: 키(dt) 옆 값(dd)의 글 */
const valueOf = (key: string) => screen.getByText(key, { selector: "dt" }).nextElementSibling;

it("shows the failure and fallback, then refreshes the real output", async () => {
  vi.mocked(invoke).mockRejectedValueOnce({ kind: "other", message: "kubectl 없음" }).mockResolvedValueOnce("Name: web\nStatus: Running");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><DescribeView target={target} context="ctx" objectRef={objectRef} resourceVersion="1" ssoProfile="p" live view={view} onRefreshObject={vi.fn()} toolbar={document.body} /></QueryClientProvider>);
  expect(await screen.findByRole("alert")).toHaveTextContent("kubectl 없음");
  expect(valueOf("Name")).toHaveTextContent("web");
  expect(valueOf("Kind")).toHaveTextContent("Pod");
  fireEvent.click(screen.getByRole("button", { name: "다시 읽기" }));
  await vi.waitFor(() => expect(valueOf("Status")?.querySelector(".k8s-status.tone-ok")).toHaveTextContent("Running"));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("원문 shows kubectl's text as is and 정리 goes back", async () => {
  vi.mocked(invoke).mockReset().mockResolvedValue("Name: web\nLabels:  app=web\n         tier=front");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><DescribeView target={target} context="ctx" objectRef={objectRef} resourceVersion="1" ssoProfile="p" live view={view} onRefreshObject={vi.fn()} toolbar={document.body} /></QueryClientProvider>);
  await vi.waitFor(() => expect(screen.getByText("tier=front", { selector: ".desc-chip" })).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "원문" }));
  expect(screen.getByRole("button", { name: "원문" })).toHaveAttribute("aria-pressed", "true");
  expect(document.querySelector("pre")!.textContent).toBe("Name: web\nLabels:  app=web\n         tier=front");
  fireEvent.click(screen.getByRole("button", { name: "정리" }));
  expect(document.querySelector("pre")).toBeNull();
});


it("uses only masked Secret data and refreshes the object without invoking kubectl", () => {
  vi.mocked(invoke).mockClear();
  const refresh = vi.fn();
  const secret = { ...PODS, kind: "Secret", plural: "secrets" };
  const secretView = { ...view, kind: secret, secretKeys: [{ key: "password", size: 7 }], annotations: { leaked: "sensitive-value" } };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><DescribeView target={target} context="ctx" objectRef={{ ...objectRef, kind: secret }} resourceVersion="1" ssoProfile="p" live view={secretView} onRefreshObject={refresh} toolbar={document.body} /></QueryClientProvider>);
  expect(screen.getByText(/Secret은 값을 가려서/)).toBeInTheDocument();
  expect(valueOf("password")).toHaveTextContent("7 bytes");
  expect(screen.queryByText(/sensitive-value/)).not.toBeInTheDocument();
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "다시 읽기" }));
  expect(refresh).toHaveBeenCalledOnce();
});

it("coalesces version changes and renders refresh outside the tab body", async () => {
  vi.mocked(invoke).mockReset().mockResolvedValue("결과");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const toolbar = document.createElement("div");
  document.body.appendChild(toolbar);
  const component = (version: string) => <QueryClientProvider client={client}><DescribeView target={target} context="ctx" objectRef={objectRef} resourceVersion={version} ssoProfile="p" live view={view} onRefreshObject={vi.fn()} toolbar={toolbar} /></QueryClientProvider>;
  const { rerender, container, unmount } = render(component("1"));
  await screen.findByText("결과");
  expect(toolbar.querySelector("button")).not.toBeNull();
  expect(container.querySelector("button")).toBeNull();
  rerender(component("2"));
  rerender(component("3"));
  rerender(component("4"));
  expect(invoke).toHaveBeenCalledTimes(1);
  fireEvent.click(within(toolbar).getByRole("button", { name: "다시 읽기" }));
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  unmount();
  toolbar.remove();
});

it("automatically refreshes once after the minimum interval", async () => {
  vi.mocked(invoke).mockReset().mockResolvedValue("결과");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const component = (version: string) => <QueryClientProvider client={client}><DescribeView target={target} context="ctx" objectRef={objectRef} resourceVersion={version} ssoProfile="p" live view={view} onRefreshObject={vi.fn()} toolbar={null} /></QueryClientProvider>;
  const { rerender, unmount } = render(component("1"));
  await screen.findByText("결과");
  vi.useFakeTimers();
  try {
    rerender(component("2"));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    rerender(component("3"));
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
    expect(invoke).toHaveBeenCalledTimes(2);
  } finally {
    unmount();
    vi.useRealTimers();
  }
});