import { useState } from "react";
import { desktop } from "../api/desktop";
import { errorMessage } from "../api/errors";
import { formatDate } from "../lib/format";
import { ActionDialog, needsTypedName } from "./ActionDialog";
import { Artifacts } from "./Artifacts";
import { expandLink, linksFor, podLinkVars } from "./links";
import { changedParameters, initialParamValues, ParamFields } from "./ParamFields";
import { isTokenError } from "./queries";
import { relative } from "./WorkflowList";
import type { ArgoWfConn, ArgoWfLink, WfAction, WfContainer, WfDetail, WfNode, WfParam, WfTarget } from "./types";

type Dialog = "retry" | "stop" | "resume" | "values";

const dash = (items: string[]) => items.join(", ") || "—";
const pairs = (params: WfParam[]) => dash(params.map((p) => `${p.name}=${p.value ?? ""}`));
const resources = (m: Record<string, string>) =>
  dash(
    Object.entries(m)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`),
  );

export function ContainersTable({ containers }: { containers: WfContainer[] }) {
  if (containers.length === 0) return <p className="dim">컨테이너 정보가 없어요</p>;
  return (
    <table className="argowf-table argowf-containers">
      <thead>
        <tr>
          <th>이름</th>
          <th>역할</th>
          <th>이미지</th>
          <th>명령·인자</th>
          <th>작업 폴더</th>
          <th>env</th>
          <th>요청</th>
          <th>제한</th>
          <th>마운트</th>
        </tr>
      </thead>
      <tbody>
        {containers.map((c) => (
          <tr key={`${c.role}/${c.name}`}>
            <td>{c.name}</td>
            <td>{c.role}</td>
            <td className="mono">{c.image ?? "—"}</td>
            <td className="mono" title={[...c.command, ...c.args].join(" ")}>
              {dash([...c.command, ...c.args])}
            </td>
            <td className="mono">{c.workingDir ?? "—"}</td>
            <td className="mono">{dash(c.env)}</td>
            <td>{resources(c.requests)}</td>
            <td>{resources(c.limits)}</td>
            <td className="mono">{dash(c.volumeMounts)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * 노드 하나의 상세(단계·그래프 탭이 함께 쓴다): 메시지·템플릿·시각·재시도·예상 시간·host·memoization·입출력·exit code·Pod와 링크,
 * Containers, 아티팩트, 그리고 노드 동작(이 노드만 Retry·Resume·Stop, Suspend 노드는 값을 넣고 이어 가기).
 * act는 동작을 부르고 성공하면 반환, 실패하면 던진다(오류는 대화상자 안에 보인다).
 */
export function NodeDetail({
  conn,
  detail,
  node,
  target,
  links,
  act,
  onLogs,
  onNotice,
  onTokenError,
}: {
  conn: ArgoWfConn;
  detail: WfDetail;
  node: WfNode;
  target: WfTarget;
  links: ArgoWfLink[];
  act(action: WfAction, notify?: boolean): Promise<unknown>;
  onLogs(node: WfNode): void;
  onNotice(m: string): void;
  onTokenError(m: string): void;
}) {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [restartSuccessful, setRestartSuccessful] = useState(false);
  const [params, setParams] = useState<Record<string, string>>({});
  const [outputs, setOutputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { row } = detail;
  const live = target.kind === "live";
  const selector = `id=${node.id}`;
  const date = (value: string | null) => (value ? `${formatDate(value)} (${relative(value, Date.now())})` : "—");
  const suspended = node.type === "Suspend" && node.phase === "Running";
  const podLinks = node.podName ? [...linksFor(links, "pod"), ...linksFor(links, "pod-logs")] : [];

  const open = (next: Dialog) => {
    setFailure(null);
    setRestartSuccessful(false);
    setParams(initialParamValues(detail.parameters));
    setOutputs(initialParamValues(node.outputs));
    setDialog(next);
  };
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setFailure(null);
    try {
      await work();
      setDialog(null);
    } catch (e) {
      setFailure(errorMessage(e));
      if (isTokenError(e)) onTokenError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const confirm = () => {
    if (dialog === "retry")
      return run(() => act({ kind: "retry", restartSuccessful, nodeFieldSelector: selector, parameters: changedParameters(detail.parameters, params) }));
    if (dialog === "stop") return run(() => act({ kind: "stop", nodeFieldSelector: selector, message: null }));
    if (dialog === "resume") return run(() => act({ kind: "resume", nodeFieldSelector: selector }));
    // 값 넣고 이어 가기: 출력 파라미터를 넣은 다음 이어 간다
    const outputParameters = Object.fromEntries(Object.entries(outputs).filter(([, v]) => v !== ""));
    return run(async () => {
      await act({ kind: "setOutputs", nodeFieldSelector: selector, outputParameters, phase: null }, false);
      await act({ kind: "resume", nodeFieldSelector: selector });
    });
  };
  const title = { retry: "이 노드만 Retry", stop: "이 노드 Stop", resume: "Resume", values: "값 넣고 이어 가기" };

  return (
    <div className="argowf-node-detail">
      <h4>
        {node.displayName} · {node.phase}
      </h4>
      {node.message && <p>{node.message}</p>}
      <p>
        템플릿: {node.templateName ?? "—"} · 시작: {date(node.startedAt)} · 끝: {date(node.finishedAt)}
      </p>
      {node.type === "Retry" && <p>재시도 횟수: {node.children.length}</p>}
      {node.estimatedDuration !== null && <p>예상 걸린 시간: {node.estimatedDuration}초</p>}
      {node.hostNodeName && <p>Host node: {node.hostNodeName}</p>}
      {node.memoization && (
        <p>
          Memoization: {node.memoization.hit ? "적중" : "적중 안 함"} · 키 {node.memoization.key} · 캐시 {node.memoization.cacheName}
        </p>
      )}
      <p>입력: {pairs(node.inputs)}</p>
      <p>출력: {pairs(node.outputs)}</p>
      <p>exit code: {node.exitCode ?? "—"}</p>
      {node.podName && (
        <p>
          Pod: {node.podName}{" "}
          <button className="btn small" onClick={() => onLogs(node)}>
            로그
          </button>
          {podLinks.map((l) => (
            <button key={`${l.scope}/${l.name}`} className="btn small" onClick={() => void desktop.openUrl(expandLink(l, podLinkVars(row, node)))}>
              {l.name} ↗
            </button>
          ))}
        </p>
      )}
      <div className="argowf-node-acts">
        <button className="btn small" disabled={!["Failed", "Error"].includes(node.phase)} onClick={() => open("retry")}>
          이 노드만 Retry
        </button>
        {live && (
          <>
            <button className="btn small" disabled={!suspended} onClick={() => open("resume")}>
              노드 Resume
            </button>
            <button className="btn small" disabled={!["Running", "Pending"].includes(node.phase)} onClick={() => open("stop")}>
              노드 Stop
            </button>
            {suspended && node.outputs.length > 0 && (
              <button className="btn small primary" onClick={() => open("values")}>
                값 넣고 이어 가기
              </button>
            )}
          </>
        )}
      </div>
      <h5>Containers</h5>
      <ContainersTable containers={node.containers} />
      <h5>아티팩트</h5>
      <Artifacts conn={conn} target={target} nodeId={node.id} artifacts={node.artifacts} onNotice={onNotice} onTokenError={onTokenError} />
      {dialog && (
        <ActionDialog
          title={`${node.displayName} ${title[dialog]}`}
          note={dialog === "values" ? "출력 파라미터 값을 넣고 이 노드를 이어 가요." : `이 노드(${node.id})에만 ${title[dialog]} 동작을 적용할까요?`}
          confirmLabel="적용"
          danger={dialog === "stop"}
          requireName={dialog === "stop" && needsTypedName(row.namespace, row.name) ? row.name : null}
          busy={busy}
          error={failure}
          onCancel={() => setDialog(null)}
          onConfirm={() => void confirm()}
        >
          {dialog === "retry" && (
            <>
              <label>
                <input type="checkbox" checked={restartSuccessful} onChange={(e) => setRestartSuccessful(e.target.checked)} /> 성공한 단계도 다시
              </label>
              <ParamFields params={detail.parameters} values={params} onChange={setParams} />
            </>
          )}
          {dialog === "values" && <ParamFields params={node.outputs} values={outputs} onChange={setOutputs} />}
        </ActionDialog>
      )}
    </div>
  );
}
