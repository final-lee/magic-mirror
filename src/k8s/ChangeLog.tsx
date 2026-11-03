import { useQuery } from "@tanstack/react-query";
import { errorMessage } from "../api/errors";
import { formatDateTime } from "../iam/format";
import { usePrepare } from "../lib/changeLog";
import { k8sApi } from "./api";
import * as t from "./text";
import type { K8sChange, K8sTarget } from "./types";

interface Props {
  target: K8sTarget;
  onStart: (change: K8sChange, undoOf: string) => void;
}

/** 이 클러스터의 변경 기록과 되돌릴 수 있는 변경을 보여 준다. */
export function ChangeLog({ target, onStart }: Props) {
  const q = useQuery({ queryKey: ["k8s-change-log"], queryFn: k8sApi.changeLog });
  const { busy, errors, prepare } = usePrepare();
  const entries = (q.data ?? [])
    .filter((e) => e.target.profile === target.profile && e.target.region === target.region && e.target.cluster === target.cluster)
    .slice()
    .sort((a, b) => b.at.localeCompare(a.at));

  return (
    <section>
      <h2>{t.CHANGE_LOG}</h2>
      {q.isError && <p className="err">{errorMessage(q.error)}</p>}
      {q.isSuccess && entries.length === 0 && <p>{t.CHANGE_NO_LOG}</p>}
      <table className="k8s-table">
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td>{formatDateTime(entry.at)}</td>
              <td>{entry.summary}</td>
              <td>{entry.ok ? t.CHANGE_SUCCESS : `${t.CHANGE_FAILED}: ${entry.error ?? ""}`}{entry.closedAt ? ` · ${t.SHELL_CLOSED_AT(formatDateTime(entry.closedAt))}` : ""}</td>
              <td>
                {entry.ok && entry.inverse && !entry.undone && (
                  <button className="btn small" disabled={busy !== null} onClick={() => void prepare(entry.id, async () => {
                    const undo = await k8sApi.undo(entry.id);
                    onStart(undo.change, entry.id);
                  })}>
                    {t.CHANGE_UNDO}
                  </button>
                )}
                {Boolean(errors[entry.id]) && <span className="err">{errorMessage(errors[entry.id])}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
