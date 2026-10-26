import { useState } from "react";
import { useS3Objects } from "../api/queries";
import type { ServiceInfo } from "../api/types";
import { useCopyShortcut } from "../hooks/useCopyShortcut";
import { s3EntryDetail } from "../lib/detail";
import { prefixSegments, s3EntryToRow, S3_COLUMNS, type S3Location } from "../lib/s3";
import { Breadcrumb, type Segment } from "./Breadcrumb";
import { DetailPanel } from "./DetailPanel";
import { ErrorState } from "./ErrorState";
import { ResourceTable } from "./ResourceTable";
import { StatusBar } from "./StatusBar";

const S3_SERVICE: ServiceInfo = { id: "s3", name: "S3", global: true, types: [] };

interface Props {
  profile: string;
  account: string | undefined;
  location: S3Location;
  filter: string;
  onNavigate: (prefix: string) => void;
  onBack: () => void;
  onRefresh: () => void;
}

export function S3Area({ profile, account, location, filter, onNavigate, onBack, onRefresh }: Props) {
  const q = useS3Objects(profile, location.region, location.bucket, location.prefix);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const entries = q.data?.pages.flatMap((p) => p.entries) ?? [];
  const selected = entries.find((e) => e.key === selectedKey) ?? null;
  useCopyShortcut(selected ? `s3://${location.bucket}/${selected.key}` : null);

  const segments: Segment[] = [
    { label: "Buckets", onClick: onBack },
    { label: location.bucket, onClick: () => onNavigate("") },
    ...prefixSegments(location.prefix).map((s) => ({ label: s.label, onClick: () => onNavigate(s.prefix) })),
  ];

  const open = (key: string) => {
    const entry = entries.find((e) => e.key === key);
    if (entry?.isFolder) onNavigate(entry.key);
  };

  return (
    <>
      <section className="center">
        <Breadcrumb service={S3_SERVICE} segments={segments} count={q.data ? entries.length : undefined} />
        {q.isError && q.data && <ErrorState compact error={q.error} profile={profile} onRetry={onRefresh} />}
        {q.isError && !q.data ? (
          <ErrorState error={q.error} profile={profile} onRetry={onRefresh} />
        ) : q.isPending ? (
          <div className="empty">불러오는 중…</div>
        ) : (
          <>
            <ResourceTable
              columns={S3_COLUMNS}
              items={entries.map(s3EntryToRow)}
              filter={filter}
              selectedId={selectedKey}
              onSelect={setSelectedKey}
              onOpen={open}
            />
            {q.hasNextPage && (
              <button className="btn more" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
                더 보기
              </button>
            )}
          </>
        )}
        <StatusBar profile={profile} account={account} region={location.region} updatedAt={q.dataUpdatedAt} />
      </section>
      <DetailPanel detail={selected ? s3EntryDetail(selected, location.bucket, location.region) : null} onShowRaw={() => {}} />
    </>
  );
}
