import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithClient } from "../test/utils";
import { argowfApi } from "./api";
import { NodeDetail } from "./NodeDetail";
import { conn, detailOf, node, row } from "./shellFixtures";
import type { WfNode } from "./types";

vi.mock("./api", () => ({ argowfApi: { artifactPreview: vi.fn(), saveArtifact: vi.fn() } }));
const target = { kind: "live" as const, namespace: "test", name: "job" };

function show(n: WfNode, act = vi.fn().mockResolvedValue(null), extra: Partial<Parameters<typeof NodeDetail>[0]> = {}) {
  const detail = detailOf({ row: row("job", "Running"), nodes: [n], parameters: [{ name: "who", value: "alice" }] });
  renderWithClient(
    <NodeDetail
      conn={conn}
      detail={detail}
      node={n}
      target={target}
      links={[]}
      act={act}
      onLogs={vi.fn()}
      onNotice={vi.fn()}
      onTokenError={vi.fn()}
      {...extra}
    />,
  );
  return act;
}

test("실패한 노드 하나만 Retry하면 id 선택자와 바꾼 파라미터를 보낸다", async () => {
  const act = show(node("job-node-1", { phase: "Failed" }));
  fireEvent.click(screen.getByRole("button", { name: "이 노드만 Retry" }));
  fireEvent.change(screen.getByDisplayValue("alice"), { target: { value: "bob" } });
  fireEvent.click(screen.getByRole("button", { name: "적용" }));
  await waitFor(() =>
    expect(act).toHaveBeenCalledWith({ kind: "retry", restartSuccessful: false, nodeFieldSelector: "id=job-node-1", parameters: ["who=bob"] }),
  );
});

test("실패하면 대화상자에 서버 메시지를 보이고 닫지 않는다", async () => {
  show(node("n", { phase: "Failed" }), vi.fn().mockRejectedValue({ kind: "other", message: "충돌했어요" }));
  fireEvent.click(screen.getByRole("button", { name: "이 노드만 Retry" }));
  fireEvent.click(screen.getByRole("button", { name: "적용" }));
  expect(await screen.findByText("충돌했어요")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
});

test("Suspend 노드는 출력 파라미터를 채워 setOutputs 다음에 resume을 보낸다", async () => {
  const act = show(
    node("approval", {
      type: "Suspend",
      phase: "Running",
      podName: null,
      outputs: [
        { name: "decision", value: null, default: "approve", enum: ["approve", "reject"] },
        { name: "note", value: null, default: "" },
      ],
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "값 넣고 이어 가기" }));
  expect(screen.getByDisplayValue("approve")).toBeInTheDocument();
  fireEvent.change(screen.getByDisplayValue("approve"), { target: { value: "reject" } });
  fireEvent.change(screen.getByLabelText("note"), { target: { value: "맞지 않아요" } });
  fireEvent.click(screen.getByRole("button", { name: "적용" }));
  await waitFor(() => expect(act).toHaveBeenCalledTimes(2));
  expect(act).toHaveBeenNthCalledWith(
    1,
    { kind: "setOutputs", nodeFieldSelector: "id=approval", outputParameters: { decision: "reject", note: "맞지 않아요" }, phase: null },
    false,
  );
  expect(act).toHaveBeenNthCalledWith(2, { kind: "resume", nodeFieldSelector: "id=approval" });
});

test("setOutputs가 실패하면 resume은 보내지 않는다", async () => {
  const act = show(
    node("approval", { type: "Suspend", phase: "Running", podName: null, outputs: [{ name: "x", value: "1" }] }),
    vi.fn().mockRejectedValue({ kind: "other", message: "거절" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "값 넣고 이어 가기" }));
  fireEvent.click(screen.getByRole("button", { name: "적용" }));
  expect(await screen.findByText("거절")).toBeInTheDocument();
  expect(act).toHaveBeenCalledTimes(1);
});

test("실행 중 노드의 Stop은 id 선택자로 보내고 prod면 워크플로 이름을 요구한다", async () => {
  const act = vi.fn().mockResolvedValue(null);
  const n = node("n1", { phase: "Running" });
  const detail = detailOf({ nodes: [n] });
  renderWithClient(
    <NodeDetail
      conn={conn}
      detail={{ ...detail, row: { ...detail.row, phase: "Running" } }}
      node={n}
      target={target}
      links={[]}
      act={act}
      onLogs={vi.fn()}
      onNotice={vi.fn()}
      onTokenError={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "노드 Stop" }));
  expect(screen.getByRole("button", { name: "적용" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText(/확인하려면/), { target: { value: "prod-job" } });
  fireEvent.click(screen.getByRole("button", { name: "적용" }));
  await waitFor(() => expect(act).toHaveBeenCalledWith({ kind: "stop", nodeFieldSelector: "id=n1", message: null }));
});

test("아티팩트를 미리 보면 JSON은 들여써 보이고 이미지는 그림으로 보인다", async () => {
  vi.mocked(argowfApi.artifactPreview).mockImplementation(async (_c, ref) =>
    ref.name === "pic"
      ? { contentType: "image/png", size: 3, text: null, imageBase64: "AAAA" }
      : { contentType: "application/json", size: 7, text: '{"a":1}', imageBase64: null },
  );
  show(
    node("n", {
      phase: "Succeeded",
      artifacts: [
        { name: "data", direction: "output", key: "k/data", repository: "s3" },
        { name: "pic", direction: "output", key: null, repository: null },
      ],
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "data 미리보기" }));
  expect((await screen.findByLabelText("data 내용")).textContent).toBe('{\n  "a": 1\n}');
  expect(argowfApi.artifactPreview).toHaveBeenCalledWith(conn, { target, nodeId: "n", name: "data", direction: "output" });
  fireEvent.click(screen.getByRole("button", { name: "pic 미리보기" }));
  expect(await screen.findByRole("img", { name: "pic" })).toHaveAttribute("src", "data:image/png;base64,AAAA");
});

test("내려받기는 저장 창 결과 경로를 알린다", async () => {
  vi.mocked(argowfApi.saveArtifact).mockResolvedValue("/tmp/data.bin");
  const notice = vi.fn();
  show(node("n", { phase: "Succeeded", artifacts: [{ name: "data", direction: "output", key: null, repository: null }] }), undefined, { onNotice: notice });
  fireEvent.click(screen.getByRole("button", { name: "data 내려받기" }));
  await waitFor(() => expect(notice).toHaveBeenCalledWith("data을(를) 저장했어요: /tmp/data.bin"));
});

test("Containers, host, memoization, 예상 시간을 보인다", () => {
  show(
    node("n", {
      phase: "Succeeded",
      hostNodeName: "ip-10-0-0-1",
      estimatedDuration: 90,
      memoization: { hit: true, key: "k1", cacheName: "cache-a" },
      containers: [
        {
          name: "main",
          role: "main",
          image: "busybox:1",
          command: ["sh"],
          args: ["-c", "echo"],
          workingDir: "/w",
          env: ["TOKEN"],
          requests: { cpu: "1" },
          limits: { memory: "1Gi" },
          volumeMounts: ["/data"],
        },
      ],
    }),
  );
  expect(screen.getByText("Host node: ip-10-0-0-1")).toBeInTheDocument();
  expect(screen.getByText("예상 걸린 시간: 90초")).toBeInTheDocument();
  expect(screen.getByText(/Memoization: 적중/)).toBeInTheDocument();
  expect(screen.getByText("busybox:1")).toBeInTheDocument();
  expect(screen.getByText("sh, -c, echo")).toBeInTheDocument();
  expect(screen.getByText("cpu=1")).toBeInTheDocument();
});
