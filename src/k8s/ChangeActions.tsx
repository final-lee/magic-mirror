import { useEffect, useState } from "react";
import { errorMessage } from "../api/errors";
import { k8sApi } from "./api";
import { can } from "./can";
import * as t from "./text";
import type { K8sChange, K8sObjectView, K8sRevision, K8sRules, K8sTarget, ObjectRef } from "./types";

export function ChangeActions({ target, ssoProfile, objectRef, view, rules, onStart }: { target: K8sTarget; ssoProfile: string; objectRef: ObjectRef; view: K8sObjectView; rules: K8sRules | undefined; onStart: (change: K8sChange) => void }) {
  const { kind, name } = objectRef;
  const workload = kind.group === "apps" && ["Deployment", "StatefulSet", "DaemonSet"].includes(kind.kind);
  const scalable = workload && kind.kind !== "DaemonSet";
  const job = kind.group === "batch" && ["Job", "CronJob"].includes(kind.kind);
  const cron = job && kind.kind === "CronJob";
  const [replicas, setReplicas] = useState(view.row.values.desired ?? "1");
  const [jobName, setJobName] = useState(`${name}-manual-${Math.floor(Date.now() / 1000)}`);
  const [revisions, setRevisions] = useState<K8sRevision[] | null>(null);
  const [revision, setRevision] = useState("");
  const [revisionError, setRevisionError] = useState("");
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    if (!picking) return;
    let alive = true;
    k8sApi.revisions(target, objectRef, ssoProfile).then((r) => { if (alive) { setRevisions(r); setRevision(r[0]?.revision ?? ""); } }, (e) => { if (alive) setRevisionError(errorMessage(e)); });
    return () => { alive = false; };
  }, [picking, target, objectRef, ssoProfile]);
  const denied = (verb: string, group = kind.group, resource = kind.plural, named = true) => rules && can(rules, { verb, group, resource, ...(named ? { name } : {}) }) === "no" ? t.CHANGE_DENIED(verb, resource) : undefined;
  const button = (label: string, reason: string | undefined, action: () => void, invalid = false) => <button className="btn small" disabled={!!reason || invalid} title={reason} aria-description={reason} onClick={action}>{label}</button>;
  const patch = denied("patch");
  const validReplicas = /^\d+$/.test(replicas) && Number.isSafeInteger(Number(replicas)) && Number(replicas) <= 2147483647;
  const suspended = view.row.values.suspend === "true";
  return <div className="k8s-actions">
    {scalable && <><label>{t.CHANGE_REPLICAS} <input type="number" min="0" step="1" value={replicas} onChange={(e) => setReplicas(e.target.value)} /></label>{button(t.CHANGE_SCALE, patch, () => onStart({ ...objectRef, type: "scale", replicas: Number(replicas) }), !validReplicas)}</>}
    {workload && <>{button(t.CHANGE_RESTART, patch, () => onStart({ ...objectRef, type: "restart" }))}{button(t.CHANGE_ROLLOUT_UNDO, patch, () => setPicking(true))}{picking && <><label>{t.CHANGE_REVISION} <select value={revision} onChange={(e) => setRevision(e.target.value)}><option value="">—</option>{revisions?.map((r) => <option key={r.revision} value={r.revision}>{r.revision} — {r.name}</option>)}</select></label>{button(t.CHANGE_PREVIEW, patch, () => onStart({ ...objectRef, type: "rolloutUndo", revision }), !revision)}{revisionError && <span className="err">{revisionError}</span>}</>}</>}
    {job && <><label>{t.CHANGE_JOB_NAME} <input value={jobName} onChange={(e) => setJobName(e.target.value)} /></label>{button(cron ? t.CHANGE_RUN_NOW : t.CHANGE_RERUN, denied("create", "batch", "jobs", false), () => onStart({ ...objectRef, type: "rerun", jobName }), !jobName.trim())}</>}
    {cron && button(suspended ? t.CHANGE_RESUME : t.CHANGE_SUSPEND, patch, () => onStart({ ...objectRef, type: "suspend", suspend: !suspended }))}
    {button(t.CHANGE_DELETE, denied("delete"), () => onStart({ ...objectRef, type: "delete" }))}
  </div>;
}
