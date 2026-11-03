import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { K8sError } from "./K8sError";
import { KindTree } from "./KindTree";
import { DETAIL_PCT, LaneResizer, type Lane } from "./lanes";
import { CATEGORIES, PODS, customCategories, sameKind, servedCategories } from "./kinds";
import { ObjectDetail } from "./ObjectDetail";
import { ObjectList } from "./ObjectList";
import { useK8sMetrics } from "./queries";
import { kindKey } from "./targets";
import { CAT_CUSTOM, ROLLOUT_PROGRESS, ROLLOUT_WAITING } from "./text";
import type { K8sChange, K8sKind, K8sKindRef, K8sTarget, ObjectRef } from "./types";
import { buildUsageIndex, usageKindOf } from "./usage";
import { useK8sWatch } from "./useK8sWatch";

export interface WorkloadsFocus {
  ref: ObjectRef;
  /** 같은 객체를 다시 열 때도 바뀌는 값 */
  nonce: number;
}

interface Props {
  target: K8sTarget;
  context: string;
  sessionEpoch: number;
  ssoProfile: string;
  live: boolean;
  /** 탭이 보이는 동안에만 사용량을 15초마다 읽는다. 없으면 보이는 것으로 본다 */
  visible?: boolean;
  /** null이면 모든 네임스페이스 */
  namespace: string | null;
  kinds: K8sKind[];
  discoveryAvailable?: boolean;
  focus: WorkloadsFocus | null;
  onOpenIam?: (arn: string) => void;
  onChange?: (change: K8sChange) => void;
  appliedChange?: K8sChange | null;
  /** 목록 위에 붙이는 알림(종류 발견 실패 등). 종류 트리와 기본 종류 탐색은 그대로 쓴다. */
  banner?: ReactNode;
  /** 북마크 화면: 이 종류만 보이고 종류 트리는 숨긴다 */
  fixedKind?: K8sKindRef;
  bookmarked: Set<string>;
  onToggleBookmark: (k: K8sKindRef) => void;
  /** 레인 너비(useLaneWidths) */
  lanes: {
    width: (lane: Lane) => number | undefined;
    resize: (lane: Lane, width: number) => void;
    commit: (lane: Lane, width: number) => void;
  };
}

