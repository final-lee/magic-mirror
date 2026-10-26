import { useResources, useS3Objects } from "../api/queries";
import type { ServiceInfo } from "../api/types";
import { ErrorState } from "../components/ErrorState";
import { prefixSegments, s3EntryToRow, S3_COLUMNS, type S3Location } from "../lib/s3";
import { FileTable } from "./FileTable";
import { parentPrefix } from "./rows";
import type { SelectionState } from "./selection";

interface Props {
  profile: string;
  region: string;
  s3Service: ServiceInfo;
  location: S3Location | null;
  onLocationChange: (loc: S3Location | null) => void;
  filter: string;
  selection: SelectionState;
  onSelectionChange: (s: SelectionState) => void;
  focused: boolean;
  onFocus: () => void;
  onDragStart: (ids: string[], point: { clientX: number; clientY: number }) => void;
  dropActive: boolean;
  onNewFolder: () => void;
  onRename: () => void;
  onDelete: () => void;
  onRefresh: () => void;
}

export function S3Pane(p: Props) {
  const { location, selection } = p;
  const up = () => {
    if (!location) return;
    if (location.prefix === "") p.onLocationChange(null);
    else p.onLocationChange({ ...location, prefix: parentPrefix(location.prefix) });
  };
  return (
    <section
      className={`pane${p.focused ? " focus" : ""}${p.dropActive ? " drop" : ""}`}
      data-pane="s3"
      data-testid="pane-s3"
      onMouseDown={p.onFocus}
    >
      <div className="pane-head">
        <span>🪣</span>
        <button className="link crumb-link" onClick={() => p.onLocationChange(null)}>
          버킷 목록
        </button>
        {location && (
          <>
            <span>›</span>
            <button className="link crumb-link" onClick={() => p.onLocationChange({ ...location, prefix: "" })}>
              <b>{location.bucket}</b>
            </button>
            {prefixSegments(location.prefix).map((s) => (
              <span key={s.prefix}>
                ›{" "}
                <button className="link crumb-link" onClick={() => p.onLocationChange({ ...location, prefix: s.prefix })}>
                  {s.label}
                </button>
              </span>
            ))}
          </>
        )}
        <span className="sp">
          <button className="icon" aria-label="상위 폴더" title="상위 폴더" disabled={!location} onClick={up}>
            ↑
          </button>
          <button className="btn small" disabled={!location} onClick={p.onNewFolder}>
            + 폴더
          </button>
          <button className="btn small" disabled={!location || selection.selected.length !== 1} onClick={p.onRename}>
            이름 변경
          </button>
          <button className="btn small danger" disabled={!location || selection.selected.length === 0} onClick={p.onDelete}>
            삭제
          </button>
        </span>
      </div>
      {location ? <ObjectList {...p} location={location} up={up} /> : <BucketList {...p} />}
    </section>
  );
}

function BucketList(p: Props) {
  const q = useResources(p.profile, p.region, p.s3Service, "buckets");
  const items = q.data?.items ?? [];
  const open = (id: string) => {
    const b = items.find((r) => r.id === id);
    if (b) p.onLocationChange({ bucket: b.id, region: b.values.region || p.region, prefix: "" });
  };
  if (q.isError && !q.data) return <ErrorState error={q.error} profile={p.profile} onRetry={p.onRefresh} />;
  if (q.isPending) return <div className="empty">불러오는 중…</div>;
  const columns = p.s3Service.types.find((t) => t.id === "buckets")?.columns ?? S3_COLUMNS;
  return (
    <FileTable
      columns={columns}
      rows={items}
      filter={p.filter}
      selection={{ selected: [], anchor: null }}
      onSelectionChange={() => {}}
      onOpen={open}
      emptyText="버킷이 없어요"
    />
  );
}

function ObjectList(p: Props & { location: S3Location; up: () => void }) {
  const { location } = p;
  const q = useS3Objects(p.profile, location.region, location.bucket, location.prefix);
  const entries = q.data?.pages.flatMap((page) => page.entries) ?? [];
  const open = (key: string) => {
    const e = entries.find((x) => x.key === key);
    if (e?.isFolder) p.onLocationChange({ ...location, prefix: e.key });
  };
  if (q.isError && !q.data) return <ErrorState error={q.error} profile={p.profile} onRetry={p.onRefresh} />;
  if (q.isPending) return <div className="empty">불러오는 중…</div>;
  return (
    <>
      {q.isError && <ErrorState error={q.error} profile={p.profile} onRetry={p.onRefresh} compact />}
      <FileTable
        columns={S3_COLUMNS}
        rows={entries.map(s3EntryToRow)}
        filter={p.filter}
        selection={p.selection}
        onSelectionChange={p.onSelectionChange}
        onOpen={open}
        onBack={p.up}
        onDragStart={p.onDragStart}
        emptyText="빈 폴더예요"
      />
      {q.hasNextPage && (
        <button className="btn more" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          더 보기
        </button>
      )}
    </>
  );
}
