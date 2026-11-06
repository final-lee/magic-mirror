import { fireEvent, screen } from "@testing-library/react";
import { renderWithClient } from "../test/utils";
import { sqsApi } from "./api";
import { RegionFlow, regionFlowLanes } from "./RegionFlow";
import type { FlowNode, SqsQueue } from "./types";

vi.mock("./api", () => ({ sqsApi: { regionFlow: vi.fn() } }));
const m = vi.mocked(sqsApi);

const arn = (name: string) => `arn:aws:sqs:ap-northeast-2:111122223333:${name}`;
const node = (over: Partial<FlowNode>): FlowNode => ({ kind: "sns", id: "n", label: "n", state: null, allowedByPolicy: null, crossAccount: false, detail: [], jump: null, ...over });
const queue = { url: "https://sqs/orders", arn: arn("orders"), name: "orders", findings: [], error: null } as unknown as SqsQueue;

it("생산자 없는 큐와 DLQ, 양방향 Pipe를 고정 레인에 둔다", () => {
  const nodes = [
    node({ id: "sns" }), node({ kind: "rule", id: "rule" }), node({ kind: "s3", id: "s3" }),
    node({ kind: "pipe", id: "in" }), node({ kind: "pipe", id: "out" }),
    node({ kind: "queue", id: "q" }), node({ kind: "queue", id: "isolated" }), node({ kind: "queue", id: "dlq" }),
    node({ kind: "queue", id: "active-dlq" }), node({ kind: "lambda", id: "lambda" }),
  ];
  const edges = [
    { from: "in", to: "q", kind: "pipe" as const },
    { from: "q", to: "out", kind: "pipe" as const },
    { from: "q", to: "lambda", kind: "esm" as const },
    { from: "q", to: "dlq", kind: "dlq" as const },
    { from: "active-dlq", to: "lambda", kind: "esm" as const },
  ];
  const lanes = regionFlowLanes(nodes, edges, [
    { ...queue, arn: "dlq", isDlq: true }, { ...queue, arn: "active-dlq", isDlq: true },
  ]);
  expect(Object.fromEntries(lanes)).toEqual({
    sns: 0, rule: 0, s3: 0, in: 0, out: 2, q: 1, isolated: 1, dlq: 2, "active-dlq": 1, lambda: 2,
  });
});

it("리전 흐름을 노드로 그리고, 큐는 탭 안에서 소비자는 앱으로 이동시킨다", async () => {
  m.regionFlow.mockResolvedValue({
    nodes: [
      node({ kind: "sns", id: "arn:topic", label: "alerts" }),
      node({ kind: "queue", id: arn("orders"), label: "orders" }),
      node({ kind: "lambda", id: "arn:fn", label: "worker", jump: { kind: "resource", service: "lambda", type: "functions", id: "worker" } }),
    ],
    edges: [
      { from: "arn:topic", to: arn("orders"), kind: "subscription" },
      { from: arn("orders"), to: "arn:fn", kind: "esm" },
      { from: arn("orders"), to: "arn:missing", kind: "pipe" },
    ],
    gaps: [{ section: "Pipes", error: "권한이 없어요" }],
  });
  const onJump = vi.fn();
  renderWithClient(<RegionFlow profile="personal" region="ap-northeast-2" queues={[queue]} onJump={onJump} />);

  expect((await screen.findAllByText("alerts")).length).toBeGreaterThan(0);
  expect(screen.getByText("Pipes: 권한이 없어요")).toBeInTheDocument();
  // 노드 없는 끝을 가리키는 연결은 버린다
  expect(screen.queryByText("Pipe")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "alerts 열기" })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "orders 열기" }));
  expect(onJump).toHaveBeenLastCalledWith({ kind: "queue", url: "https://sqs/orders" });
  fireEvent.click(screen.getByRole("button", { name: "worker 열기" }));
  expect(onJump).toHaveBeenLastCalledWith({ kind: "resource", service: "lambda", type: "functions", id: "worker" });
});
