import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { desktop } from "../api/desktop";
import { errorMessage } from "../api/errors";
import { formatDate } from "../lib/format";
import type { LabelPick } from "../argocd/argoFilter";
import { DetailFrame, Kv } from "./catalogParts";
import { ActionDialog, needsTypedName } from "./ActionDialog";
import { argowfApi } from "./api";
import { expandLink, linksFor, workflowLinkVars } from "./links";
import { NodeDetail } from "./NodeDetail";
import { NodeTree, failedPod } from "./NodeTree";
import { changedParameters, initialParamValues, ParamFields } from "./ParamFields";
import { argowfKeys, isTokenError, useWorkflow } from "./queries";
import { WfGraph } from "./WfGraph";
import { WfLogs } from "./WfLogs";
import { argoUiUrl, widgetUrls } from "./widgets";
import { elapsed, relative } from "./WorkflowList";
import type { ArchivedAction, ArgoWfConn, ArgoWfInfo, ArtifactRef, TemplateKind, WfAction, WfNode, WfTarget } from "./types";

type ActionKind = WfAction["kind"];
const labels: Record<ActionKind, string> = {
  stop: "Stop",
  terminate: "Terminate",
  suspend: "Suspend",
  resume: "Resume",
  retry: "Retry",
  resubmit: "다시 제출",
  delete: "삭제",
  setOutputs: "값 넣기",
};
const DANGEROUS: ActionKind[] = ["delete", "terminate", "stop"];
export function WorkflowDetail({
  conn,
  target,
  live,
  kube,
  info,
  onClose,
  onOpenWorkflow,
  onOpenCron,
  onOpenTemplate,
  onLabelFilter,
  onResubmitYaml,
  onTokenError,
  onNotice,
}: {
  conn: ArgoWfConn;
  target: WfTarget;
  live: boolean;
  kube: boolean;
  info: ArgoWfInfo;
  onClose(): void;
  onOpenWorkflow(t: WfTarget): void;
  onOpenCron(namespace: string, name: string): void;
  onOpenTemplate(kind: TemplateKind, namespace: string | null, name: string): void;
  /** 레이블을 누르면 목록에 그 레이블 필터를 붙인다 */
  onLabelFilter?(pick: LabelPick): void;
  /** [YAML로 고쳐 다시 제출]: 편집기를 연다 */
  onResubmitYaml(namespace: string, yaml: string): void;
  onTokenError(m: string): void;
  onNotice?(m: string): void;
}) {
  const q = useWorkflow(conn, target, live);
  const qc = useQueryClient();
  const [tab, setTab] = useState("개요");
  const [selected, setSelected] = useState<string | null>(null);
  const [logPod, setLogPod] = useState<string | null>(null);
  const [jump, setJump] = useState(false);
  const [action, setAction] = useState<ActionKind | null>(null);
  const [retrySuccessful, setRetrySuccessful] = useState(false);
  const [memoized, setMemoized] = useState(false);
  const [params, setParams] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const d = q.data;
  const row = d?.row;
  const role = useQuery({
    queryKey: argowfKeys.roleArn(conn.url, row?.namespace ?? "", d?.serviceAccount ?? ""),
    queryFn: () => argowfApi.roleArn(conn, row!.namespace, d!.serviceAccount!),
    enabled: !!row && !!d?.serviceAccount && kube,
    retry: false,
  });
  const events = useQuery({
    queryKey: argowfKeys.events(conn.url, row?.namespace ?? "", row?.name ?? ""),
    queryFn: () => argowfApi.events(conn, row!.namespace, row!.name),
    enabled: !!row && kube && tab === "이벤트" && target.kind === "live",
    retry: false,
  });
  useEffect(() => {
    for (const e of [q.error, role.error, events.error]) if (e && isTokenError(e)) onTokenError(errorMessage(e));
  }, [q.error, role.error, events.error, onTokenError]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);
  if (!d || !row)
    return (
      <aside className="argowf-detail">
        <button className="btn small" onClick={onClose}>
          닫기
        </button>
        {q.isError ? <p className="err">{errorMessage(q.error)}</p> : <p className="dim">불러오는 중…</p>}
      </aside>
    );
  const active = row.phase === "Running" || row.phase === "Pending";
  const suspended = row.suspended || d.nodes.some((node) => node.type === "Suspend" && node.phase === "Running");
  const finished = ["Succeeded", "Failed", "Error"].includes(row.phase);
  const buttons: { kind: ActionKind; enabled: boolean }[] =
    target.kind === "archived"
      ? [
          { kind: "retry", enabled: true },
          { kind: "resubmit", enabled: true },
          { kind: "delete", enabled: true },
        ]
      : [
          { kind: "stop", enabled: active },
          { kind: "terminate", enabled: active },
          { kind: "suspend", enabled: row.phase === "Running" && !suspended },
          { kind: "resume", enabled: suspended },
          { kind: "retry", enabled: ["Failed", "Error"].includes(row.phase) },
          { kind: "resubmit", enabled: finished },
          { kind: "delete", enabled: true },
        ];
  const openAction = (kind: ActionKind) => {
    setAction(kind);
    setFailure(null);
    setRetrySuccessful(false);
    setMemoized(false);
    setParams(initialParamValues(d.parameters));
  };
  const notice = (message: string) => (onNotice ? onNotice(message) : setToast(message));
  /** 동작 하나를 부른다. 성공하면 새 Workflow 이름(있으면)을 돌려주고, 실패하면 던진다 */
  const act = async (value: WfAction, notify = true) => {
    const name =
      target.kind === "archived"
        ? await argowfApi.archivedAction(conn, target.uid, row.namespace, value as ArchivedAction)
        : await argowfApi.workflowAction(conn, row.namespace, row.name, value);
    void qc.invalidateQueries({ queryKey: argowfKeys.data(conn.url) });
    if (notify) notice(`${labels[value.kind]}했어요`);
    return name;
  };
  const perform = async () => {
    if (!action) return;
    const value: WfAction =
      action === "retry"
        ? { kind: action, restartSuccessful: retrySuccessful, nodeFieldSelector: null, parameters: changedParameters(d.parameters, params) }
        : action === "resubmit"
          ? { kind: action, memoized, parameters: Object.entries(params).map(([k, v]) => `${k}=${v}`) }
          : action === "stop"
            ? { kind: action, nodeFieldSelector: null, message: null }
            : action === "resume"
              ? { kind: action, nodeFieldSelector: null }
              : ({ kind: action } as WfAction);
    setBusy(true);
    setFailure(null);
    try {
      const name = await act(value);
      setAction(null);
      if (name && (action === "resubmit" || (target.kind === "archived" && action === "retry")))
        onOpenWorkflow({ kind: "live", namespace: row.namespace, name });
      else if (action === "delete") onClose();
    } catch (e) {
      setFailure(errorMessage(e));
      if (isTokenError(e)) onTokenError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const openLogs = (node: WfNode) => {
    setLogPod(node.podName);
    setJump(false);
    setTab("로그");
  };
  const resubmitYaml = async () => {
    try {
      // 살아 있는 Workflow는 status·managedFields를 뺀 편집용 YAML을 받는다. 보관 Workflow는 상세의 YAML
      const yaml = target.kind === "live" ? await argowfApi.manifest(conn, "Workflow", row.namespace, row.name) : d.yaml;
      onResubmitYaml(row.namespace, yaml);
    } catch (e) {
      notice(errorMessage(e));
      if (isTokenError(e)) onTokenError(errorMessage(e));
    }
  };
  const failed = ["Failed", "Error"].includes(row.phase) ? failedPod(d.nodes) : undefined;
  const now = Date.now();
  const date = (value: string | null) => (value ? `${formatDate(value)} (${relative(value, now)})` : "—");
  const selectedNode = selected ? d.nodes.find((n) => n.id === selected) : undefined;
  const archivedLogsOf = (podName: string | null): ArtifactRef | null => {
    const node = podName ? d.nodes.find((n) => n.podName === podName) : undefined;
    const artifact = node?.artifacts.find((a) => a.name === "main-logs" && a.direction === "output");
    return node && artifact ? { target, nodeId: node.id, name: artifact.name, direction: "output" } : null;
  };
  const nodePanel = selectedNode && (
    <NodeDetail
      conn={conn}
      detail={d}
      node={selectedNode}
      target={target}
      links={info.links}
      act={act}
      onLogs={openLogs}
      onNotice={notice}
      onTokenError={onTokenError}
    />
  );
  const origin = row.cron
    ? `workflows.argoproj.io/cron-workflow=${row.cron}`
    : row.template
      ? `workflows.argoproj.io/${row.clusterTemplate ? "cluster-workflow-template" : "workflow-template"}=${row.template}`
      : null;
  const copy = (text: string, done: string) => void desktop.copy(text).then(() => notice(done));
  const actions = (
    <>
      {failed && (
        <button
          className="btn small"
          onClick={() => {
            setSelected(failed.id);
            setLogPod(failed.podName);
            setJump(true);
            setTab("단계");
          }}
        >
          실패 단계로
        </button>
      )}
      {buttons.map((b) => (
        <button key={b.kind} className="btn small" disabled={!b.enabled} onClick={() => openAction(b.kind)}>
          {labels[b.kind]}
        </button>
      ))}
      <button className="btn small" onClick={() => void resubmitYaml()}>
        YAML로 고쳐 다시 제출
      </button>
    </>
  );
  return (
    <DetailFrame
      label={`Workflow ${row.name}`}
      kind={target.kind === "archived" ? "보관 Workflow" : "Workflow"}
      title={row.name}
      actions={actions}
      tabs={["개요", "그래프", "단계", ...(target.kind === "live" ? ["로그", "이벤트"] : []), "YAML"].map((t) => [t, t])}
      tab={tab}
      onTab={(t) => {
        setTab(t);
        if (t === "로그") setJump(false);
      }}
      onClose={onClose}
      banner={
        <>
          {q.deleted && <p className="err">이 Workflow가 지워졌어요</p>}
          {toast && <p role="status">{toast}</p>}
        </>
      }
    >
      <div className="argowf-header-meta">
        {row.namespace} · <span className={`argowf-phase ${row.phase}`}>{row.phase}</span> {row.progress} · {date(row.startedAt)} ~{" "}
        {row.finishedAt ? date(row.finishedAt) : "진행 중"} · {elapsed(row.startedAt, row.finishedAt, now)}
      </div>
      <div className="argowf-share">
        {target.kind === "live" && (
          <>
            <button className="btn small" onClick={() => void desktop.openUrl(argoUiUrl(conn.url, "workflow", row.namespace, row.name))}>
              Argo UI에서 열기
            </button>
            <button className="btn small" onClick={() => copy(argoUiUrl(conn.url, "workflow", row.namespace, row.name), "링크를 복사했어요")}>
              링크 복사
            </button>
            {origin && (
              <>
                <button className="btn small" onClick={() => copy(widgetUrls(conn.url, row.namespace, origin).badge, "상태 배지 주소를 복사했어요")}>
                  상태 배지 주소 복사
                </button>
                <button className="btn small" onClick={() => copy(widgetUrls(conn.url, row.namespace, origin).graph, "그래프 위젯 주소를 복사했어요")}>
                  그래프 위젯 주소 복사
                </button>
              </>
            )}
          </>
        )}
        {linksFor(info.links, "workflow").map((l) => (
          <button key={l.name} className="btn small" onClick={() => void desktop.openUrl(expandLink(l, workflowLinkVars(row)))}>
            {l.name} ↗
          </button>
        ))}
      </div>
      {tab === "개요" && (
        <dl className="kv">
          <Kv label="메시지">{row.message ?? "—"}</Kv>
          <Kv label="원천">
            {row.cron && (
              <button className="link mono" onClick={() => onOpenCron(row.namespace, row.cron!)}>
                ⏱ {row.cron}
              </button>
            )}
            {row.template && (
              <button
                className="link mono"
                onClick={() =>
                  onOpenTemplate(
                    row.clusterTemplate ? "ClusterWorkflowTemplate" : "WorkflowTemplate",
                    row.clusterTemplate ? null : row.namespace,
                    row.template!,
                  )
                }
              >
                📄 {row.template}
              </button>
            )}
            {!row.cron && !row.template && "직접"}
          </Kv>
          <Kv label="어디서 왔나">
            {d.createdFrom
              .filter((c) => c.kind !== "cron" && c.kind !== "template" && c.kind !== "clusterTemplate")
              .map((c) =>
                c.kind === "event" ? (
                  <span key={`${c.kind}/${c.name}`}>이벤트 {c.name} </span>
                ) : (
                  <button key={`${c.kind}/${c.name}`} className="link" onClick={() => onOpenWorkflow({ kind: "live", namespace: row.namespace, name: c.name })}>
                    {c.kind === "resubmit" ? "다시 제출한 원본" : "부모 Workflow"} {c.name}
                  </button>
                ),
              )}
          </Kv>
          <Kv label="실행자">{row.creator ?? "—"}</Kv>
          <Kv label="조건">{d.conditions.map((c) => `${c.type} ${c.status} ${c.message ?? ""}`).join(", ") || "—"}</Kv>
          <Kv label="파라미터">{d.parameters.map((p) => `${p.name}=${p.value ?? ""}`).join(", ") || "—"}</Kv>
          <Kv label="전역 출력">{d.outputs.map((p) => `${p.name}=${p.value ?? ""}`).join(", ")}</Kv>
          <Kv label="Entrypoint">{d.entrypoint ?? "—"}</Kv>
          <Kv label="ServiceAccount">
            {d.serviceAccount ?? "—"} {role.data && `· ${role.data}`}
          </Kv>
          <Kv label="제한 시간">{d.activeDeadlineSeconds === null ? "—" : `${d.activeDeadlineSeconds}초 (activeDeadlineSeconds)`}</Kv>
          <Kv label="podGC">{d.podGC ?? "—"}</Kv>
          <Kv label="TTL">{d.ttl ?? "—"}</Kv>
          <Kv label="자원 사용량">
            {Object.entries(d.resourcesDuration)
              .map(([k, v]) => `${k} ${v}초`)
              .join(", ") || "—"}
          </Kv>
          <Kv label="동기화">
            {d.synchronization.length > 0 && (
              <table className="argowf-table">
                <thead>
                  <tr>
                    <th>종류</th>
                    <th>키</th>
                    <th>잡은 것</th>
                    <th>기다리는 것</th>
                  </tr>
                </thead>
                <tbody>
                  {d.synchronization.map((s) => (
                    <tr key={`${s.kind}/${s.key}`}>
                      <td>{s.kind}</td>
                      <td className="mono">{s.key}</td>
                      <td>{s.holding.join(", ") || "—"}</td>
                      <td>{s.waiting.join(", ") || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Kv>
          <Kv label="레이블">
            {Object.entries(row.labels).map(([k, v]) =>
              onLabelFilter ? (
                <button key={k} className="argowf-label" title="이 레이블로 목록 거르기" onClick={() => onLabelFilter({ key: k, value: v === "" ? null : v })}>
                  {k}={v}
                </button>
              ) : (
                <span key={k} className="argowf-label">
                  {k}={v}
                </span>
              ),
            )}
          </Kv>
        </dl>
      )}
      {tab === "그래프" && (
        <>
          <WfGraph
            nodes={d.nodes}
            selected={selected}
            onSelect={(id) => {
              setSelected(id);
              setJump(false);
            }}
          />
          {nodePanel}
        </>
      )}
      {tab === "단계" && (
        <>
          <NodeTree
            detail={d}
            selected={selected}
            onSelect={(id) => {
              setSelected(id);
              setJump(false);
            }}
          />
          {nodePanel}
          {jump && target.kind === "live" && (
            <WfLogs
              conn={conn}
              namespace={row.namespace}
              name={row.name}
              pod={logPod}
              running={false}
              live={live}
              initialTail={50}
              archivedLogs={archivedLogsOf(logPod)}
              onNotice={notice}
              onTokenError={onTokenError}
            />
          )}
        </>
      )}
      {tab === "로그" && target.kind === "live" && (
        <>
          <label>
            Pod{" "}
            <select aria-label="로그 Pod" value={logPod ?? ""} onChange={(e) => setLogPod(e.target.value || null)}>
              <option value="">전체 Workflow</option>
              {d.nodes
                .filter((n) => n.podName)
                .map((n) => (
                  <option key={n.id} value={n.podName!}>
                    {n.displayName} · {n.podName}
                  </option>
                ))}
            </select>
          </label>
          <WfLogs
            key={logPod ?? "all"}
            conn={conn}
            namespace={row.namespace}
            name={row.name}
            pod={logPod}
            running={active}
            live={live}
            archivedLogs={archivedLogsOf(logPod)}
            onNotice={notice}
            onTokenError={onTokenError}
          />
        </>
      )}
      {tab === "이벤트" &&
        (kube ? (
          events.isError ? (
            <p className="err">{errorMessage(events.error)}</p>
          ) : (
            <table className="argowf-table">
              <thead>
                <tr>
                  <th>시각</th>
                  <th>종류</th>
                  <th>사유</th>
                  <th>대상</th>
                  <th>메시지</th>
                </tr>
              </thead>
              <tbody>
                {events.data?.map((e, i) => (
                  <tr key={i}>
                    <td>{date(e.at)}</td>
                    <td>{e.type}</td>
                    <td>{e.reason}</td>
                    <td>{e.object}</td>
                    <td>
                      {e.message} ({e.count})
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : (
          <p>kubeconfig context로 연결하면 이벤트도 보여요</p>
        ))}
      {tab === "YAML" && <pre>{d.yaml}</pre>}
      {action && (
        <ActionDialog
          title={`${row.name} ${labels[action]}`}
          note={`${labels[action]} 동작을 적용할까요?`}
          confirmLabel="적용"
          danger={action === "delete" || action === "terminate"}
          requireName={DANGEROUS.includes(action) && needsTypedName(row.namespace, row.name) ? row.name : null}
          busy={busy}
          error={failure}
          onCancel={() => setAction(null)}
          onConfirm={() => void perform()}
        >
          {action === "retry" && (
            <>
              <label>
                <input type="checkbox" checked={retrySuccessful} onChange={(e) => setRetrySuccessful(e.target.checked)} /> 성공한 단계도 다시
              </label>
              <ParamFields params={d.parameters} values={params} onChange={setParams} />
            </>
          )}
          {action === "resubmit" && (
            <>
              <label>
                <input type="checkbox" checked={memoized} onChange={(e) => setMemoized(e.target.checked)} /> memoized
              </label>
              <ParamFields params={d.parameters} values={params} onChange={setParams} />
            </>
          )}
        </ActionDialog>
      )}
    </DetailFrame>
  );
}
