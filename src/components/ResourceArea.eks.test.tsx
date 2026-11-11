import { fireEvent, screen } from "@testing-library/react";
import { ResourceArea } from "./ResourceArea";
import { eksService, makeResource, renderWithClient } from "../test/utils";
import { api } from "../api/client";
import type { K8sTarget } from "../k8s/types";

vi.mock("../api/client", () => ({ api: { listResources: vi.fn(), ssoLogin: vi.fn() } }));
vi.mock("../api/desktop", () => ({ desktop: { copy: vi.fn(), openUrl: vi.fn() } }));
// 상세의 두 요약은 클러스터 하나에 하나씩만 있어야 한다. 내용(연결·지표)은 이 시험의 관심이 아니다
vi.mock("../k8s/ClusterDetailSummary", () => ({
  ClusterDetailSummary: ({ target }: { target: K8sTarget }) => <section aria-label="클러스터 사용량">{target.cluster} 사용량</section>,
}));
vi.mock("./ResourceMetrics", () => ({
  ResourceMetrics: ({ row }: { row: { id: string } }) => <section aria-label="지표">{row.id} 지표</section>,
}));

const service = { ...eksService, metricTypes: ["clusters"] };
const clusters = service.types.find((t) => t.id === "clusters")!;

test("고른 클러스터의 요약만 보이고, 앞서 고른 클러스터의 요약이 쌓이지 않아요", async () => {
  vi.mocked(api.listResources).mockResolvedValue({ items: ["broken", "blue", "green"].map((id) => makeResource(id, { name: id })), truncated: false });
  renderWithClient(<ResourceArea profile="prod" region="ap-northeast-2" account="123456789012" onOpenBucket={vi.fn()} onRefresh={vi.fn()} active service={service} type={clusters} />);
  for (const id of ["broken", "blue", "green", "blue"]) {
    fireEvent.click(await screen.findByRole("cell", { name: id }));
    expect(screen.getAllByRole("region", { name: "클러스터 사용량" }).map((s) => s.textContent)).toEqual([`${id} 사용량`]);
    expect(screen.getAllByRole("region", { name: "지표" }).map((s) => s.textContent)).toEqual([`${id} 지표`]);
  }
});
