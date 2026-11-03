import { describe, expect, it } from "vitest";
import { ago, cron, HOUR, MIN, NOW, runs, tpl, wf } from "./catalogFixtures";
import { failingCrons, findings, type FindingKind } from "./findings";

const items = (kind: FindingKind, input: Parameters<typeof findings>[0]) => findings(input).find((g) => g.kind === kind)!.items;
const base = { workflows: [], crons: [], templates: [], now: NOW };

describe("failingCrons", () => {
  it("끝난 실행이 3회 이상 연달아 실패한 Cron만", () => {
    const crons = [cron({ name: "a" }), cron({ name: "b" }), cron({ name: "c" })];
    const workflows = [
      ...runs("a", ["Failed", "Error", "Failed", "Succeeded"]),
      ...runs("b", ["Failed", "Failed", "Succeeded", "Failed"]),
      ...runs("c", ["Succeeded", "Failed", "Failed", "Failed"]),
    ];
    expect(failingCrons(crons, workflows).map((c) => c.name)).toEqual(["a"]);
  });

  it("실행 중·대기는 결과가 없어 건너뛰고 세지 않는다", () => {
    const workflows = runs("a", ["Running", "Failed", "Pending", "Failed", "Failed"]);
    expect(failingCrons([cron({ name: "a" })], workflows)).toHaveLength(1);
    expect(failingCrons([cron({ name: "a" })], runs("a", ["Running", "Failed", "Failed"]))).toHaveLength(0);
  });

  it("다른 네임스페이스의 같은 이름 Cron과 섞이지 않는다", () => {
    const workflows = runs("a", ["Failed", "Failed", "Failed"], "other");
    expect(failingCrons([cron({ name: "a", namespace: "batch" })], workflows)).toHaveLength(0);
  });
});

describe("findings", () => {
  it("카드는 항목이 없어도 여섯 개, 위험 → 주의 → 참고 순이다", () => {
    expect(findings(base).map((g) => [g.kind, g.level, g.items.length])).toEqual([
      ["failingCron", "danger", 0],
      ["missedCron", "warn", 0],
      ["longRunning", "warn", 0],
      ["longPending", "warn", 0],
      ["noDeadline", "info", 0],
      ["defaultSA", "info", 0],
    ]);
  });

  it("연속 실패 Cron: 많이 실패한 것이 앞, 내용에 연속 횟수가 있다", () => {
    const crons = [cron({ name: "a" }), cron({ name: "b" })];
    const workflows = [...runs("a", ["Failed", "Failed", "Failed"]), ...runs("b", ["Failed", "Error", "Failed", "Failed"])];
    const found = items("failingCron", { ...base, crons, workflows });
    expect(found.map((i) => i.name)).toEqual(["b", "a"]);
    expect(found[0].detail).toContain("4회 연속 실패");
    expect(found[0].target).toEqual({ type: "cron", namespace: "batch", name: "b" });
  });

  it("놓친 실행", () => {
    const found = items("missedCron", { ...base, crons: [cron({ name: "a", missed: true }), cron({ name: "b" })] });
    expect(found.map((i) => i.name)).toEqual(["a"]);
    expect(found[0].detail).toContain("5시간 전");
  });

  it("오래 실행 중: 1시간을 넘어야 한다(정확히 1시간은 아니다)", () => {
    const at = (ms: number, name: string) => wf({ name, uid: name, phase: "Running", startedAt: ago(ms), finishedAt: null });
    const found = items("longRunning", {
      ...base,
      workflows: [at(HOUR, "exact"), at(HOUR + 1000, "over"), at(3 * HOUR, "older"), wf({ name: "done", uid: "done", startedAt: ago(5 * HOUR) })],
    });
    expect(found.map((i) => i.name)).toEqual(["older", "over"]);
    expect(found[0].detail).toBe("3시간 0분째 실행 중");
    expect(found[0].target).toEqual({ type: "workflow", target: { kind: "live", namespace: "batch", name: "older" } });
  });

  it("정지된 Workflow는 정지됨으로 표시한다", () => {
    const found = items("longRunning", { ...base, workflows: [wf({ phase: "Running", suspended: true, startedAt: ago(2 * HOUR) })] });
    expect(found[0].detail).toContain("정지됨");
  });

  it("워크플로 수준 제한 시간이 있으면 오래 실행 중으로 치지 않는다(그 제한이 끝낸다)", () => {
    const found = items("longRunning", {
      ...base,
      workflows: [wf({ name: "capped", uid: "capped", phase: "Running", startedAt: ago(3 * HOUR), finishedAt: null, activeDeadlineSeconds: 4 * 3600 })],
    });
    expect(found).toEqual([]);
  });

  it("오래 대기: 10분을 넘어야 하고, 시작 시각이 없으면 건너뛴다", () => {
    const pend = (ms: number | null, name: string) => wf({ name, uid: name, phase: "Pending", startedAt: ms === null ? null : ago(ms), finishedAt: null });
    const found = items("longPending", { ...base, workflows: [pend(10 * MIN, "exact"), pend(10 * MIN + 1000, "over"), pend(null, "unknown")] });
    expect(found.map((i) => i.name)).toEqual(["over"]);
  });

  it("제한 시간 없는 Cron·템플릿", () => {
    const found = items("noDeadline", {
      ...base,
      crons: [cron({ name: "a", hasDeadline: false }), cron({ name: "b" })],
      templates: [
        tpl({ name: "t1", hasDeadline: false }),
        tpl({ kind: "ClusterWorkflowTemplate", namespace: null, name: "ct", hasDeadline: false }),
        tpl({ name: "t2" }),
      ],
    });
    expect(found.map((i) => [i.subject, i.name, i.scope])).toEqual([
      ["Cron", "a", "batch"],
      ["템플릿", "t1", "batch"],
      ["클러스터 템플릿", "ct", "클러스터"],
    ]);
    expect(found[2].target).toEqual({ type: "template", kind: "ClusterWorkflowTemplate", namespace: null, name: "ct" });
  });

  it("default ServiceAccount: 이름이 default이거나 정하지 않은 것, 단 템플릿을 참조하는 Cron은 뺀다", () => {
    const found = items("defaultSA", {
      ...base,
      crons: [
        cron({ name: "a", serviceAccount: "default" }),
        cron({ name: "b", serviceAccount: null }),
        cron({ name: "c", serviceAccount: "runner" }),
        cron({ name: "d", serviceAccount: null, template: "report" }),
      ],
      templates: [tpl({ name: "t1", serviceAccount: null }), tpl({ name: "t2", serviceAccount: "default" }), tpl({ name: "t3" })],
    });
    expect(found.map((i) => i.name)).toEqual(["a", "b", "t1", "t2"]);
  });
});
