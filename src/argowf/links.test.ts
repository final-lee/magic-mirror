import { expandLink, linksFor, podLinkVars, workflowLinkVars } from "./links";
import { node, row } from "./shellFixtures";

const link = (url: string) => ({ name: "로그", scope: "workflow", url });

test("Argo처럼 ${…}와 $%7B…%7D 자리를 값으로 바꾸고 모르는 변수는 비운다", () => {
  const vars = workflowLinkVars(
    row("job-1", "Running", {
      namespace: "ci",
      labels: { "app.kubernetes.io/name": "etl" },
      startedAt: "2026-01-01T00:00:00Z",
      finishedAt: "2026-01-01T00:10:00Z",
    }),
  );
  expect(expandLink(link("https://logs/${metadata.namespace}/${metadata.name}?from=${status.startedAtEpoch}&to=${status.finishedAtEpoch}"), vars)).toBe(
    `https://logs/ci/job-1?from=${Date.parse("2026-01-01T00:00:00Z")}&to=${Date.parse("2026-01-01T00:10:00Z")}`,
  );
  expect(expandLink(link("https://x/${workflow.metadata.name}/${metadata.labels.app.kubernetes.io/name}/$%7Bmetadata.name%7D/${nope}"), vars)).toBe(
    "https://x/job-1/etl/job-1/",
  );
});

test("끝나지 않은 Workflow의 finishedAtEpoch는 지금이다", () => {
  const before = Date.now();
  const url = expandLink(link("${status.finishedAtEpoch}"), workflowLinkVars(row("job", "Running")));
  expect(Number(url)).toBeGreaterThanOrEqual(before);
});

test("pod 링크는 metadata를 Pod 것으로, workflow.*는 Workflow 것으로 채운다", () => {
  const vars = podLinkVars(row("job", "Running", { namespace: "ci" }), node("n1", { podName: "job-n1-123", startedAt: "2026-01-01T00:00:00Z" }));
  expect(expandLink(link("${metadata.namespace}/${metadata.name}/${workflow.metadata.name}/${status.startedAt}"), vars)).toBe(
    "ci/job-n1-123/job/2026-01-01T00:00:00Z",
  );
});

test("linksFor는 scope가 같은 링크만 고른다", () => {
  const links = [link("a"), { name: "채팅", scope: "chat", url: "b" }];
  expect(linksFor(links, "chat").map((l) => l.name)).toEqual(["채팅"]);
});
