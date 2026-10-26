import { useState } from "react";
import { GLOBAL, useResources } from "../api/queries";
import type { ResourceType, ServiceInfo } from "../api/types";
import { useCopyShortcut } from "../hooks/useCopyShortcut";
import { resourceDetail } from "../lib/detail";
import type { S3Location } from "../lib/s3";
import { Breadcrumb } from "./Breadcrumb";
import { DetailPanel } from "./DetailPanel";
import { ErrorState } from "./ErrorState";
import { RawModal } from "./RawModal";
import { ResourceTable } from "./ResourceTable";
import { StatusBar } from "./StatusBar";

interface Props {
  service: ServiceInfo;
  type: ResourceType;
  profile: string;
  region: string;
  account: string | undefined;
  filter: string;
  onOpenBucket: (loc: S3Location) => void;
  onOpenVpc?: (vpc: { vpcId: string; name: string; region: string }) => void;
  /** IAM 사용자·역할·정책을 열 때 IAM 작업 공간으로 보낸다. arn이 없으면 대상 없이 탭만 연다. */
  onOpenIam?: (arn: string | null) => void;
  onRefresh: () => void;
  active: boolean;
}

const IAM_OPENABLE = ["users", "roles", "policies"];

export function ResourceArea({ service, type, profile, region, account, filter, onOpenBucket, onOpenVpc, onOpenIam, onRefresh, active }: Props) {
  const q = useResources(profile, region, service, type.id);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const items = q.data?.items ?? [];
  const selected = items.find((r) => r.id === selectedId) ?? null;
  useCopyShortcut(active ? (selected?.id ?? null) : null);

  const open = (id: string) => {
    const item = items.find((r) => r.id === id);
    if (!item) return;
    if (service.id === "s3" && type.id === "buckets") {
      onOpenBucket({ bucket: item.id, region: item.values.region || region, prefix: "" });
    } else if (service.id === "vpc" && type.id === "vpcs") {
      onOpenVpc?.({ vpcId: item.id, name: item.name, region });
    } else if (service.id === "iam" && IAM_OPENABLE.includes(type.id)) {
      onOpenIam?.(item.arn);
    }
  };

  return (
    <>
      <section className="center">
        <Breadcrumb service={service} segments={[{ label: type.name }]} count={q.data ? items.length : undefined} />
        {q.data?.truncated && <div className="notice">1,000개까지만 표시해요</div>}
        {q.isError && q.data && <ErrorState compact error={q.error} profile={profile} onRetry={onRefresh} />}
        {q.isError && !q.data ? (
          <ErrorState error={q.error} profile={profile} onRetry={onRefresh} />
        ) : q.isPending ? (
          <div className="empty">불러오는 중…</div>
        ) : (
          <ResourceTable
            columns={type.columns}
            items={items}
            filter={filter}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onOpen={open}
          />
        )}
        <StatusBar profile={profile} account={account} region={service.global ? GLOBAL : region} updatedAt={q.dataUpdatedAt} />
      </section>
      <DetailPanel detail={selected ? resourceDetail(selected, type, service) : null} onShowRaw={() => setShowRaw(true)} />
      {showRaw && selected && <RawModal title={selected.name} text={selected.raw} onClose={() => setShowRaw(false)} />}
    </>
  );
}
