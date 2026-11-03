import { LOG_COLORS, logFileName, shortPod, sourceLabels, type SourceRef } from "./logSources";

const src = (pod: string, container: string): SourceRef => ({ key: `${pod}/${container}`, pod, container });

test("short pod names drop the workload name and a deployment's replica hash; ordinals and foreign names stay whole", () => {
  expect(shortPod("web-7d9f8c6b5-abcde", "web")).toBe("abcde");
  expect(shortPod("web-0", "web")).toBe("web-0");
  expect(shortPod("batch-x7k2p", "batch")).toBe("x7k2p");
  expect(shortPod("other-7d9f8c6b5-abcde", "web")).toBe("other-7d9f8c6b5-abcde");
  expect(shortPod("web-7d9f8c6b5-abcde", "")).toBe("web-7d9f8c6b5-abcde");
});

test("one source needs no labels; the color follows the pod name (or the container for one pod) and never changes", () => {
  expect(sourceLabels([src("web-1", "app")], "")).toBeNull();
  const two = sourceLabels([src("web-1", "app"), src("web-2", "app")], "")!;
  const again = sourceLabels([src("web-2", "app"), src("web-1", "app"), src("web-3", "app")], "")!;
  expect(two.get("web-1/app")!.color).toBe(again.get("web-1/app")!.color);
  expect(two.get("web-2/app")!.color).toBe(again.get("web-2/app")!.color);
  for (const l of again.values()) {
    expect(l.color).toBeGreaterThanOrEqual(1);
    expect(l.color).toBeLessThanOrEqual(LOG_COLORS);
  }
  // 같은 Pod의 컨테이너들은 같은 Pod 이름 아래에서 한 색
  const mixed = sourceLabels([src("web-1", "app"), src("web-1", "sidecar"), src("web-2", "app")], "")!;
  expect(mixed.get("web-1/app")!.color).toBe(mixed.get("web-1/sidecar")!.color);
  expect(mixed.get("web-1/sidecar")!.text).toBe("web-1/sidecar");
  // 한 Pod의 컨테이너만이면 컨테이너 이름만
  const one = sourceLabels([src("web-1", "app"), src("web-1", "sidecar")], "")!;
  expect(one.get("web-1/app")!.text).toBe("app");
});

test("the saved file name is <name>-<YYYYMMDD-HHMMSS>.log in local time", () => {
  expect(logFileName("web", new Date(2026, 10, 3, 4, 5, 9))).toBe("web-20261103-040509.log");
});
