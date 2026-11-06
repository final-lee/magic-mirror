import { useCallback, useEffect, useRef, useState } from "react";
import { GLOBAL, useResources } from "../api/queries";
import type { ResourceType, ServiceInfo } from "../api/types";
import { useCopyShortcut } from "../hooks/useCopyShortcut";
import { resourceDetail } from "../lib/detail";
import type { S3Location } from "../lib/s3";
import { NOT_KV, kvTargetOf } from "../kv/targets";
import type { KvTarget } from "../kv/types";
import { NOT_POSTGRES, pgTargetOf } from "../pg/targets";
import type { K8sTarget } from "../k8s/types";
import { ClusterDetailSummary } from "../k8s/ClusterDetailSummary";
import { OPEN_EKS_TAB } from "../k8s/text";
import type { PgTarget } from "../pg/types";
import { Breadcrumb } from "./Breadcrumb";
import { DetailPanel } from "./DetailPanel";
import { ResourceMetrics } from "./ResourceMetrics";
import { ListFind, useListFind } from "./ListFind";
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
  onOpenBucket: (loc: S3Location) => void;
  onOpenVpc?: (vpc: { vpcId: string; name: string; region: string }) => void;
  /** IAM 사용자·역할·정책을 열 때 IAM 작업 공간으로 보낸다. arn이 없으면 대상 없이 탭만 연다. */
  onOpenIam?: (arn: string | null) => void;
  /** PostgreSQL 클러스터·인스턴스를 열 때 사용자 관리 탭으로 보낸다. 다른 엔진이면 부르지 않고 안내만 띄운다. */
  onOpenPg?: (target: PgTarget) => void;
  /** EKS 클러스터를 열 때 Kubernetes 탭으로 보낸다. */
  onOpenK8s?: (target: K8sTarget) => void;
  /** ElastiCache의 Valkey·Redis OSS 캐시를 열 때 키 탐색 탭으로 보낸다. Memcached면 부르지 않고 안내만 띄운다. */
  onOpenKv?: (target: KvTarget) => void;
  onRefresh: () => void;
  active: boolean;
  /** ⌘K에서 고른 리소스. nonce가 바뀔 때마다 그 행을 고르고 보이게 한다 */
  focus?: ResourceFocus | null;
}

export interface ResourceFocus {
  id: string;
  nonce: number;
}

const IAM_OPENABLE = ["users", "roles", "policies"];
/** 안내가 떠 있는 시간 */
const NOTICE_MS = 5000;
/** ⌘K에서 고른 리소스가 다시 읽은 목록에 없을 때 */
export const FOCUS_GONE = "찾던 리소스가 지금 목록에 없어요. 지워졌을 수 있어요";

