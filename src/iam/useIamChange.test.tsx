import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { iamApi } from "./api";
import { attachReadOnlyToBob, deactivateBobKey, PLAN_DRIFTED, previewOf, sampleOverview } from "./fixtures";
import { iamKeys, useIamOverview } from "./queries";
import type { ApplyResult, ChangePreview, IamChange } from "./types";
import { applyGate, useIamChange, type StartOptions } from "./useIamChange";

vi.mock("./api", () => ({ iamApi: { preview: vi.fn(), apply: vi.fn(), overview: vi.fn(), changeLog: vi.fn() } }));

const m = vi.mocked(iamApi);
const applied: ApplyResult = { logId: "log-9", summary: "bob에 ReadOnlyAccess를 붙였어요" };
const confirmPreview = (change: IamChange, text = "bob") =>
  previewOf(change, { warnings: [{ level: "confirm", message: "되돌릴 수 없어요" }], confirmText: text });

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(profile = "prod") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const hook = renderHook(({ p }) => ({ flow: useIamChange(p), overview: useIamOverview(p) }), { wrapper, initialProps: { p: profile } });
  return { qc, ...hook, flow: () => hook.result.current.flow };
}

/** 미리보기가 도착해 확인을 기다리는 상태까지 간다 */
async function startAndWait(h: ReturnType<typeof setup>, change: IamChange, opts?: StartOptions) {
  act(() => h.flow().start(change, opts));
  await waitFor(() => expect(h.flow().pending?.phase).toBe("ready"));
}

