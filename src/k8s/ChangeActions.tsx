import { useEffect, useState } from "react";
import { errorMessage } from "../api/errors";
import { k8sApi } from "./api";
import { can } from "./can";
import * as t from "./text";
import type { K8sChange, K8sObjectView, K8sRevision, K8sRules, K8sTarget, ObjectRef } from "./types";

interface Props {
  target: K8sTarget;
  ssoProfile: string;
  objectRef: ObjectRef;
  view: K8sObjectView;
  rules: K8sRules | undefined;
  onStart: (change: K8sChange) => void;
}

/** 객체 종류와 권한에 맞는 워크로드 변경을 고른다. */
export function ChangeActions({ target, ssoProfile, objectRef, view, rules, onStart }: Props) {
  const { kind, name } = objectRef;
  const workload = kind.group === "apps" && ["Deployment", "StatefulSet", "DaemonSet"].includes(kind.kind);
  const scalable = workload && kind.kind !== "DaemonSet";
  const job = kind.group === "batch" && ["Job", "CronJob"].includes(kind.kind);
  const cron = job && kind.kind === "CronJob";
  const [replicas, setReplicas] = useState(view.row.values.ready?.split("/")[1] ?? view.row.values.desired ?? "1");
  const [jobName, setJobName] = useState(`${name}-manual-${Math.floor(Date.now() / 1000)}`);
  const [revisions, setRevisions] = useState<K8sRevision[] | null>(null);
  const [revision, setRevision] = useState("");
  const [revisionError, setRevisionError] = useState("");
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (!picking) return;
    let alive = true;
    k8sApi.revisions(target, objectRef, ssoProfile).then(
      (result) => {
        if (alive) {
          setRevisions(result);
          setRevision(result[0]?.revision ?? "");
        }
      },
      (error) => {
        if (alive) setRevisionError(errorMessage(error));
      },
    );
    return () => {
      alive = false;
    };
  }, [picking, target, objectRef, ssoProfile]);

  /** 불완전한 규칙은 서버 판단에 맡기고 확실히 거부된 요청만 끈다. */
  const denied = (verb: string, group = kind.group, resource = kind.plural, named = true, subresource?: string) => {
    const result = rules && can(rules, { verb, group, resource, ...(subresource ? { subresource } : {}), ...(named ? { name } : {}) });
    return result === "no" ? t.CHANGE_DENIED(verb, subresource ? `${resource}/${subresource}` : resource) : undefined;
  };
  const patch = denied("patch");
  const revisionResource = kind.kind === "Deployment" ? "replicasets" : "controllerrevisions";
  const revisionDenied = patch ?? denied("get") ?? denied("list", "apps", revisionResource, false);
  const validReplicas = /^\d+$/.test(replicas) && Number.isSafeInteger(Number(replicas)) && Number(replicas) <= 2147483647;
  const suspended = view.row.values.suspend === "true";
  const node = kind.group === "" && kind.kind === "Node";
  const cordoned = view.row.values.status?.includes("SchedulingDisabled") ?? false;
  // drain은 노드를 cordon(patch)하고 Pod마다 Eviction(pods/eviction create)을 보낸다
  const drainDenied = patch ?? denied("create", "", "pods", false, "eviction");

  return (
    <div className="k8s-actions">
      {scalable && (
        <>
          <label>
            {t.CHANGE_REPLICAS} <input type="number" min="0" step="1" value={replicas} onChange={(e) => setReplicas(e.target.value)} />
          </label>
          <ActionButton label={t.CHANGE_SCALE} reason={patch} invalid={!validReplicas}
            onClick={() => onStart({ ...objectRef, type: "scale", replicas: Number(replicas) })} />
        </>
      )}
      {workload && (
        <>
          <ActionButton label={t.CHANGE_RESTART} reason={patch} onClick={() => onStart({ ...objectRef, type: "restart" })} />
          <ActionButton label={t.CHANGE_ROLLOUT_UNDO} reason={revisionDenied} onClick={() => setPicking(true)} />
          {picking && (
            <>
              <label>
                {t.CHANGE_REVISION}{" "}
                <select value={revision} onChange={(e) => setRevision(e.target.value)}>
                  <option value="">—</option>
                  {revisions?.map((r) => <option key={r.revision} value={r.revision}>{r.revision} — {r.name}</option>)}
                </select>
              </label>
              <ActionButton label={t.CHANGE_PREVIEW} reason={revisionDenied} invalid={!revision}
                onClick={() => onStart({ ...objectRef, type: "rolloutUndo", revision })} />
              {revisionError && <span className="err">{revisionError}</span>}
            </>
          )}
        </>
      )}
      {job && (
        <>
          <label>{t.CHANGE_JOB_NAME} <input value={jobName} onChange={(e) => setJobName(e.target.value)} /></label>
          <ActionButton label={cron ? t.CHANGE_RUN_NOW : t.CHANGE_RERUN} reason={denied("create", "batch", "jobs", false)}
            invalid={!jobName.trim()} onClick={() => onStart({ ...objectRef, type: "rerun", jobName })} />
        </>
      )}
      {cron && <ActionButton label={suspended ? t.CHANGE_RESUME : t.CHANGE_SUSPEND} reason={patch}
        onClick={() => onStart({ ...objectRef, type: "suspend", suspend: !suspended })} />}
      {node && (
        <ActionButton
          label={cordoned ? t.CHANGE_UNCORDON : t.CHANGE_CORDON}
          reason={patch}
          onClick={() => onStart({ ...objectRef, type: "cordon", unschedulable: !cordoned })}
        />
      )}
      {node && (
        <ActionButton
          label={t.CHANGE_DRAIN}
          reason={drainDenied}
          onClick={() => onStart({ ...objectRef, type: "drain" })}
        />
      )}
      <ActionButton label={t.CHANGE_DELETE} reason={denied("delete")} onClick={() => onStart({ ...objectRef, type: "delete" })} />
    </div>
  );
}

/** 권한이 없으면 이유를 함께 보여 주는 변경 버튼이다. */
function ActionButton({ label, reason, invalid, onClick }: {
  label: string; reason?: string; invalid?: boolean; onClick: () => void;
}) {
  return (
    <button className="btn small" disabled={!!reason || invalid} title={reason} aria-description={reason} onClick={onClick}>
      {label}
    </button>
  );
}
