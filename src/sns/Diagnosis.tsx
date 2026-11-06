import { useRef, useState } from "react";
import { desktop } from "../api/desktop";
import { errorMessage } from "../api/errors";
import { fixRequest } from "./change";
import * as ct from "./changeText";
import { DlqPicker } from "./DlqPicker";
import { endpointLabel } from "./format";
import { JsonView } from "./JsonView";
import { useSnsDiagnosis } from "./queries";
import { SnsChangeDialog } from "./SnsChangeDialog";
import type { SnsTopicRef } from "./targets";
import type { SnsCheck, SnsCheckStatus, SnsChangeRequest, SnsFix, SnsSubscription, SnsTopic } from "./types";

const marks: Record<SnsCheckStatus, [string, string]> = { ok: ["✓", "정상"], warn: ["!", "주의"], fail: ["✗", "실패"], skip: ["–", "판단 불가"] };
export function diagnosisStatus(checks: SnsCheck[]): SnsCheckStatus {
  return (["fail", "warn", "skip", "ok"] as const).find((status) => checks.some((check) => check.status === status)) ?? "skip";
}
export function diagnosisBadge(checks: SnsCheck[]) { return marks[diagnosisStatus(checks)]; }

/** 고치기 단추: 정책 문장·권한은 변경 대화창, DLQ는 큐 고르기를 거쳐 변경 대화창을 연다. kmsStatement는 키 정책을 바꾸지 않아서 복사만 있다 */
function Fix({ fix, blocked, onFix }: { fix: SnsFix; blocked: string | null; onFix: (fix: SnsFix) => void }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fixButton = (label: string) => (
    <button type="button" className="btn small tone-primary" disabled={blocked !== null} title={blocked ?? undefined} onClick={() => onFix(fix)}>
      {label}
    </button>
  );
  if (fix.kind === "addDlq") return <div><p>이 구독에 DLQ를 추가할 수 있어요.</p>{fixButton(ct.FIX_DLQ_OPEN)}</div>;
  const value = "statement" in fix ? fix.statement : { functionArn: fix.functionArn, statementId: fix.statementId, sourceArn: fix.sourceArn, principal: "sns.amazonaws.com", action: "lambda:InvokeFunction" };
  const copy = async () => {
    try { await desktop.copy(JSON.stringify(value, null, 2)); setCopied(true); setError(null); }
    catch (e) { setCopied(false); setError(errorMessage(e)); }
  };
  return <div><JsonView value={value} label="수정할 정책 문장" /><div className="sns-fix-actions"><button type="button" className="btn small tone-secondary" onClick={() => void copy()}>{copied ? "복사했어요" : "복사"}</button>{fix.kind !== "kmsStatement" && fixButton(ct.FIX_OPEN)}</div>{error && <p className="err" role="alert">{error}</p>}</div>;
}
function Checks({ checks, blockedFix, onFix }: { checks: SnsCheck[]; blockedFix: (fix: SnsFix) => string | null; onFix: (fix: SnsFix) => void }) {
  return <ul className="tailscale-checks">{checks.map((check, i) => <li key={`${check.id}-${i}`} className={`tailscale-check tailscale-check-${check.status}`}>
    <span className="tailscale-mark" aria-label={marks[check.status][1]}>{marks[check.status][0]}</span>
    <div><span>{check.summary}</span>{(check.detail || check.fix) && <details><summary>자세히</summary>{check.detail && <p>{check.detail}</p>}{check.fix && <Fix fix={check.fix} blocked={blockedFix(check.fix)} onFix={onFix} />}</details>}</div>
  </li>)}</ul>;
}
export function Diagnosis({ target, topic }: { target: SnsTopicRef; topic: SnsTopic }) {
  const query = useSnsDiagnosis(target);
  const [picking, setPicking] = useState<SnsSubscription | null>(null);
  const [change, setChange] = useState<{ request: SnsChangeRequest; nonce: number } | null>(null);
  const nonce = useRef(0);
  const subscriptionOf = (fix: SnsFix) => (fix.kind === "addDlq" ? topic.subscriptions.find((s) => s.arn === fix.subscriptionArn || s.key === fix.subscriptionArn) ?? null : null);
  const blockedFix = (fix: SnsFix) => (fix.kind === "addDlq" && subscriptionOf(fix)?.arn == null ? ct.FIX_DLQ_MISSING : null);
  const open = (request: SnsChangeRequest) => setChange({ request, nonce: ++nonce.current });
  const onFix = (fix: SnsFix) => {
    if (fix.kind === "addDlq") setPicking(subscriptionOf(fix));
    else {
      const request = fixRequest(fix, target.topicArn);
      if (request) open(request);
    }
  };
  if (!query.data) return query.isError ? <section className="center sns-screen"><p className="err" role="alert">{errorMessage(query.error)}</p><button className="btn small tone-refresh" onClick={() => void query.refetch()}>다시 읽기</button></section> : <div className="empty" role="status">배달 경로를 진단하고 있어요</div>;
  return <section className="center sns-screen tailscale-diagnosis" aria-label="배달 진단">
    <h2>주제 점검</h2>
    {query.data.topicChecks.length ? <Checks checks={query.data.topicChecks} blockedFix={blockedFix} onFix={onFix} /> : <p className="dim">주제에 표시할 점검 결과가 없어요</p>}
    <h2>구독별 진단</h2>
    {query.data.subscriptions.length === 0 && <p className="dim">구독이 없어요</p>}
    {query.data.subscriptions.map((diagnosis) => {
      const sub = topic.subscriptions.find((item) => item.key === diagnosis.subscription);
      return <article className="sns-diagnosis-card" key={diagnosis.subscription}>
        <h3>{sub ? endpointLabel(sub, topic).name : diagnosis.subscription}</h3>
        <p className="tailscale-verdict">{diagnosis.verdict}</p><Checks checks={diagnosis.checks} blockedFix={blockedFix} onFix={onFix} />
      </article>;
    })}
    {picking && <DlqPicker target={target} topic={topic} subscription={picking} onClose={() => setPicking(null)} onPick={(dlqArn) => {
      if (picking.arn === null) return;
      open({ kind: "addDlq", subscriptionArn: picking.arn, dlqArn });
      setPicking(null);
    }} />}
    {change && <SnsChangeDialog key={change.nonce} profile={target.profile} region={target.region} request={change.request} onClose={() => setChange(null)} />}
  </section>;
}
