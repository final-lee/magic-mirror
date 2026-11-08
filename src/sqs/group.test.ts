import { describe, expect, it } from "vitest";
import { groupQueues, hasProblem, listRows, queueHealth, visibleRows } from "./group";
import type { FindingLevel, SqsFinding, SqsQueue } from "./types";

const arn = (name: string) => `arn:aws:sqs:ap-northeast-2:111122223333:${name}`;

function finding(level: FindingLevel): SqsFinding {
  return { id: "noDlq", level, summary: "요약", detail: null };
}

function queue(name: string, over: Partial<SqsQueue> & { dlq?: string; levels?: FindingLevel[] } = {}): SqsQueue {
  const { dlq, levels = [], ...rest } = over;
  return {
    url: `https://sqs.ap-northeast-2.amazonaws.com/111122223333/${name}`,
    arn: arn(name),
    name,
    fifo: name.endsWith(".fifo"),
    visible: 0,
    inFlight: 0,
    delayed: 0,
    visibilityTimeout: 30,
    retention: 345600,
    delay: 0,
    maxSize: 262144,
    waitTime: 0,
    redrive: dlq ? { dlqArn: arn(dlq), maxReceiveCount: 5 } : null,
    redriveAllow: null,
    sseManaged: true,
    kmsKey: null,
    contentDedup: null,
    dedupScope: null,
    throughputLimit: null,
    policy: null,
    createdAt: null,
    modifiedAt: null,
    sources: [],
    isDlq: false,
    activity: null,
    tags: {},
    findings: levels.map(finding),
    error: null,
    ...rest,
  };
}

const shape = (rows: { queue: SqsQueue; depth?: number }[]) => rows.map((r) => `${r.depth ? "  " : ""}${r.queue.name}`);

describe("groupQueues", () => {
  it("원본이 하나뿐인 DLQ는 원본 바로 아래에 들여 쓴다", () => {
    const rows = groupQueues([queue("b-dlq", { isDlq: true }), queue("c"), queue("a", { dlq: "a-dlq" }), queue("a-dlq", { isDlq: true }), queue("b", { dlq: "b-dlq" })]);
    expect(rows.map((r) => [r.queue.name, r.parent])).toEqual([
      ["a", null],
      ["a-dlq", arn("a")],
      ["b", null],
      ["b-dlq", arn("b")],
      ["c", null],
    ]);
  });

  it("원본이 여럿인 DLQ는 맨 위 단계에 두고 원본 수를 센다. 원본은 따로 남는다", () => {
    const rows = groupQueues([queue("shared-dlq", { isDlq: true }), queue("x", { dlq: "shared-dlq" }), queue("y", { dlq: "shared-dlq" }), queue("z")]);
    expect(rows.map((r) => [r.queue.name, r.parent])).toEqual([
      ["shared-dlq", null],
      ["x", null],
      ["y", null],
      ["z", null],
    ]);
    expect(rows[0].sourceCount).toBe(2);
    expect(rows[3].sourceCount).toBe(0);
  });

  it("목록이 잘려 원본이 없으면 DLQ는 맨 위 단계에 두고 백엔드가 알려 준 원본도 센다", () => {
    const rows = groupQueues([queue("lonely-dlq", { isDlq: true, sources: [arn("gone")] })]);
    expect(rows).toEqual([{ queue: expect.objectContaining({ name: "lonely-dlq" }), parent: null, sourceCount: 1 }]);
  });

  it("DLQ의 DLQ는 한 단계까지만 들여 쓴다", () => {
    const rows = groupQueues([queue("a", { dlq: "b" }), queue("b", { dlq: "c", isDlq: true }), queue("c", { isDlq: true })]);
    expect(rows.map((r) => [r.queue.name, r.parent !== null])).toEqual([
      ["a", false],
      ["b", true],
      ["c", false],
    ]);
  });

  it("서로를 DLQ로 가리키는 순환에서도 끝나고 큐를 잃지 않는다", () => {
    const rows = groupQueues([queue("a", { dlq: "b", isDlq: true }), queue("b", { dlq: "a", isDlq: true })]);
    expect(rows.map((r) => r.queue.name).sort()).toEqual(["a", "b"]);
    expect(rows.filter((r) => r.parent !== null)).toHaveLength(1);
  });
});

describe("queueHealth·hasProblem", () => {
  it("가장 높은 수준을 따르고 정보 수준은 문제가 아니다", () => {
    expect(queueHealth(queue("a", { levels: ["info", "warn", "fail"] }))).toBe("fail");
    expect(queueHealth(queue("a", { levels: ["info", "warn"] }))).toBe("warn");
    expect(hasProblem(queue("a", { levels: ["info"] }))).toBe(false);
    expect(hasProblem(queue("a"))).toBe(false);
  });

  it("속성을 읽지 못한 큐는 문제로 센다", () => {
    const q = queue("denied", { error: "권한이 없어요" });
    expect(queueHealth(q)).toBe("unknown");
    expect(hasProblem(q)).toBe(true);
  });
});

describe("listRows", () => {
  const all = [
    queue("orders", { dlq: "orders-dlq", levels: ["fail"] }),
    queue("orders-dlq", { isDlq: true, levels: ["fail"] }),
    queue("mails", { dlq: "mails-dlq" }),
    queue("mails-dlq", { isDlq: true }),
    queue("audit", { levels: ["info"] }),
  ];

  it("문제 있는 큐만 보이면 원본과 DLQ가 둘 다 문제일 때만 묶음이 남는다", () => {
    expect(shape(listRows(all, { problemOnly: true, query: "" }))).toEqual(["orders", "  orders-dlq"]);
  });

  it("원본이 걸러지면 그 DLQ는 맨 위 단계로 나온다", () => {
    const rows = listRows([queue("orders", { dlq: "orders-dlq" }), queue("orders-dlq", { isDlq: true, levels: ["warn"] })], { problemOnly: true, query: "" });
    expect(rows.map((r) => [r.queue.name, r.depth])).toEqual([["orders-dlq", 0]]);
  });

  it("퍼지 검색은 글자가 순서대로 있는 큐만 남기고 묶음 순서를 지킨다", () => {
    expect(shape(listRows(all, { problemOnly: false, query: "ord" }))).toEqual(["orders", "  orders-dlq"]);
    expect(shape(listRows(all, { problemOnly: false, query: "mdlq" }))).toEqual(["mails-dlq"]);
    expect(listRows(all, { problemOnly: false, query: "zzz" })).toEqual([]);
  });

  it("검색과 문제 필터를 함께 건다", () => {
    expect(listRows(all, { problemOnly: true, query: "mails" })).toEqual([]);
  });

  it("거르지 않으면 묶음 순서 그대로다", () => {
    const groups = groupQueues(all);
    expect(visibleRows(groups, () => true).map((r) => r.queue.name)).toEqual(["audit", "mails", "mails-dlq", "orders", "orders-dlq"]);
  });
});
