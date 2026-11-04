import { useEffect, useState } from "react";
import { errorMessage } from "../api/errors";
import { k8sApi } from "./api";
import { can } from "./can";
import { PODS } from "./kinds";
import { streamPermission } from "./streams";
import * as t from "./text";
import type { K8sChange, K8sObjectView, K8sRevision, K8sRules, K8sTarget, ObjectRef } from "./types";

interface Props {
  target: K8sTarget;
  ssoProfile: string;
  objectRef: ObjectRef;
  view: K8sObjectView;
  rules: K8sRules | undefined;
  /** 노드 셸 Pod를 만들 네임스페이스(고른 네임스페이스, 모든 네임스페이스면 default) */
  shellNamespace?: string;
  onStart: (change: K8sChange) => void;
}

/** 노드 셸 디버그 Pod의 기본 이미지(미리보기 전에 고칠 수 있다) */
export const NODE_SHELL_IMAGE = "busybox:1.36";

/** 노드 셸 Pod 이름: 소문자 DNS 라벨 */
const nodeShellPodName = () => `mm-node-shell-${Date.now().toString(36)}`;

/** 객체 종류와 권한에 맞는 워크로드 변경 버튼들. 상세 도구 줄(오른쪽 정렬) 안에 놓이고, 지우기처럼 되돌리기 어려운 것이 맨 오른쪽이다. */
export function ChangeActions({ target, ssoProfile, objectRef, view, rules, shellNamespace = "default", onStart }: Props) {
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
  const [shellImage, setShellImage] = useState(NODE_SHELL_IMAGE);

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
  // 노드 셸: 디버그 Pod 만들기(pods create)와 그 Pod에 들어가기(pods/exec)
  const nodeShellDenied =
    (rules && can(rules, { verb: "create", group: "", resource: "pods" }) === "no" ? t.CHANGE_DENIED("create", "pods") : undefined) ?? streamPermission(rules, "exec").reason ?? undefined;
  const cordoned = view.row.values.status?.includes("SchedulingDisabled") ?? false;
  // drain은 노드를 cordon(patch)하고 Pod마다 Eviction(pods/eviction create)을 보낸다
  const drainDenied = patch ?? denied("create", "", "pods", false, "eviction");

  return (
    <>
      {scalable && (
        <>
          <label>
            {t.CHANGE_REPLICAS}{" "}
            <input
              type="number"
              min="0"
              step="1"
              data-k8s-action="replicas"
              value={replicas}
              onChange={(e) => setReplicas(e.target.value)}
              onKeyDown={(e) => {
                // s로 이 칸에 와서 숫자를 고친 뒤 Enter로 미리보기를 연다(버튼을 누른 것과 같다)
                if (e.key === "Enter" && validReplicas && !patch) onStart({ ...objectRef, type: "scale", replicas: Number(replicas) });
              }}
            />
          </label>
          <ActionButton action="scale" label={t.CHANGE_SCALE} tone="primary" reason={patch} invalid={!validReplicas}
            onClick={() => onStart({ ...objectRef, type: "scale", replicas: Number(replicas) })} />
        </>
      )}
      {workload && (
        <>
          <ActionButton action="restart" label={t.CHANGE_RESTART} tone="warn" reason={patch} onClick={() => onStart({ ...objectRef, type: "restart" })} />
          <ActionButton label={t.CHANGE_ROLLOUT_UNDO} tone="warn" reason={revisionDenied} onClick={() => setPicking(true)} />
          {picking && (
            <>
              <label>
                {t.CHANGE_REVISION}{" "}
                <select value={revision} onChange={(e) => setRevision(e.target.value)}>
                  <option value="">—</option>
                  {revisions?.map((r) => <option key={r.revision} value={r.revision}>{r.revision} — {r.name}</option>)}
                </select>
              </label>
              <ActionButton label={t.CHANGE_PREVIEW} tone="primary" reason={revisionDenied} invalid={!revision}
                onClick={() => onStart({ ...objectRef, type: "rolloutUndo", revision })} />
              {revisionError && <span className="err">{revisionError}</span>}
            </>
          )}
        </>
      )}
      {job && (
        <>
          <label>{t.CHANGE_JOB_NAME} <input value={jobName} onChange={(e) => setJobName(e.target.value)} /></label>
          <ActionButton label={cron ? t.CHANGE_RUN_NOW : t.CHANGE_RERUN} tone="primary" reason={denied("create", "batch", "jobs", false)}
            invalid={!jobName.trim()} onClick={() => onStart({ ...objectRef, type: "rerun", jobName })} />
        </>
      )}
      {cron && <ActionButton label={suspended ? t.CHANGE_RESUME : t.CHANGE_SUSPEND} tone="warn" reason={patch}
        onClick={() => onStart({ ...objectRef, type: "suspend", suspend: !suspended })} />}
      {node && (
        <>
          <ActionButton
            action={cordoned ? "uncordon" : "cordon"}
            label={cordoned ? t.CHANGE_UNCORDON : t.CHANGE_CORDON}
            tone="warn"
            reason={patch}
            onClick={() => onStart({ ...objectRef, type: "cordon", unschedulable: !cordoned })}
          />
          <label>
            {t.CHANGE_NODE_SHELL_IMAGE} <input value={shellImage} onChange={(e) => setShellImage(e.target.value)} />
          </label>
          <ActionButton
            label={t.CHANGE_NODE_SHELL}
            tone="warn"
            reason={nodeShellDenied}
            invalid={!shellImage.trim() || /\s/.test(shellImage.trim())}
            onClick={() => onStart({ kind: PODS, namespace: shellNamespace, name: nodeShellPodName(), type: "nodeShell", node: name, image: shellImage.trim() })}
          />
          <ActionButton
            label={t.CHANGE_DRAIN}
            tone="danger"
            reason={drainDenied}
            onClick={() => onStart({ ...objectRef, type: "drain" })}
          />
        </>
      )}
      <ActionButton action="delete" label={t.CHANGE_DELETE} tone="danger" reason={denied("delete")} onClick={() => onStart({ ...objectRef, type: "delete" })} />
    </>
  );
}

/** 버튼 색: primary(파랑) 실행·미리보기, warn(노랑) 상태를 바꾸는 조작, danger(빨강) 지우기·비우기 */
type ActionTone = "primary" | "warn" | "danger";

/** 권한이 없으면 이유를 함께 보여 주는 변경 버튼이다. */
function ActionButton({ action, label, tone, reason, invalid, onClick }: {
  /** 한 글자 키(nav/rowKeys.ts)가 이 버튼을 찾는 이름 */
  action?: string; label: string; tone: ActionTone; reason?: string; invalid?: boolean; onClick: () => void;
}) {
  return (
    <button className={`btn small tone-${tone}`} data-k8s-action={action} disabled={!!reason || invalid} title={reason} aria-description={reason} onClick={onClick}>
      {label}
    </button>
  );
}
