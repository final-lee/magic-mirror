import { useState } from "react";
import { ErrorState } from "../../components/ErrorState";
import { FormSheet } from "../change/FormSheet";
import type { ArgoChange } from "../change/types";
import { DiffBody } from "../detail/DiffBody";
import { useManifestsDiff } from "../detail/queries";
import { RevisionCell } from "../detail/RevisionCell";
import { LOADING } from "../text";
import type { ArgoHistoryEntry } from "../types";
import {
  ROLLBACK_AUTO_CHOICE, ROLLBACK_AUTO_NOTE, ROLLBACK_AUTO_ON, ROLLBACK_DIFF, ROLLBACK_DRY, ROLLBACK_NO_DIFF, ROLLBACK_PREVIEW, ROLLBACK_PRUNE, ROLLBACK_SAME, ROLLBACK_TARGET, rollbackTitle,
} from "./text";

export type Rollback = Extract<ArgoChange, { kind: "rollback" }>;

interface Props {
  url: string;
  namespace: string;
  name: string;
  /** 롤백할 이력 */
  entry: ArgoHistoryEntry;
  /** 지금 배포된 이력(가장 최근) */
  current: ArgoHistoryEntry;
  /** 앱의 자동 동기화가 켜져 있다: 서버가 롤백을 거절하므로 끄고 롤백하는 선택이 필요하다 */
  autoSync: boolean;
  now?: number;
  onCancel: () => void;
  onPreview: (change: Rollback) => void;
}

/** 이력 한 건으로 롤백: 대상 리비전의 메타데이터, 지금 배포에서 대상까지의 manifest 변경, 옵션(자동 동기화를 끄고 롤백 포함). */
export function RollbackForm({ url, namespace, name, entry, current, autoSync, now, onCancel, onPreview }: Props) {
  const [prune, setPrune] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [disableAutoSync, setDisableAutoSync] = useState(false);
  const same = entry.id === current.id;
  const compare = useManifestsDiff(url, namespace, name, same ? null : current.revisions.map((r) => r.revision), same ? null : entry.revisions.map((r) => r.revision));
  const blocked = autoSync && !disableAutoSync;
  const at = now ?? Date.now();
  return (
    <FormSheet
      label={rollbackTitle(entry.id)}
      wide
      onCancel={onCancel}
      submit={{ label: ROLLBACK_PREVIEW, disabled: blocked, title: blocked ? ROLLBACK_AUTO_ON : undefined, onClick: () => onPreview({ kind: "rollback", id: entry.id, prune, dryRun, disableAutoSync: autoSync && disableAutoSync }) }}
    >
      <h4>{ROLLBACK_TARGET}</h4>
      {entry.revisions.map((r) => (
        <RevisionCell key={r.sourceIndex} info={r} at={at} />
      ))}
      <h4>{ROLLBACK_DIFF}</h4>
      {same ? (
        <p className="dim">{ROLLBACK_SAME}</p>
      ) : compare.isError ? (
        <ErrorState error={compare.error} profile="" compact onRetry={() => void compare.refetch()} />
      ) : compare.data ? (
        <DiffBody diff={compare.data} same={ROLLBACK_NO_DIFF} />
      ) : (
        <div className="empty">{LOADING}</div>
      )}
      <label className="k8s-check argo-opt">
        <input type="checkbox" checked={prune} onChange={(e) => setPrune(e.target.checked)} />
        {ROLLBACK_PRUNE}
      </label>
      <label className="k8s-check argo-opt">
        <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
        {ROLLBACK_DRY}
      </label>
      {autoSync && (
        <div>
          <p className="err" role="alert">
            {ROLLBACK_AUTO_ON}
          </p>
          <label className="k8s-check argo-opt">
            <input type="checkbox" checked={disableAutoSync} onChange={(e) => setDisableAutoSync(e.target.checked)} />
            {ROLLBACK_AUTO_CHOICE}
          </label>
          {disableAutoSync && <p className="dim">{ROLLBACK_AUTO_NOTE}</p>}
        </div>
      )}
    </FormSheet>
  );
}