export function ResourceArea({ service, type, profile, region, account, onOpenBucket, onOpenVpc, onOpenIam, onOpenPg, onOpenK8s, onOpenKv, onRefresh, active, focus = null }: Props) {
  const q = useResources(profile, region, service, type.id);
  // ⌘F: 이 목록 안에서만 찾는다(평소에는 찾기 줄이 없다)
  const listBox = useRef<HTMLElement>(null);
  const find = useListFind(listBox, { enabled: active });
  const [selectedId, setSelectedId] = useState<string | null>(focus?.id ?? null);
  // 보이게 할 행. 표가 보이게 하면 비우고, 다 읽었는데 없으면 안내하고 비운다.
  const [reveal, setReveal] = useState<string | null>(focus?.id ?? null);
  const focusNonce = useRef(focus?.nonce);
  useEffect(() => {
    if (!focus || focus.nonce === focusNonce.current) return;
    focusNonce.current = focus.nonce;
    setSelectedId(focus.id);
    setReveal(focus.id);
  }, [focus]);
  const revealed = useCallback(() => setReveal(null), []);
  const [showRaw, setShowRaw] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);
  const items = q.data?.items ?? [];
  const selected = items.find((r) => r.id === selectedId) ?? null;
  const eksCluster = service.id === "eks" && type.id === "clusters";
  useCopyShortcut(active ? (selected?.id ?? null) : null);

  // 안내는 띄운 때부터 NOTICE_MS 뒤에 사라진다. 그 사이에 다시 띄우면 처음부터 센다.
  const showNotice = (text: string) => {
    clearTimeout(noticeTimer.current);
    setNotice(text);
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  };

  useEffect(() => {
    if (!reveal || !q.data || q.isFetching) return;
    if (q.data.items.some((r) => r.id === reveal)) return;
    setReveal(null);
    showNotice(FOCUS_GONE);
  }, [reveal, q.data, q.isFetching]);

  const open = (id: string) => {
    const item = items.find((r) => r.id === id);
    if (!item) return;
    if (service.id === "s3" && type.id === "buckets") {
      onOpenBucket({ bucket: item.id, region: item.values.region || region, prefix: "" });
    } else if (service.id === "vpc" && type.id === "vpcs") {
      onOpenVpc?.({ vpcId: item.id, name: item.name, region });
    } else if (service.id === "iam" && IAM_OPENABLE.includes(type.id)) {
      onOpenIam?.(item.arn);
    } else if (service.id === "eks" && type.id === "clusters") {
      onOpenK8s?.({ profile, region, cluster: item.id });
    } else if (service.id === "rds" && (type.id === "db-clusters" || type.id === "db-instances")) {
      const target = pgTargetOf(item, type.id);
      if (target) onOpenPg?.({ profile, region, ...target });
      else showNotice(NOT_POSTGRES);
    } else if (service.id === "elasticache" && (type.id === "replication-groups" || type.id === "cache-clusters" || type.id === "serverless-caches")) {
      const target = kvTargetOf(item, type.id);
      if (target) onOpenKv?.({ profile, region, ...target });
      else showNotice(NOT_KV);
    }
  };

  return (
    <>
      <section className="center detail-host" ref={listBox}>
        <Breadcrumb service={service} segments={[{ label: type.name }]} count={q.data ? items.length : undefined} />
        {q.data?.truncated && <div className="notice">1,000개까지만 표시해요</div>}
        {notice && (
          <div className="notice" role="status">
            {notice}
          </div>
        )}
        {q.isError && q.data && <ErrorState compact error={q.error} profile={profile} onRetry={onRefresh} />}
        {q.isError && !q.data ? (
          <ErrorState error={q.error} profile={profile} onRetry={onRefresh} />
        ) : q.isPending ? (
          <div className="empty">불러오는 중…</div>
        ) : (
          <>
            <ListFind find={find} />
            <ResourceTable
              columns={type.columns}
              items={items}
              filter={find.query}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onClear={() => setSelectedId(null)}
              onOpen={open}
              revealId={reveal}
              onRevealed={revealed}
            />
          </>
        )}
        <StatusBar profile={profile} account={account} region={service.global ? GLOBAL : region} updatedAt={q.dataUpdatedAt} />
        <DetailPanel
          detail={selected ? resourceDetail(selected, type, service) : null}
          onShowRaw={() => setShowRaw(true)}
          onClose={() => setSelectedId(null)}
          actions={eksCluster && selected && (
            <button className="btn small tone-nav" onClick={() => onOpenK8s?.({ profile, region, cluster: selected.id })}>
              {OPEN_EKS_TAB}
            </button>
          )}
        >
          {eksCluster && selected && (
            <ClusterDetailSummary key={`${profile}|${region}|${selected.id}`} target={{ profile, region, cluster: selected.id }} />
          )}
          {selected && service.metricTypes?.includes(type.id) && (
            <ResourceMetrics key={`${profile}|${region}|${selected.id}`} profile={profile} region={region} service={service} typeId={type.id} row={selected} />
          )}
        </DetailPanel>
      </section>
      {showRaw && selected && <RawModal title={selected.name} text={selected.raw} onClose={() => setShowRaw(false)} />}
    </>
  );
}
