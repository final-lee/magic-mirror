import { useEffect, useMemo, useState } from "react";
import { K8sError } from "./K8sError";
import { KindTree } from "./KindTree";
import { CATEGORIES, PODS, customCategories, sameKind } from "./kinds";
import { ObjectDetail } from "./ObjectDetail";
import { ObjectList } from "./ObjectList";
import { kindKey } from "./targets";
import { CAT_CUSTOM } from "./text";
import type { K8sKind, K8sKindRef, K8sTarget, ObjectRef } from "./types";
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
  /** null이면 모든 네임스페이스 */
  namespace: string | null;
  kinds: K8sKind[];
  focus: WorkloadsFocus | null;
  onOpenIam?: (arn: string) => void;
}

/** 종류 트리 + 감시 목록 + 상세 스택 */
export function WorkloadsView({ target, context, sessionEpoch, ssoProfile, live, namespace, kinds, focus, onOpenIam }: Props) {
  const [kind, setKind] = useState<K8sKindRef>(PODS);
  const [stack, setStack] = useState<ObjectRef[]>([]);

  useEffect(() => {
    if (!focus) return;
    setKind(focus.ref.kind);
    setStack([focus.ref]);
    // nonce가 바뀔 때만 연다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  const watch = useK8sWatch(target, context, sessionEpoch, ssoProfile, kind, kind.namespaced ? namespace : null, live);
  const custom = useMemo(() => customCategories(kinds), [kinds]);
  const categories = useMemo(() => (custom.length === 0 ? CATEGORIES : [...CATEGORIES, { id: "custom", label: CAT_CUSTOM, kinds: [] }, ...custom]), [custom]);
  const top = stack.length > 0 ? stack[stack.length - 1] : null;
  const topRow = top && sameKind(top.kind, kind) ? watch.rows.find((r) => r.name === top.name && r.namespace === top.namespace) : undefined;

  const pickKind = (k: K8sKindRef) => {
    setKind(k);
    setStack([]);
  };
  return (
    <div className="k8s-workloads">
      <KindTree categories={categories} selected={kind} onSelect={pickKind} />
      <div className="k8s-list-pane">
        {watch.error && <K8sError error={watch.error} target={target} ssoProfile={ssoProfile} compact />}
        <ObjectList
          kind={kind}
          rows={watch.rows}
          status={watch.status}
          showNamespace={namespace === null}
          selectedUid={topRow?.uid ?? null}
          onSelect={(r) => setStack([{ kind, namespace: r.namespace, name: r.name }])}
        />
      </div>
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
          onBack={stack.length > 1 ? () => setStack((s) => s.slice(0, -1)) : null}
          onClose={() => setStack([])}
          onOpenIam={onOpenIam}
        />
      )}
    </div>
  );
}
