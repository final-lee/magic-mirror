import { useState } from "react";
import { ErrorState } from "../components/ErrorState";
import { queueHealth } from "./group";
import { SqsFindings } from "./SqsFindings";
import { useSqsFlow } from "./queries";
import * as t from "./text";
import type { FlowNode, PolicyGrant, SqsJump, SqsQueue } from "./types";

interface Props {
  profile: string;
  region: string;
  queue: SqsQueue;
  /** 이 탭이 보일 때만 읽는다 */
  active: boolean;
  onJump: (jump: SqsJump) => void;
}

/** 흐름 노드 한 장: 종류·이름·상태, 정책 허용 여부, 다른 계정 표시, 자세히 펼침, 이동 버튼 */
function NodeCard({ node, side, onJump }: { node: FlowNode; side: "producer" | "consumer" | "other"; onJump: (jump: SqsJump) => void }) {
  const [open, setOpen] = useState(false);
  const kind = t.NODE_KIND[node.kind];
  // 큐 정책은 보내는 쪽의 허용만 말한다. 받는 쪽에서 null은 해당 없음이다
  const policy = node.allowedByPolicy === true ? "allowed" : node.allowedByPolicy === false ? "denied" : side === "producer" ? "unknown" : null;
  return (
    <div className={`sqs-node${policy === "denied" ? " denied" : ""}${node.crossAccount ? " cross" : ""}`}>
      <div className="sqs-node-head">
        <span className="sqs-node-icon" aria-hidden="true">
          {kind.icon}
        </span>
        <span className="sqs-node-title">
          <b className="mono sqs-wrap">{node.label}</b>
          <small className="dim">{kind.label}</small>
        </span>
      </div>
      <div className="sqs-node-chips">
        {node.state && <span className="iam-chip">{node.state}</span>}
        {policy === "allowed" && <span className="iam-chip allowed">{t.POLICY_ALLOWED}</span>}
        {policy === "denied" && <span className="iam-chip denied">{t.POLICY_DENIED}</span>}
        {policy === "unknown" && <span className="iam-chip">{t.POLICY_UNKNOWN}</span>}
        {node.crossAccount && (
          <span className="iam-chip" title={t.CROSS_ACCOUNT_TITLE}>
            {t.CROSS_ACCOUNT}
          </span>
        )}
      </div>
      {(node.detail.length > 0 || node.jump) && (
        <div className="sqs-node-tools">
          {node.detail.length > 0 && (
            <button type="button" className="btn small tone-secondary" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              {open ? t.NODE_DETAIL_HIDE : t.NODE_DETAIL}
            </button>
          )}
          {node.jump && (
            <button type="button" className="btn small tone-nav" onClick={() => onJump(node.jump!)} aria-label={`${node.label} ${t.NODE_OPEN}`}>
              {t.NODE_OPEN}
            </button>
          )}
        </div>
      )}
      {open && (
        <dl className="sqs-node-detail">
          {node.detail.map((d, i) => (
            <div key={`${d.label}-${i}`}>
              <dt>{d.label}</dt>
              <dd className="sqs-wrap">{d.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function Column({ title, empty, hint, nodes, side, onJump }: { title: string; empty: string; hint?: string; nodes: FlowNode[]; side: "producer" | "consumer"; onJump: (jump: SqsJump) => void }) {
  return (
    <section className="sqs-flow-col" aria-label={title}>
      <div className="sect">{`${title} ${nodes.length}`}</div>
      {nodes.length === 0 ? (
        <p className="dim sqs-flow-empty">
          {empty}
          {hint && <small>{hint}</small>}
        </p>
      ) : (
        nodes.map((n) => <NodeCard key={n.id} node={n} side={side} onJump={onJump} />)
      )}
    </section>
  );
}

function PolicyTable({ grants }: { grants: PolicyGrant[] }) {
  if (grants.length === 0) return <p className="dim">{t.NO_POLICY}</p>;
  return (
    <table className="sqs-policy-table">
      <thead>
        <tr>
          <th>{t.POLICY_COL.effect}</th>
          <th>{t.POLICY_COL.principals}</th>
          <th>{t.POLICY_COL.actions}</th>
          <th>{t.POLICY_COL.conditions}</th>
        </tr>
      </thead>
      <tbody>
        {grants.map((g, i) => (
          <tr key={`${g.sid ?? ""}-${i}`}>
            <td>
              <span className={`iam-chip ${g.effect === "Allow" ? "allowed" : "denied"}`}>{g.effect}</span>
              {g.public && (
                <span className="iam-chip denied" title={t.POLICY_PUBLIC_TITLE}>
                  {t.POLICY_PUBLIC}
                </span>
              )}
              {g.sid && <div className="dim mono">{g.sid}</div>}
            </td>
            <td className="mono">{g.principals.join(", ")}</td>
            <td className="mono">{g.actions.join(", ")}</td>
            <td className="mono">
              {g.conditions.length === 0 ? <span className="dim">{t.NO_DATA}</span> : g.conditions.map((c) => <div key={c}>{c}</div>)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Flow({ profile, region, queue, active, onJump }: Props) {
  // IAM 계산은 버튼을 눌러야 한다(계정 IAM 전체를 읽는다). 큐를 바꾸면 이 컴포넌트가 새로 뜬다
  const [withIam, setWithIam] = useState(false);
  const q = useSqsFlow(profile, region, queue.url, withIam, active);
  const flow = q.data;
  if (!flow) {
    return q.isError ? <ErrorState error={q.error} profile={profile} onRetry={() => void q.refetch()} /> : <div className="empty small">{t.FLOW_LOADING}</div>;
  }
  const health = queueHealth(queue);
  const busy = q.isFetching;
  const calcIam = () => (withIam ? void q.refetch() : setWithIam(true));
  return (
    <div className="sqs-flow">
      {q.isError && <ErrorState compact error={q.error} profile={profile} onRetry={() => void q.refetch()} />}
      <div className="sqs-flow-bar">
        <span className="dim">{t.flowSummary(flow)}</span>
        {flow.iam && <span className="iam-chip allowed">{t.IAM_DONE}</span>}
        <span className="sqs-flow-bar-end">
          <button type="button" className="btn small tone-refresh" onClick={calcIam} disabled={busy}>
            {busy && withIam ? t.CALCULATING : flow.iam ? t.RECALC_IAM : t.CALC_IAM}
          </button>
          <button type="button" className="btn small tone-refresh" onClick={() => void q.refetch()} disabled={busy}>
            {busy ? t.READING : t.REREAD}
          </button>
        </span>
      </div>
      {flow.gaps.length > 0 && (
        <div className="notice sqs-gaps" role="status">
          <b>{t.FLOW_GAPS}</b>
          <ul>
            {flow.gaps.map((g, i) => (
              <li key={`${g.section}-${i}`}>{t.gap(g.section, g.error)}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="sqs-flow-grid">
        <Column title={t.FLOW_PRODUCERS} empty={t.NO_PRODUCERS} hint={flow.iam ? undefined : t.NO_IAM_YET} nodes={flow.producers} side="producer" onJump={onJump} />
        <div className="sqs-flow-arrow" aria-hidden="true">
          →
        </div>
        <section className="sqs-flow-col sqs-flow-center" aria-label={queue.name}>
          <div className="sect">{queue.isDlq ? t.BADGE_DLQ : t.FLOW_QUEUE}</div>
          <div className={`sqs-node sqs-flow-queue ${health}`}>
            <div className="sqs-node-head">
              <span className="sqs-node-icon" aria-hidden="true">
                {t.NODE_KIND.queue.icon}
              </span>
              <span className="sqs-node-title">
                <b className="mono sqs-wrap">{queue.name}</b>
                <small className="dim">{`${t.COL_VISIBLE} ${queue.visible} · ${t.COL_IN_FLIGHT} ${queue.inFlight} · ${t.COL_DELAYED} ${queue.delayed}`}</small>
              </span>
            </div>
          </div>
        </section>
        <div className="sqs-flow-arrow" aria-hidden="true">
          →
        </div>
        <Column title={t.FLOW_CONSUMERS} empty={t.NO_CONSUMERS} hint={flow.iam ? undefined : t.NO_IAM_YET} nodes={flow.consumers} side="consumer" onJump={onJump} />
      </div>
      {(flow.dlq || flow.sources.length > 0) && (
        <div className="sqs-flow-below">
          {flow.dlq && (
            <section className="sqs-flow-col" aria-label={t.FLOW_DLQ}>
              <div className="sect">{t.FLOW_DLQ}</div>
              <NodeCard node={flow.dlq} side="other" onJump={onJump} />
            </section>
          )}
          {flow.sources.length > 0 && (
            <section className="sqs-flow-col" aria-label={t.FLOW_SOURCES}>
              <div className="sect">{`${t.FLOW_SOURCES} ${flow.sources.length}`}</div>
              {flow.sources.map((n) => (
                <NodeCard key={n.id} node={n} side="other" onJump={onJump} />
              ))}
            </section>
          )}
        </div>
      )}
      <section aria-label={t.FLOW_FINDINGS}>
        <div className="sect">{t.FLOW_FINDINGS}</div>
        <SqsFindings findings={flow.findings} emptyText={t.FLOW_FINDINGS_OK} />
      </section>
      <section aria-label={t.FLOW_POLICY}>
        <div className="sect">{t.FLOW_POLICY}</div>
        <PolicyTable grants={flow.policy} />
      </section>
    </div>
  );
}