beforeEach(() => {
  vi.clearAllMocks();
  m.overview.mockResolvedValue(sampleOverview());
  m.preview.mockImplementation(async (_p, change) => previewOf(change));
  m.apply.mockResolvedValue(applied);
  m.changeLog.mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());

describe("applyGate", () => {
  const change = attachReadOnlyToBob;

  test("a preview without warnings can be applied", () => {
    expect(applyGate(previewOf(change), "")).toEqual({ ok: true });
  });

  test("a block warning refuses, whatever was typed", () => {
    const blocked = previewOf(change, { warnings: [{ level: "block", message: "서비스 연결 역할이에요" }], confirmText: "bob" });
    expect(applyGate(blocked, "bob")).toEqual({ ok: false, reason: "blocked" });
    expect(applyGate(blocked, "")).toEqual({ ok: false, reason: "blocked" });
  });

  test("a confirm text must be typed exactly: case, spaces and extra characters all count", () => {
    const p = confirmPreview(change, "bob");
    expect(applyGate(p, "bob")).toEqual({ ok: true });
    expect(applyGate(p, "")).toEqual({ ok: false, reason: "text" });
    expect(applyGate(p, "Bob")).toEqual({ ok: false, reason: "text" });
    expect(applyGate(p, "bob ")).toEqual({ ok: false, reason: "text" });
    expect(applyGate(p, " bob")).toEqual({ ok: false, reason: "text" });
    expect(applyGate(p, "bobb")).toEqual({ ok: false, reason: "text" });
    expect(applyGate(p, "bo")).toEqual({ ok: false, reason: "text" });
  });

  test("a confirm warning without a text to type cannot be applied at all", () => {
    expect(applyGate(previewOf(change, { warnings: [{ level: "confirm", message: "확인하세요" }], confirmText: null }), "")).toEqual({
      ok: false,
      reason: "noText",
    });
    expect(applyGate(previewOf(change, { warnings: [{ level: "confirm", message: "확인하세요" }], confirmText: "" }), "")).toEqual({
      ok: false,
      reason: "noText",
    });
  });

  test("a confirm text asks for typing even when the warnings list does not say confirm", () => {
    expect(applyGate(previewOf(change, { confirmText: "bob" }), "")).toEqual({ ok: false, reason: "text" });
    expect(applyGate(previewOf(change, { confirmText: "bob" }), "bob")).toEqual({ ok: true });
  });

  test("warn warnings alone do not stop the apply", () => {
    expect(applyGate(previewOf(change, { warnings: [{ level: "warn", message: "5명 이상이에요" }] }), "")).toEqual({ ok: true });
  });
});

describe("preview", () => {
  test("start asks the backend for a preview of exactly that change and opens the flow", async () => {
    const h = setup();
    expect(h.flow().pending).toBeNull();
    act(() => h.flow().start(attachReadOnlyToBob));
    expect(h.flow().pending).toMatchObject({ change: attachReadOnlyToBob, phase: "loading", preview: null, undoOf: null, error: null });
    expect(m.preview).toHaveBeenCalledWith("prod", attachReadOnlyToBob);
    await waitFor(() => expect(h.flow().pending?.phase).toBe("ready"));
    expect(h.flow().pending?.preview).toEqual(previewOf(attachReadOnlyToBob));
    expect(m.apply).not.toHaveBeenCalled();
  });

  test("remembers which entry an undo is for", async () => {
    const h = setup();
    await startAndWait(h, deactivateBobKey, { undoOf: "log-1" });
    expect(h.flow().pending?.undoOf).toBe("log-1");
  });

  test("a failing preview is kept as an error and can be asked for again", async () => {
    m.preview.mockRejectedValueOnce({ kind: "accessDenied", action: "iam:GetPolicy" });
    const h = setup();
    act(() => h.flow().start(attachReadOnlyToBob));
    await waitFor(() => expect(h.flow().pending?.error).toEqual({ kind: "preview", message: "권한 없음 (iam:GetPolicy)" }));
    expect(h.flow().pending?.preview).toBeNull();
    expect(h.flow().pending?.phase).toBe("ready");

    act(() => h.flow().apply(""));
    expect(m.apply).not.toHaveBeenCalled();

    act(() => h.flow().retryPreview());
    await waitFor(() => expect(h.flow().pending?.preview).not.toBeNull());
    expect(h.flow().pending?.error).toBeNull();
    expect(m.preview).toHaveBeenCalledTimes(2);
  });

  test("cancel closes the flow, and a preview that arrives afterwards is ignored", async () => {
    const slow = deferred<ChangePreview>();
    m.preview.mockReturnValueOnce(slow.promise);
    const h = setup();
    act(() => h.flow().start(attachReadOnlyToBob));
    act(() => h.flow().cancel());
    expect(h.flow().pending).toBeNull();
    await act(async () => slow.resolve(previewOf(attachReadOnlyToBob)));
    expect(h.flow().pending).toBeNull();
  });

  test("apply after cancel does nothing: a closed flow has no preview to apply", async () => {
    const h = setup();
    await startAndWait(h, attachReadOnlyToBob);
    act(() => h.flow().cancel());
    await act(async () => h.flow().apply(""));
    expect(m.apply).not.toHaveBeenCalled();
  });

  test("onApplied belongs to the change it was given for: a later change does not inherit it", async () => {
    const onApplied = vi.fn();
    const h = setup();
    await startAndWait(h, attachReadOnlyToBob, { onApplied });
    act(() => h.flow().cancel());
    await startAndWait(h, deactivateBobKey);
    await act(async () => h.flow().apply(""));
    expect(m.apply).toHaveBeenCalledWith("prod", deactivateBobKey, null, null);
    expect(onApplied).not.toHaveBeenCalled();
  });

  test("starting another change replaces the one still loading; only the newest preview counts", async () => {
    const first = deferred<ChangePreview>();
    m.preview.mockReturnValueOnce(first.promise);
    const h = setup();
    act(() => h.flow().start(attachReadOnlyToBob));
    act(() => h.flow().start(deactivateBobKey));
    await waitFor(() => expect(h.flow().pending?.phase).toBe("ready"));
    expect(h.flow().pending?.change).toEqual(deactivateBobKey);
    await act(async () => first.resolve(previewOf(attachReadOnlyToBob, { summary: "낡은 미리보기" })));
    expect(h.flow().pending?.preview?.summary).not.toBe("낡은 미리보기");
    expect(h.flow().pending?.change).toEqual(deactivateBobKey);
  });
});

describe("apply", () => {
  test("applies the previewed change with no confirm text and no undo", async () => {
    const h = setup();
    await startAndWait(h, attachReadOnlyToBob);
    await act(async () => h.flow().apply(""));
    expect(m.apply).toHaveBeenCalledTimes(1);
    expect(m.apply).toHaveBeenCalledWith("prod", attachReadOnlyToBob, null, null);
  });

  test("sends the typed confirm text and the undo id", async () => {
    m.preview.mockImplementation(async (_p, change) => confirmPreview(change, "bob"));
    const h = setup();
    await startAndWait(h, deactivateBobKey, { undoOf: "log-1" });
    await act(async () => h.flow().apply("bob"));
    expect(m.apply).toHaveBeenCalledWith("prod", deactivateBobKey, "bob", "log-1");
  });

  test("never calls the backend while the confirm text is wrong, empty or differently cased", async () => {
    m.preview.mockImplementation(async (_p, change) => confirmPreview(change, "bob"));
    const h = setup();
    await startAndWait(h, attachReadOnlyToBob);
    for (const typed of ["", "Bob", "bob ", "alice"]) await act(async () => h.flow().apply(typed));
    expect(m.apply).not.toHaveBeenCalled();
    expect(h.flow().pending?.phase).toBe("ready");
  });

  test("never calls the backend for a preview with a block warning", async () => {
    m.preview.mockImplementation(async (_p, change) => previewOf(change, { warnings: [{ level: "block", message: "서비스 연결 역할이에요" }] }));
    const h = setup();
    await startAndWait(h, attachReadOnlyToBob);
    await act(async () => h.flow().apply(""));
    expect(m.apply).not.toHaveBeenCalled();
  });

  test("never calls the backend before the preview has arrived", async () => {
    m.preview.mockReturnValueOnce(new Promise(() => {}));
    const h = setup();
    act(() => h.flow().start(attachReadOnlyToBob));
    await act(async () => h.flow().apply(""));
    expect(m.apply).not.toHaveBeenCalled();
    expect(h.flow().pending?.phase).toBe("loading");
  });

  test("a double click applies once", async () => {
    const slow = deferred<ApplyResult>();
    m.apply.mockReturnValueOnce(slow.promise);
    const h = setup();
    await startAndWait(h, attachReadOnlyToBob);
    act(() => {
      h.flow().apply("");
      h.flow().apply("");
    });
    expect(m.apply).toHaveBeenCalledTimes(1);
    expect(h.flow().pending?.phase).toBe("applying");
    await act(async () => slow.resolve(applied));
  });

  test("while applying, cancel and a new start are ignored", async () => {
    const slow = deferred<ApplyResult>();
    m.apply.mockReturnValueOnce(slow.promise);
    const h = setup();
    await startAndWait(h, attachReadOnlyToBob);
    act(() => h.flow().apply(""));
    act(() => h.flow().cancel());
    act(() => h.flow().start(deactivateBobKey));
    expect(h.flow().pending?.change).toEqual(attachReadOnlyToBob);
    expect(h.flow().pending?.phase).toBe("applying");
    expect(m.preview).toHaveBeenCalledTimes(1);
    await act(async () => slow.resolve(applied));
    expect(h.flow().pending).toBeNull();
  });

  test("success closes the flow, announces the summary and calls onApplied", async () => {
    const onApplied = vi.fn();
    const h = setup();
    await startAndWait(h, attachReadOnlyToBob, { onApplied });
    expect(h.flow().notices).toEqual([]);
    await act(async () => h.flow().apply(""));
    expect(h.flow().pending).toBeNull();
    expect(h.flow().notices).toEqual([{ id: expect.any(Number), summary: "bob에 ReadOnlyAccess를 붙였어요", notes: [] }]);
    expect(onApplied).toHaveBeenCalledTimes(1);
    act(() => h.flow().dismissNotice(h.flow().notices[0].id));
    expect(h.flow().notices).toEqual([]);
  });

  test("the notice fades after a while", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = setup();
    await startAndWait(h, attachReadOnlyToBob);
    await act(async () => h.flow().apply(""));
    expect(h.flow().notices).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(h.flow().notices).toEqual([]);
  });

  test("the next success replaces a plain notice", async () => {
    m.apply.mockResolvedValueOnce(applied).mockResolvedValueOnce({ logId: "log-10", summary: "bob의 액세스 키 비활성화하기" });
    const h = setup();
    await startAndWait(h, attachReadOnlyToBob);
    await act(async () => h.flow().apply(""));
    await startAndWait(h, deactivateBobKey);
    await act(async () => h.flow().apply(""));
    expect(h.flow().notices.map((n) => n.summary)).toEqual(["bob의 액세스 키 비활성화하기"]);
  });

  test("a notice with notes from the backend stays until it is dismissed, and the next success does not replace it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const unlogged: ApplyResult = { ...applied, notes: ["변경 기록을 저장하지 못했어요: 디스크가 가득 찼어요"] };
    m.apply.mockResolvedValueOnce(unlogged).mockResolvedValueOnce({ logId: "log-10", summary: "bob의 액세스 키 비활성화하기" });
    const h = setup();
    await startAndWait(h, attachReadOnlyToBob);
    await act(async () => h.flow().apply(""));
    expect(h.flow().notices).toEqual([{ id: expect.any(Number), summary: applied.summary, notes: unlogged.notes }]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(h.flow().notices).toHaveLength(1);

    await startAndWait(h, deactivateBobKey);
    await act(async () => h.flow().apply(""));
    expect(h.flow().notices.map((n) => n.summary)).toEqual([applied.summary, "bob의 액세스 키 비활성화하기"]);
    // 함께 알릴 일이 없는 안내만 저절로 사라진다
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(h.flow().notices.map((n) => n.summary)).toEqual([applied.summary]);
    act(() => h.flow().dismissNotice(h.flow().notices[0].id));
    expect(h.flow().notices).toEqual([]);
  });
});

