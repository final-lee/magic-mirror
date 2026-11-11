import type { Resource, ServiceInfo } from "../api/types";
import { ResourceMetrics } from "../components/ResourceMetrics";
import * as t from "./text";
import type { SnsTopic } from "./types";

// 지표 화면은 리소스 브라우저 상세의 지표를 그대로 쓴다(서비스 sns, 종류 topics, 행은 주제). 차원은 백엔드가 행의 이름으로 만든다.
const SNS_SERVICE: ServiceInfo = { id: "sns", name: "SNS", global: false, types: [] };

/** 지표: 주제의 CloudWatch 지표. 저절로 다시 읽지 않고 [다시 읽기]가 읽는다(ResourceMetrics) */
export function Metrics({ profile, topic }: { profile: string; topic: SnsTopic }) {
  const row: Resource = { id: topic.arn, name: topic.name, arn: topic.arn, values: { name: topic.name }, tags: topic.tags, fields: [], raw: "", consoleUrl: null };
  return (
    <section className="center sns-pane" aria-label={t.METRICS_LABEL}>
      <ResourceMetrics profile={profile} region={topic.region} service={SNS_SERVICE} typeId="topics" row={row} />
    </section>
  );
}
