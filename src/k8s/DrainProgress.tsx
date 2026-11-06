import { useEffect, useRef } from "react";
import { errorMessage } from "../api/errors";
import { useModal } from "../iam/useModal";
import type { DrainRun } from "./drain";
import * as t from "./text";

interface Props {
  run: DrainRun;
  onStop: () => void;
  onClose: () => void;
}

/** drain 진행 창: Pod마다 상태, 합계, 중단 버튼, 끝나면 요약. 끝나기 전에는 닫을 수 없다(Esc도 같다). */
export function DrainProgress({ run, onStop, onClose }: Props) {
  const { finished } = run;
  const { sheetRef, trapTab } = useModal(() => {
    if (finished) onClose();
  });
  const stopRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => stopRef.current?.focus(), []);
  useEffect(() => {
    if (finished) closeRef.current?.focus();
  }, [finished]);
  const phase = finished
    ? t.DRAIN_OUTCOME[finished.outcome]
    : run.stopping
      ? t.DRAIN_PHASE_STOPPING
      : run.cordoned
        ? t.DRAIN_PHASE_EVICT
        : t.DRAIN_PHASE_CORDON;
  return (
    <div className="modal">
      <div className="sheet wide cp" role="dialog" aria-modal="true" aria-label={t.DRAIN_TITLE(run.node)} ref={sheetRef} onKeyDown={trapTab}>
        <div className="cp-body">
          <h3>{t.DRAIN_TITLE(run.node)}</h3>
          <p role="status">{phase}</p>
          <p>{t.DRAIN_COUNTS(run.counts)}</p>
          {finished?.error && <p className="err">{t.DRAIN_ERROR}: {errorMessage(finished.error)}</p>}
          {finished && run.cordoned && <p>{t.DRAIN_UNDO_HINT}</p>}
          <table className="k8s-table" aria-label={t.DRAIN_PLAN_EVICT}>
            <thead>
              <tr>
                <th>{t.DRAIN_POD}</th>
                <th>{t.DRAIN_STATE}</th>
                <th>{t.DRAIN_NOTE}</th>
              </tr>
            </thead>
            <tbody>
              {run.rows.map((row) => (
                <tr key={row.pod.uid || `${row.pod.namespace}/${row.pod.name}`}>
                  <td className="mono">{row.pod.namespace}/{row.pod.name}</td>
                  <td data-state={row.state}>{t.DRAIN_POD_STATE[row.state]}</td>
                  <td>
                    {row.error && <span className="err">{row.error}</span>}
                    {row.state === "blocked" && row.pod.blockedBy !== null && <span>{t.DRAIN_FLAG_BLOCKED(row.pod.blockedBy)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="foot">
          {finished ? (
            <button ref={closeRef} className="btn plain tone-ghost" onClick={onClose}>
              {t.DRAIN_CLOSE}
            </button>
          ) : (
            <button ref={stopRef} className="btn plain tone-caution" disabled={run.id === null || run.stopping} onClick={onStop}>
              {t.DRAIN_STOP}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