describe("after a successful apply", () => {
  test("re-reads the IAM data now, and once more after 3 seconds with a forced overview", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = setup();
    await waitFor(() => expect(h.result.current.overview.isSuccess).toBe(true));
    expect(m.overview).toHaveBeenCalledTimes(1);
    expect(m.overview).toHaveBeenLastCalledWith("prod", false);

    await startAndWait(h, attachReadOnlyToBob);
    await act(async () => h.flow().apply(""));
    await waitFor(() => expect(m.overview).toHaveBeenCalledTimes(2));
    expect(m.overview).toHaveBeenLastCalledWith("prod", false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_900);
    });
    expect(m.overview).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    await waitFor(() => expect(m.overview).toHaveBeenCalledTimes(3));
    expect(m.overview).toHaveBeenLastCalledWith("prod", true);
  });

  test("marks every query under the profile and the change log as stale", async () => {
    const h = setup();
    await waitFor(() => expect(h.result.current.overview.isSuccess).toBe(true));
    h.qc.setQueryData(iamKeys.principal("prod", "arn:x"), { any: "thing" });
    h.qc.setQueryData(iamKeys.principal("dev", "arn:x"), { any: "thing" });
    h.qc.setQueryData(iamKeys.changeLog, []);
    await startAndWait(h, attachReadOnlyToBob);
    await act(async () => h.flow().apply(""));
    expect(h.qc.getQueryState(iamKeys.principal("prod", "arn:x"))?.isInvalidated).toBe(true);
    expect(h.qc.getQueryState(iamKeys.changeLog)?.isInvalidated).toBe(true);
    expect(h.qc.getQueryState(iamKeys.principal("dev", "arn:x"))?.isInvalidated).toBe(false);
  });

  test("a closed tab does not refresh later", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = setup();
    await waitFor(() => expect(h.result.current.overview.isSuccess).toBe(true));
    await startAndWait(h, attachReadOnlyToBob);
    await act(async () => h.flow().apply(""));
    await waitFor(() => expect(m.overview).toHaveBeenCalledTimes(2));
    h.unmount();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(m.overview).toHaveBeenCalledTimes(2);
  });
});

