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
  onRefresh: () => void;
}

export function ResourceArea({ service, type, profile, region, account, filter, onOpenBucket, onRefresh }: Props) {
  const q = useResources(profile, region, service, type.id);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const items = q.data?.items ?? [];
  const selected = items.find((r) => r.id === selectedId) ?? null;
  useCopyShortcut(selected?.id ?? null);

  const open = (id: string) => {
    if (service.id !== "s3" || type.id !== "buckets") return;
    const bucket = items.find((r) => r.id === id);
    if (bucket) onOpenBucket({ bucket: bucket.id, region: bucket.values.region || region, prefix: "" });
  };

  return (
    <>
      <section className="center">
        <Breadcrumb service={service} segments={[{ label: type.name }]} count={q.data ? items.length : undefined} />
        {q.data?.truncated && <div className="notice">1,000개까지만 표시해요</div>}
        {q.isError ? (
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
