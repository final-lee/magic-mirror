import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { editorView, typeYaml } from "../test/codemirror";
import { argowfApi } from "./api";
import { CONN } from "./catalogFixtures";
import { ManifestEditor } from "./ManifestEditor";

vi.mock("./api", () => ({ argowfApi: { manifest: vi.fn(), lint: vi.fn(), create: vi.fn(), update: vi.fn() } }));
const api = vi.mocked(argowfApi);
beforeEach(() => vi.resetAllMocks());

test("예제 검사와 새 Workflow 만들기", async () => {
  api.lint.mockResolvedValue({ ok: true, message: null });
  api.create.mockResolvedValue({ namespace: "batch", name: "hello-abc" });
  const onSaved = vi.fn();
  render(<ManifestEditor conn={CONN} kind="Workflow" mode="create" namespace="batch" onClose={vi.fn()} onSaved={onSaved} />);
  fireEvent.change(screen.getByLabelText("예제"), { target: { value: "hello-world" } });
  fireEvent.click(screen.getByRole("button", { name: "검사" }));
  expect(await screen.findByText("검사를 통과했어요")).toBeInTheDocument();
  expect(api.lint).toHaveBeenCalledWith(CONN, "Workflow", "batch", expect.stringContaining("hello-world"));
  fireEvent.click(screen.getByRole("button", { name: "만들기" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ namespace: "batch", name: "hello-abc" }));
});

test("편집은 불러온 YAML을 저장하고 변경된 채 닫을 때 확인한다", async () => {
  api.manifest.mockResolvedValue("kind: CronWorkflow\n");
  api.update.mockResolvedValue();
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(<ManifestEditor conn={CONN} kind="CronWorkflow" mode="edit" namespace="batch" name="cron" onClose={onClose} onSaved={onSaved} />);
  await waitFor(() => expect(editorView().state.doc.toString()).toBe("kind: CronWorkflow\n"));
  expect(screen.getByLabelText("YAML")).toBeInTheDocument();
  typeYaml("kind: CronWorkflow\nmetadata: {}");
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  fireEvent.click(screen.getByRole("button", { name: "닫기" }));
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "저장" }));
  await waitFor(() => expect(api.update).toHaveBeenCalledWith(CONN, "CronWorkflow", "batch", "cron", "kind: CronWorkflow\nmetadata: {}"));
  expect(onSaved).toHaveBeenCalledWith({ namespace: "batch", name: "cron" });
  confirm.mockRestore();
});

test("다시 제출은 기존 것을 고치지 않고 만든다", async () => {
  api.create.mockResolvedValue({ namespace: "batch", name: "new" });
  render(<ManifestEditor conn={CONN} kind="Workflow" mode="resubmit" namespace="batch" initialYaml="kind: Workflow" onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "만들기" }));
  await waitFor(() => expect(api.create).toHaveBeenCalledWith(CONN, "Workflow", "batch", "kind: Workflow", true));
  expect(api.update).not.toHaveBeenCalled();
});
