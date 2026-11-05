import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithClient } from "../../test/utils";
import { changeApi } from "./api";
import { ChangeSheet } from "./ChangeSheet";
import type { ArgoPreview } from "./types";
vi.mock("./api", () => ({ changeApi: { preview: vi.fn(), apply: vi.fn() } }));
const api = vi.mocked(changeApi);
const target = { namespace: "argocd", name: "production", project: "default", env: "prd" };
const change = { kind: "terminate" } as const;
const preview: ArgoPreview = { title: "작업 중단", calls: [], diff: null, impact: [], warnings: [], blocked: null, confirmName: "production", expectedVersion: "3" };
beforeEach(() => { vi.resetAllMocks(); api.preview.mockResolvedValue(preview); api.apply.mockResolvedValue({ message: "완료" }); });
function show() { renderWithClient(<ChangeSheet url="https://example.test" target={target} change={change} onClose={() => {}} onDone={() => {}} />); }
test("정확한 이름을 입력해야 적용해요", async () => {
  show(); const input = await screen.findByLabelText(/확인할 이름/); const apply = screen.getByRole("button", { name: "적용" });
  expect(apply).toBeDisabled(); fireEvent.change(input, { target: { value: "production" } }); expect(apply).toBeEnabled(); fireEvent.click(apply);
  await waitFor(() => expect(api.apply).toHaveBeenCalledWith("https://example.test", target, change, "3", "production"));
});
test("막힌 작업은 이름이 맞아도 적용할 수 없어요", async () => {
  api.preview.mockResolvedValue({ ...preview, blocked: "윈도우가 막아요" }); show(); const input = await screen.findByLabelText(/확인할 이름/); fireEvent.change(input, { target: { value: "production" } });
  expect(screen.getByRole("button", { name: "적용" })).toBeDisabled(); expect(screen.getByText("윈도우가 막아요")).toBeInTheDocument();
});
test("적용 중 오래된 미리 보기 오류를 보여줘요", async () => {
  api.apply.mockRejectedValue({ kind: "other", message: "미리 본 뒤 앱이 바뀌었어요" }); show(); const input = await screen.findByLabelText(/확인할 이름/); fireEvent.change(input, { target: { value: "production" } }); fireEvent.click(screen.getByRole("button", { name: "적용" }));
  expect(await screen.findByText("미리 본 뒤 앱이 바뀌었어요")).toBeInTheDocument();
});
