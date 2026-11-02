import { useQuery } from "@tanstack/react-query";
import { errorMessage } from "../api/errors";
import { formatDateTime } from "../iam/format";
import { usePrepare } from "../lib/changeLog";
import { k8sApi } from "./api";
import * as t from "./text";
import type { K8sChange, K8sTarget } from "./types";

export function ChangeLog({ target, onStart, changeMode }: { target: K8sTarget; onStart: (change: K8sChange, undoOf: string) => void; changeMode: boolean }) {
  const q = useQuery({ queryKey: ["k8s-change-log"], queryFn: k8sApi.changeLog });
  const { busy, errors, prepare } = usePrepare();
  const entries = (q.data ?? []).filter((e) => e.target.profile === target.profile && e.target.region === target.region && e.target.cluster === target.cluster).slice().sort ( (a, b) => b.at.localeCompare(a.at));
  return <section><h2>{t.CHANGE_LOG}</h2>{q.isError && <p className="err">{errorMessage(q.error)}</p>}{q.isSuccess && entries.length === 0 && <p>{t.CHANGE_NO_LOG}</p>}
    <table className="k8s-table"><tbody>{entries.map((e) => <tr key={e.id}><td>{formatDateTime(e.at)}</td><td>{e.summary}</td><td>{e.ok ? t.CHANGE_SUCCESS : `${t.CHANGE_FAILED}: ${e.error ?? ""}`}</td><td>{changeMode && e.ok && e.inverse && !e.undone && <button className="btn small" disabled={busy !== null} onClick={() => void prepare(e.id, async () => { const undo = await k8sApi.undo(e.id); onStart(undo.change, e.id); })}>{t.CHANGE_UNDO}</button>}{Boolean(errors[e.id]) && <span className="err">{errorMessage(errors[e.id])}</span>}</td></tr>)}</tbody></table>
  </section>;
}
