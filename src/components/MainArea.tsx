import type { Favorite, ServiceInfo } from "../api/types";
import type { S3Location } from "../lib/s3";
import { ResourceArea } from "./ResourceArea";
import { S3Area } from "./S3Area";

interface Props {
  services: ServiceInfo[];
  selection: Favorite | null;
  profile: string | null;
  region: string;
  account: string | undefined;
  filter: string;
  s3: S3Location | null;
  onS3Change: (loc: S3Location | null) => void;
  onRefresh: () => void;
}

export function MainArea({ services, selection, profile, region, account, filter, s3, onS3Change, onRefresh }: Props) {
  const service = services.find((s) => s.id === selection?.service);
  const type = service?.types.find((t) => t.id === selection?.type);
  if (!profile || !service || !type) {
    return (
      <section className="center">
        <div className="empty">왼쪽에서 리소스 타입을 고르세요</div>
      </section>
    );
  }
  if (service.id === "s3" && s3) {
    return (
      <S3Area
        profile={profile}
        account={account}
        location={s3}
        filter={filter}
        onNavigate={(prefix) => onS3Change({ ...s3, prefix })}
        onBack={() => onS3Change(null)}
        onRefresh={onRefresh}
      />
    );
  }
  return (
    <ResourceArea
      service={service}
      type={type}
      profile={profile}
      region={region}
      account={account}
      filter={filter}
      onOpenBucket={onS3Change}
      onRefresh={onRefresh}
    />
  );
}
