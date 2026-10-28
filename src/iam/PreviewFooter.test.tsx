import { fireEvent, render, screen } from "@testing-library/react";
import { createRef, type ComponentProps } from "react";
import { PreviewFooter } from "./PreviewFooter";

// 변경 미리보기 창(IAM 하나짜리, PostgreSQL 하나짜리와 묶음)이 함께 쓰는 아래쪽: 오류 안내, 안내 문구, 취소 · 다시 받기 · 적용.
// 창마다의 시험은 이 아래쪽이 창 안에서 맞게 놓이는지를 본다.

type Props = ComponentProps<typeof PreviewFooter>;

const clean = { warnings: [], confirmText: null };
const block = { level: "block" as const, message: "막혀요" };
const confirm = { level: "confirm" as const, message: "확인이 필요해요" };
const warn = { level: "warn" as const, message: "주의하세요" };

function setup(extra: Partial<Props> = {}) {
  const handlers = { onApply: vi.fn(), onRetry: vi.fn(), onCancel: vi.fn() };
  const cancelRef = createRef<HTMLButtonElement>();
  const retryRef = createRef<HTMLButtonElement>();
  const props: Props = { gated: clean, phase: "ready", error: null, stale: false, typed: "", cancelRef, retryRef, ...handlers, ...extra };
  const utils = render(<PreviewFooter {...props} />);
  return { ...handlers, cancelRef, retryRef, rerender: (next: Partial<Props>) => utils.rerender(<PreviewFooter {...props} {...next} />) };
}

const applyButton = () => screen.getByRole("button", { name: /^적용/ });
const cancelButton = () => screen.getByRole("button", { name: "취소" });
const retryButton = () => screen.queryByRole("button", { name: "미리보기 다시 받기" });

describe("the apply button", () => {
  test("is on for a preview with nothing to confirm, and hands over what was typed", () => {
    const { onApply } = setup({ typed: "abc" });
    expect(applyButton()).toBeEnabled();
    expect(applyButton()).toHaveClass("primary");
    fireEvent.click(applyButton());
    expect(onApply).toHaveBeenCalledWith("abc");
  });

  test("is off while there is no preview yet", () => {
    setup({ gated: null, phase: "loading" });
    expect(applyButton()).toBeDisabled();
  });

  test("is off in every phase but ready, and says it is working while applying", () => {
    setup({ phase: "applying" });
    expect(screen.getByRole("button", { name: "적용 중…" })).toBeDisabled();
  });

  test("is off for a preview that has to be read again after a failed apply", () => {
    setup({ stale: true });
    expect(applyButton()).toBeDisabled();
  });

  test("is off for a blocking warning, with the reason beside it", () => {
    setup({ gated: { warnings: [block], confirmText: null } });
    expect(applyButton()).toBeDisabled();
    expect(screen.getByText("막힘 경고가 있어서 적용할 수 없어요")).toHaveClass("cp-hint");
  });

  test("is off for a confirm warning that gave no text to type, with the reason beside it", () => {
    setup({ gated: { warnings: [confirm], confirmText: null } });
    expect(applyButton()).toBeDisabled();
    expect(screen.getByText("확인 문구를 받지 못해서 적용할 수 없어요")).toBeInTheDocument();
  });

  test("waits for the confirm text without scolding: no hint while it is not typed right", () => {
    const gated = { warnings: [confirm], confirmText: "app_read" };
    const { rerender } = setup({ gated, typed: "app" });
    expect(applyButton()).toBeDisabled();
    expect(document.querySelector(".cp-hint")).toBeNull();
    rerender({ gated, typed: "app_read" });
    expect(applyButton()).toBeEnabled();
  });

  test("is the danger button for a confirm text or any warning that is not a block; plain primary otherwise", () => {
    const { rerender } = setup({ gated: { warnings: [warn], confirmText: null } });
    expect(applyButton()).toHaveClass("danger");
    rerender({ gated: { warnings: [], confirmText: "app_read" } });
    expect(applyButton()).toHaveClass("danger");
    rerender({ gated: { warnings: [block], confirmText: null } });
    expect(applyButton()).toHaveClass("primary");
    rerender({ gated: clean });
    expect(applyButton()).toHaveClass("primary");
    rerender({ gated: null });
    expect(applyButton()).toHaveClass("primary");
  });
});

describe("cancel and ask again", () => {
  test("취소 cancels, except while applying, when it is locked", () => {
    const { onCancel, rerender } = setup();
    fireEvent.click(cancelButton());
    expect(onCancel).toHaveBeenCalledTimes(1);
    rerender({ phase: "applying" });
    expect(cancelButton()).toBeDisabled();
  });

  test("미리보기 다시 받기 shows after a failed preview or a failed apply, and asks again", () => {
    const { onRetry, rerender } = setup();
    expect(retryButton()).not.toBeInTheDocument();
    rerender({ error: { kind: "preview", message: "x" } });
    fireEvent.click(retryButton()!);
    expect(onRetry).toHaveBeenCalledTimes(1);
    rerender({ error: null, stale: true });
    expect(retryButton()).toBeInTheDocument();
  });

  test("an apply error alone does not offer it: the backend's refusal comes with stale", () => {
    setup({ error: { kind: "apply", message: "x" }, stale: false });
    expect(retryButton()).not.toBeInTheDocument();
  });

  test("it is not offered while applying", () => {
    setup({ stale: true, phase: "applying" });
    expect(retryButton()).not.toBeInTheDocument();
  });

  test("the two buttons carry the refs of the window's focus rule", () => {
    const { cancelRef, retryRef } = setup({ stale: true });
    expect(cancelRef.current).toBe(cancelButton());
    expect(retryRef.current).toBe(retryButton());
  });
});

describe("the alerts above the buttons", () => {
  test("show the error, and say that the preview has to be read again", () => {
    setup({ error: { kind: "apply", message: "permission denied" }, stale: true });
    expect(screen.getByRole("alert")).toHaveTextContent("적용하지 못했어요");
    expect(screen.getByRole("alert")).toHaveTextContent("permission denied");
    expect(screen.getByText(/미리보기를 다시 받은 뒤에 적용할 수 있어요/)).toBeInTheDocument();
  });

  test("draw nothing when there is nothing to say", () => {
    const { rerender } = setup();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    rerender({ error: { kind: "preview", message: "미리보기를 만들 수 없어요" } });
    expect(screen.getByRole("alert")).toHaveTextContent("미리보기를 만들지 못했어요");
  });
});
