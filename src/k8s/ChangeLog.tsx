import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { errorMessage } from "../api/errors";
import { ListFind, useListFind } from "../components/ListFind";
import { formatDateTime } from "../iam/format";
import { vimTableKeys } from "../iam/ListTable";
import { usePrepare } from "../lib/changeLog";
import { fuzzyKeep } from "../lib/fuzzy";
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
  // ⌘F: 이 변경 기록 안에서만 찾는다. 평소에는 찾기 줄이 없다
  const box = useRef<HTMLElement>(null);
  const find = useListFind(box);
  const listed = fuzzyKeep(entries, find.query, (e) => [e.summary, e.error, formatDateTime(e.at), e.ok ? t.CHANGE_SUCCESS : t.CHANGE_FAILED]);

  return (
    <section ref={box}>
      <h2>{t.CHANGE_LOG}</h2>
      <ListFind find={find} count={listed.length} />
      {q.isError && <p className="err">{errorMessage(q.error)}</p>}
      {q.isSuccess && entries.length === 0 && <p>{t.CHANGE_NO_LOG}</p>}
      {entries.length > 0 && listed.length === 0 && <p>{t.LIST_NO_MATCH}</p>}
      <table className="k8s-table k8s-vim-rows" aria-label={t.CHANGE_LOG} tabIndex={0} onKeyDown={vimTableKeys}>
        <tbody>
          {listed.map((entry) => (
            <tr key={entry.id} tabIndex={-1}>
              <td>{formatDateTime(entry.at)}</td>
              <td>{entry.summary}</td>
              <td>{entry.ok ? t.CHANGE_SUCCESS : `${t.CHANGE_FAILED}: ${entry.error ?? ""}`}{entry.closedAt ? ` · ${t.SHELL_CLOSED_AT(formatDateTime(entry.closedAt))}` : ""}</td>
              <td>
                {entry.ok && entry.inverse && !entry.undone && (
                  <button className="btn small tone-caution" disabled={busy !== null} onClick={() => void prepare(entry.id, async () => {
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
