import { describe, expect, it } from "vitest";
import { cronsUsing, failStreak, namespacesOf, runsByCron, runsByTemplate, successRate, templateKey } from "./catalogData";
import { cron, runs, wf } from "./catalogFixtures";
import { durationText, relTime, spanText } from "./catalogFormat";

describe("runsByCron", () => {
  it("cron 레이블로 모으고 최근 것부터 놓는다(시작 전인 것은 맨 앞)", () => {
    const pending = wf({ name: "queued", uid: "q", cron: "a", phase: "Pending", startedAt: null, finishedAt: null });
    const map = runsByCron([...runs("a", ["Succeeded", "Failed", "Failed"]).reverse(), pending, wf({ name: "manual", uid: "m" })]);
    expect(map.get("batch/a")!.map((w) => w.name)).toEqual(["queued", "a-0", "a-1", "a-2"]);
    expect(map.size).toBe(1);
  });
});

describe("failStreak", () => {
  it("성공을 만나면 멈춘다", () => {
    expect(failStreak(runs("a", ["Failed", "Error", "Succeeded", "Failed"]))).toBe(2);
    expect(failStreak([])).toBe(0);
  });
});

describe("templates", () => {
  it("템플릿 열쇠: ClusterWorkflowTemplate은 네임스페이스와 무관", () => {
    expect(templateKey("ClusterWorkflowTemplate", null, "t")).toBe("*/t");
    expect(templateKey("WorkflowTemplate", "batch", "t")).toBe("batch/t");
  });

  it("runsByTemplate: 클러스터 템플릿 레이블과 네임스페이스 템플릿 레이블을 가른다", () => {
    const map = runsByTemplate([
      wf({ name: "a", uid: "a", template: "t" }),
      wf({ name: "b", uid: "b", template: "t", clusterTemplate: true, namespace: "other" }),
      wf({ name: "c", uid: "c", template: "t", namespace: "other" }),
    ]);
    expect(map.get("batch/t")!.map((w) => w.name)).toEqual(["a"]);
    expect(map.get("*/t")!.map((w) => w.name)).toEqual(["b"]);
    expect(map.get("other/t")!.map((w) => w.name)).toEqual(["c"]);
  });

  it("cronsUsing: 네임스페이스 템플릿은 같은 네임스페이스의 Cron만, 클러스터 템플릿은 어디든", () => {
    const crons = [
      cron({ name: "a", template: "t" }),
      cron({ name: "b", template: "t", namespace: "other" }),
      cron({ name: "c", template: "t", clusterTemplate: true, namespace: "other" }),
      cron({ name: "d", template: "x" }),
    ];
    expect(cronsUsing(crons, { kind: "WorkflowTemplate", namespace: "batch", name: "t" }).map((c) => c.name)).toEqual(["a"]);
    expect(cronsUsing(crons, { kind: "ClusterWorkflowTemplate", namespace: null, name: "t" }).map((c) => c.name)).toEqual(["c"]);
  });

  it("successRate: 끝난 최근 20개만 센다", () => {
    expect(successRate([])).toBeNull();
    expect(successRate([wf({ phase: "Running" })])).toBeNull();
    const many = runs("a", [...Array<"Failed">(20).fill("Failed"), "Succeeded", "Succeeded"]);
    expect(successRate(many)).toEqual({ ok: 0, total: 20 });
    expect(successRate(runs("a", ["Running", "Succeeded", "Failed", "Error", "Succeeded"]))).toEqual({ ok: 2, total: 4 });
  });

  it("namespacesOf: 중복 없이 정렬", () => {
    expect(namespacesOf([{ namespace: "b" }, { namespace: "a" }], [{ namespace: "b" }])).toEqual(["a", "b"]);
  });
});

describe("시간 글", () => {
  const now = Date.parse("2026-11-03T12:00:00Z");
  it("relTime", () => {
    expect(relTime("2026-11-03T11:55:00Z", now)).toBe("5분 전");
    expect(relTime("2026-11-03T15:00:00Z", now)).toBe("3시간 후");
    expect(relTime("2026-11-03T11:59:30Z", now)).toBe("30초 전");
    expect(relTime("2026-11-01T11:00:00Z", now)).toBe("2일 전");
    expect(relTime(null, now)).toBe("");
    expect(relTime("엉뚱", now)).toBe("");
  });
  it("spanText·durationText", () => {
    expect(spanText(45_000)).toBe("45초");
    expect(spanText(192_000)).toBe("3분 12초");
    expect(spanText(7_500_000)).toBe("2시간 5분");
    expect(spanText(27 * 3_600_000)).toBe("1일 3시간");
    expect(durationText("2026-11-03T11:00:00Z", "2026-11-03T11:03:12Z", now)).toBe("3분 12초");
    expect(durationText("2026-11-03T11:00:00Z", null, now)).toBe("1시간 0분");
    expect(durationText(null, null, now)).toBe("");
  });
});
