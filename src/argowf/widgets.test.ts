import { describe, expect, it } from "vitest";
import { argoUiUrl, widgetUrls } from "./widgets";

describe("Argo 주소", () => {
  it("위젯 레이블과 네임스페이스를 인코딩한다", () => {
    expect(widgetUrls("https://argo/", "team a", "a=b,c=d")).toEqual({
      badge: "https://argo/widgets/workflow-status-badges/team%20a?label=a%3Db%2Cc%3Dd",
      graph: "https://argo/widgets/workflow-graphs/team%20a?label=a%3Db%2Cc%3Dd",
    });
  });
  it("클러스터와 네임스페이스 리소스 주소를 만든다", () => {
    expect(argoUiUrl("https://argo", "workflow", "ns", "job")).toBe("https://argo/workflows/ns/job");
    expect(argoUiUrl("https://argo", "cron", "ns", "job")).toBe("https://argo/cron-workflows/ns/job");
    expect(argoUiUrl("https://argo", "template", "ns", "job")).toBe("https://argo/workflow-templates/ns/job");
    expect(argoUiUrl("https://argo", "clusterTemplate", null, "job")).toBe("https://argo/cluster-workflow-templates/job");
  });
});