/** 종류 트리 + 감시 목록 + 상세 스택 */
export function WorkloadsView({ target, context, sessionEpoch, ssoProfile, live, visible = true, namespace, kinds, focus, onOpenIam, banner,
  fixedKind, bookmarked, onToggleBookmark, lanes, onChange, appliedChange, discoveryAvailable = false }: Props) {
  const [picked, setKind] = useState<K8sKindRef>(PODS);
  const kind = fixedKind ?? picked;
  const [stack, setStack] = useState<ObjectRef[]>([]);
  const started = useRef<{ change: K8sChange; version: string | null } | null>(null);
  const [rollout, setRollout] = useState<{ change: K8sChange; version: string | null } | null>(null);

  useEffect(() => {
    if (!focus) return;
    setKind(focus.ref.kind);
    setStack([focus.ref]);
    // nonce가 바뀔 때만 연다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  const watch = useK8sWatch(target, context, sessionEpoch, ssoProfile, kind, kind.namespaced ? namespace : null, live);
  const custom = useMemo(() => customCategories(kinds), [kinds]);
  const categories = useMemo(() => {
    const builtin = discoveryAvailable ? servedCategories(kinds) : CATEGORIES;
    return custom.length === 0 ? builtin : [...builtin, { id: "custom", label: CAT_CUSTOM, kinds: [] }, ...custom];
  }, [custom, discoveryAvailable, kinds]);
  const top = stack.length > 0 ? stack[stack.length - 1] : null;
  const topRow = top && sameKind(top.kind, kind) ? watch.rows.find((r) => r.name === top.name && r.namespace === top.namespace) : undefined;
  // 사용량 열이 있는 종류를 보거나 그런 객체의 상세를 열었을 때만 읽는다
  const wantsUsage = usageKindOf(kind) !== null || (top !== null && usageKindOf(top.kind) !== null);
  const metrics = useK8sMetrics(target, context, kind.namespaced ? namespace : null, ssoProfile, live && visible && wantsUsage);
  const usage = useMemo(() => (metrics.data ? buildUsageIndex(metrics.data) : null), [metrics.data]);

  useEffect(() => {
    if (!appliedChange || !["scale", "restart", "rolloutUndo"].includes(appliedChange.type)) return;
    if (started.current?.change === appliedChange) setRollout(started.current);
  }, [appliedChange]);

  const rolloutRow = rollout && sameKind(rollout.change.kind, kind)
    ? watch.rows.find((row) => row.name === rollout.change.name && row.namespace === rollout.change.namespace)
    : undefined;
  const readyParts = rolloutRow?.values.ready?.split("/") ?? [];
  const ready = Number(readyParts[0]);
  const desired = Number(readyParts[1] ?? rolloutRow?.values.desired);
  const updated = rolloutRow?.values.upToDate === undefined ? ready : Number(rolloutRow.values.upToDate);
  const known = !!rolloutRow?.values.ready && Number.isFinite(ready) && Number.isFinite(desired) && Number.isFinite(updated);
  const complete = known && ready >= desired && updated >= desired;
  useEffect(() => {
    if (rollout && rolloutRow && rolloutRow.resourceVersion !== rollout.version && complete) setRollout(null);
  }, [rollout, rolloutRow, complete]);
  const progress = rollout && top && rolloutRow && rolloutRow.name === top.name && rolloutRow.namespace === top.namespace && known
    ? rolloutRow.resourceVersion === rollout.version ? ROLLOUT_WAITING : ROLLOUT_PROGRESS(Math.min(ready, updated), desired)
    : undefined;
  const startChange = (change: K8sChange) => {
    started.current = { change, version: topRow?.resourceVersion ?? null };
    onChange?.(change);
  };

  const pickKind = (k: K8sKindRef) => {
    setKind(k);
    setStack([]);
  };
  // 4열 상세는 3열 목록 위에 떠서 목록 너비의 이만큼을 덮는다
  const detailPct = lanes.width("detailPct") ?? DETAIL_PCT;
  return (
    <div className="k8s-workloads">
      {!fixedKind && (
        <>
          <KindTree categories={categories} selected={kind} onSelect={pickKind} bookmarked={bookmarked} onToggleBookmark={onToggleBookmark} width={lanes.width("tree")} />
          <LaneResizer lane="tree" onResize={lanes.resize} onCommit={lanes.commit} />
        </>
      )}
      <div className="k8s-list-pane">
        {banner}
        {watch.error && <K8sError error={watch.error} target={target} ssoProfile={ssoProfile} compact />}
        <ObjectList
          kind={kind}
          rows={watch.rows}
          status={watch.status}
          showNamespace={namespace === null}
          usage={usage}
          selectedUid={topRow?.uid ?? null}
          onSelect={(r) => setStack(r.uid === topRow?.uid ? [] : [{ kind, namespace: r.namespace, name: r.name }])}
          onOpen={(r) => setStack([{ kind, namespace: r.namespace, name: r.name }])}
        />
        {top && <LaneResizer lane="detailPct" onResize={lanes.resize} onCommit={lanes.commit} style={{ right: `${detailPct}%` }} />}
        {top && (
          <ObjectDetail
            key={JSON.stringify([kindKey(top.kind), top.namespace, top.name])}
            target={target}
            context={context}
            ssoProfile={ssoProfile}
            live={live}
            objectRef={top}
            resourceVersion={topRow?.resourceVersion ?? null}
            kinds={kinds}
            onOpen={(ref) => setStack((s) => [...s, ref])}
            usageIndex={usage}
            onBack={stack.length > 1 ? () => setStack((s) => s.slice(0, -1)) : null}
            onClose={() => setStack([])}
            onOpenIam={onOpenIam}
            onChange={onChange ? startChange : undefined}
            rolloutProgress={progress}
            appliedChange={appliedChange}
            shellNamespace={namespace ?? undefined}
            widthPct={detailPct}
          />
        )}
      </div>
    </div>
  );
}