describe("a failed apply", () => {
  test("keeps the flow open with the error and refuses another apply until the preview is read again", async () => {
    m.apply.mockRejectedValueOnce({ kind: "other", message: "정책이 이미 5개 버전을 갖고 있어요" });
    const onApplied = vi.fn();
    const h = setup();
    await startAndWait(h, attachReadOnlyToBob, { onApplied });
    await act(async () => h.flow().apply(""));

    expect(h.flow().pending).toMatchObject({ phase: "ready", stale: true, error: { kind: "apply", message: "정책이 이미 5개 버전을 갖고 있어요" } });
    expect(h.flow().notices).toEqual([]);
    expect(onApplied).not.toHaveBeenCalled();

    await act(async () => h.flow().apply(""));
    expect(m.apply).toHaveBeenCalledTimes(1); // 낡은 미리보기로는 다시 적용하지 않는다

    act(() => h.flow().retryPreview());
    await waitFor(() => expect(h.flow().pending?.stale).toBe(false));
    expect(m.preview).toHaveBeenCalledTimes(2);
    expect(h.flow().pending?.error).toBeNull();
    await act(async () => h.flow().apply(""));
    expect(m.apply).toHaveBeenCalledTimes(2);
    expect(h.flow().pending).toBeNull();
  });

  test("the backend's refusal after IAM changed behind the preview leads to a fresh preview, which can then be applied", async () => {
    m.apply.mockRejectedValueOnce({ kind: "other", message: PLAN_DRIFTED });
    const h = setup();
    await startAndWait(h, attachReadOnlyToBob);
    await act(async () => h.flow().apply(""));
    expect(h.flow().pending).toMatchObject({ phase: "ready", stale: true, error: { kind: "apply", message: PLAN_DRIFTED } });

    // 다시 받은 미리보기는 그 사이 달라진 IAM을 보여 준다(여기서는 호출이 하나 늘었다)
    const changed = previewOf(attachReadOnlyToBob, {
      calls: [
        { api: "iam:DeletePolicyVersion", params: { PolicyArn: "arn:aws:iam::123456789012:policy/x", VersionId: "v1" } },
        { api: "iam:AttachUserPolicy", params: { UserName: "bob", PolicyArn: "arn:aws:iam::123456789012:policy/x" } },
      ],
    });
    m.preview.mockResolvedValueOnce(changed);
    act(() => h.flow().retryPreview());
    await waitFor(() => expect(h.flow().pending?.preview).toBe(changed));
    expect(h.flow().pending).toMatchObject({ stale: false, error: null });
    await act(async () => h.flow().apply(""));
    expect(m.apply).toHaveBeenCalledTimes(2);
    expect(m.apply).toHaveBeenLastCalledWith("prod", attachReadOnlyToBob, null, null);
    expect(h.flow().pending).toBeNull();
  });

  test("re-reads the IAM views of the profile and the change log, since part of the change may have been applied", async () => {
    m.apply.mockRejectedValueOnce({ kind: "network", message: "timeout" });
    const h = setup();
    await waitFor(() => expect(h.result.current.overview.isSuccess).toBe(true));
    h.qc.setQueryData(iamKeys.changeLog, []);
    h.qc.setQueryData(iamKeys.policy("prod", "arn:aws:iam::123456789012:policy/x"), { any: "thing" });
    h.qc.setQueryData(iamKeys.policy("dev", "arn:aws:iam::123456789012:policy/x"), { any: "thing" });
    await startAndWait(h, attachReadOnlyToBob);
    await act(async () => h.flow().apply(""));
    await waitFor(() => expect(m.overview).toHaveBeenCalledTimes(2));
    // 백엔드가 실패 뒤에 스냅숏을 버렸으니 강제로 새로 읽게 하지는 않는다
    expect(m.overview).toHaveBeenLastCalledWith("prod", false);
    expect(h.qc.getQueryState(iamKeys.policy("prod", "arn:aws:iam::123456789012:policy/x"))?.isInvalidated).toBe(true);
    expect(h.qc.getQueryState(iamKeys.policy("dev", "arn:aws:iam::123456789012:policy/x"))?.isInvalidated).toBe(false);
    expect(h.qc.getQueryState(iamKeys.changeLog)?.isInvalidated).toBe(true);
    expect(h.flow().pending?.error?.message).toBe("네트워크 오류: timeout");
  });

  test("the confirm text has to be typed again for the refreshed preview", async () => {
    m.preview.mockImplementation(async (_p, change) => confirmPreview(change, "bob"));
    m.apply.mockRejectedValueOnce({ kind: "other", message: "실패" });
    const h = setup();
    await startAndWait(h, attachReadOnlyToBob);
    await act(async () => h.flow().apply("bob"));
    act(() => h.flow().retryPreview());
    await waitFor(() => expect(h.flow().pending?.stale).toBe(false));
    await act(async () => h.flow().apply("")); // 비어 있으면 여전히 막힌다
    expect(m.apply).toHaveBeenCalledTimes(1);
  });
});

describe("profile", () => {
  test("changing the profile drops an open flow, so a preview is never applied to another account", async () => {
    const h = setup("prod");
    await startAndWait(h, attachReadOnlyToBob);
    h.rerender({ p: "dev" });
    await waitFor(() => expect(h.flow().pending).toBeNull());
    await act(async () => h.flow().apply(""));
    expect(m.apply).not.toHaveBeenCalled();
  });

  test("applies with the profile the preview was made for", async () => {
    const h = setup("prod");
    await startAndWait(h, attachReadOnlyToBob);
    await act(async () => h.flow().apply(""));
    expect(m.apply).toHaveBeenCalledWith("prod", attachReadOnlyToBob, null, null);
  });
});

test("a component can hold the flow in state without extra renders breaking the guards", async () => {
  // start/apply/cancel are stable references, so they are safe to use as effect dependencies
  const qc = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const { result, rerender } = renderHook(() => ({ flow: useIamChange("prod"), n: useState(0) }), { wrapper });
  const { start, apply, cancel } = result.current.flow;
  act(() => result.current.n[1](1));
  rerender();
  expect(result.current.flow.start).toBe(start);
  expect(result.current.flow.apply).toBe(apply);
  expect(result.current.flow.cancel).toBe(cancel);
});
