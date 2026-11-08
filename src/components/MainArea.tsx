import type { Favorite, ServiceInfo } from "../api/types";
import type { S3Location } from "../lib/s3";
import type { K8sTarget } from "../k8s/types";
import type { KvTarget } from "../kv/types";
import type { PgTarget } from "../pg/types";
import type { SnsRoute } from "../sns/route";
import type { SnsTopicRef } from "../sns/targets";
import { ResourceArea, type ResourceFocus } from "./ResourceArea";

interface Props {
  services: ServiceInfo[];
  selection: Favorite | null;
  profile: string | null;
  region: string;
  account: string | undefined;
  onOpenBucket: (loc: S3Location) => void;
  onOpenVpc?: (vpc: { vpcId: string; name: string; region: string }) => void;
  onOpenIam?: (arn: string | null) => void;
  onOpenPg?: (target: PgTarget) => void;
  onOpenK8s?: (target: K8sTarget) => void;
  onOpenKv?: (target: KvTarget) => void;
  /** SQS 큐를 열 때 그 리전의 SQS 탭으로 보내고 그 큐를 고른다 */
  onOpenSqs?: (region: string, url: string) => void;
  onOpenSns?: (target: SnsTopicRef, route?: SnsRoute) => void;
  onRefresh: () => void;
  active: boolean;
  focus?: ResourceFocus | null;
}

export function MainArea({ services, selection, profile, region, account, onOpenBucket, onOpenVpc, onOpenIam, onOpenPg, onOpenK8s, onOpenKv, onOpenSqs, onOpenSns, onRefresh, active, focus = null }: Props) {
  const service = services.find((s) => s.id === selection?.service);
  const type = service?.types.find((t) => t.id === selection?.type);
  if (!profile || !service || !type) {
    return (
      <section className="center">
        <div className="empty">왼쪽에서 리소스 타입을 고르세요</div>
      </section>
    );
  }
  return (
    <ResourceArea
      service={service}
      type={type}
      profile={profile}
      region={region}
      account={account}
      onOpenBucket={onOpenBucket}
      onOpenVpc={onOpenVpc}
      onOpenIam={onOpenIam}
      onOpenPg={onOpenPg}
      onOpenK8s={onOpenK8s}
      onOpenKv={onOpenKv}
      onOpenSqs={onOpenSqs}
      onOpenSns={onOpenSns}
      onRefresh={onRefresh}
      active={active}
      focus={focus}
    />
  );
}
