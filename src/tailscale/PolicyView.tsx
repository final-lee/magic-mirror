import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage } from "../api/errors";
import { desktop } from "../api/desktop";
import { CodeEditor } from "../components/CodeEditor";
import { tailscaleApi } from "./api";
import { ApiRequired } from "./ApiRequired";
import { PolicyAccess } from "./PolicyAccess";
import { PolicySaveDialog } from "./PolicySaveDialog";
import * as p from "./policyText";
import type { PolicySaveOutcome, PolicyValidation, TsPolicy } from "./policyTypes";
import * as t from "./text";
import { useTailscaleApi } from "./useTailscaleApi";

/** 정책 탭: 지적, 누가 무엇에 닿나, 편집(검사 → 미리보기 → 저장). API 연결이 있어야 한다. */
export function PolicyView() {
  const { tailnet, connected, isLoading } = useTailscaleApi();
  if (isLoading) return <div className="empty">{t.API_LOADING}</div>;
  if (!connected || !tailnet) return <ApiRequired title={t.TAB_POLICY} />;
  return <PolicyPanel tailnet={tailnet} />;
}

function PolicyPanel({ tailnet }: { tailnet: string }) {
  const qc = useQueryClient();
  const [saved, setSaved] = useState<PolicySaveOutcome | null>(null);
  const policy = useQuery({ queryKey: ["tailscale", "policy", tailnet], queryFn: () => tailscaleApi.policy(tailnet), staleTime: Infinity, retry: false });

  if (policy.isError) {
    return (
      <div className="ts-policy">
        <div className="err" role="alert">
          {errorMessage(policy.error)}
        </div>
        <button className="btn small tone-refresh" onClick={() => void policy.refetch()}>
          {p.RELOAD}
        </button>
      </div>
    );
  }
  if (!policy.data) return <div className="empty">{p.POLICY_LOADING}</div>;

  const reload = () => {
    setSaved(null);
    void policy.refetch();
  };
  const afterSave = (outcome: PolicySaveOutcome) => {
    setSaved(outcome);
    void qc.invalidateQueries({ queryKey: ["tailscale", "changes", tailnet] });
    void policy.refetch();
  };
  // 다시 불러오면 편집기와 초안을 새로 만든다
  return (
    <>
      {saved && (
        <div className="ts-policy-saved" role="status">
          <div className="ok">{p.SAVED}</div>
          {saved.recordError && <div className="ts-warn">{saved.recordError}</div>}
        </div>
      )}
      <PolicyLoaded key={policy.dataUpdatedAt} tailnet={tailnet} policy={policy.data} onReload={reload} onSaved={afterSave} />
    </>
  );
}

interface Check {
  /** 검사한 글. 지금 글과 다르면 결과를 보여 주지 않는다 */
  doc: string;
  state: "running" | "done" | "error";
  result?: PolicyValidation;
  error?: string;
}

function PolicyLoaded({ tailnet, policy, onReload, onSaved }: {
  tailnet: string; policy: TsPolicy; onReload: () => void; onSaved: (o: PolicySaveOutcome) => void;
}) {
  const [text, setText] = useState(policy.text);
  const [check, setCheck] = useState<Check | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const readOnly = policy.externallyManaged;
  const changed = text !== policy.text;
  const shown = check && check.doc === text ? check : null;

  const validate = async () => {
    const doc = text;
    setCheck({ doc, state: "running" });
    try {
      const result = await tailscaleApi.policyValidate(tailnet, doc);
      setCheck((c) => (c?.doc === doc ? { doc, state: "done", result } : c));
    } catch (e) {
      setCheck((c) => (c?.doc === doc ? { doc, state: "error", error: errorMessage(e) } : c));
    }
  };

  return (
    <>
      <div className="awc-bar">
        <h2 className="awc-title">{t.TAB_POLICY}</h2>
        <span className="awc-stat">{p.FINDINGS} <b>{policy.findings.length}</b></span>
        <div className="awc-bar-end">
          <button className={`btn small ${changed ? "tone-ghost-danger" : "tone-refresh"}`} onClick={onReload}>{changed ? p.RELOAD_DISCARD : p.RELOAD}</button>
        </div>
      </div>
      <div className="awc-body"><div className="ts-policy">
      {readOnly && (
        <div className="notice" role="status">
          {p.EXTERNAL_NOTICE}{" "}
          {policy.externalLink && (
            <button className="btn small tone-nav" onClick={() => void desktop.openUrl(policy.externalLink!)} title={policy.externalLink}>
              {p.EXTERNAL_OPEN}
            </button>
          )}
        </div>
      )}

      <section className="ts-policy-section" aria-label={p.FINDINGS}>
        <h3>
          {p.FINDINGS} <span className="dim">{p.FINDINGS_BASIS}</span>
        </h3>
        {policy.findings.length === 0 ? (
          <p className="ok">{p.NO_FINDINGS}</p>
        ) : (
          <ul className="ts-findings">
            {policy.findings.map((f, i) => (
              <li key={i} data-severity={f.severity}>
                <span className={`iam-chip ${p.SEVERITY[f.severity].chip}`}>{p.SEVERITY[f.severity].label}</span>{" "}
                <b>{f.title}</b> <code className="mono dim">{f.path}</code>
                <div className="dim">{f.detail}</div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <PolicyAccess tailnet={tailnet} text={text} edited={changed} />

      <section className="ts-policy-section" aria-label={p.EDIT}>
        <h3>{p.EDIT}</h3>
        {readOnly ? (
          <CodeEditor key={policy.etag} value={policy.text} label={p.EDITOR_LABEL} language="hujson" minHeight="320px" readOnly />
        ) : (
          <>
            <CodeEditor value={policy.text} onChange={setText} label={p.EDITOR_LABEL} language="hujson" minHeight="320px" />
            <div className="dim ts-note">{p.EDIT_TIP}</div>
            <div className="ts-policy-actions">
              <button className="btn small tone-refresh" disabled={shown?.state === "running"} onClick={() => void validate()}>
                {shown?.state === "running" ? p.CHECKING : p.CHECK}
              </button>
              <button className="btn plain tone-primary" disabled={!changed} onClick={() => setReviewing(true)}>
                {p.PREVIEW}
              </button>
              {!changed && <span className="dim">{p.UNCHANGED}</span>}
            </div>
            {shown && shown.state !== "running" && <CheckResult check={shown} />}
          </>
        )}
      </section>

      {reviewing && (
        <PolicySaveDialog
          tailnet={tailnet}
          before={policy.text}
          etag={policy.etag}
          after={text}
          onCancel={() => setReviewing(false)}
          onReload={onReload}
          onSaved={(outcome) => {
            setReviewing(false);
            onSaved(outcome);
          }}
        />
      )}
      </div></div>
    </>
  );
}

function CheckResult({ check }: { check: Check }) {
  if (check.state === "error") {
    return (
      <div className="err" role="alert">
        {p.CHECK_ERROR}: {check.error}
      </div>
    );
  }
  const result = check.result!;
  const warned = result.issues.some((i) => i.warnings.length > 0);
  const title = result.ok ? (warned ? p.CHECK_WARNINGS : p.CHECK_OK) : p.CHECK_FAILED;
  return (
    <div className="ts-check" aria-live="polite">
      <div className={result.ok ? (warned ? "ts-warn" : "ok") : "err"}>{title}</div>
      {result.message && !result.ok && <div className="err">{result.message}</div>}
      <ul>
        {result.issues.map((issue, i) => (
          <li key={i}>
            {issue.subject && <b className="mono">{issue.subject}</b>}
            {issue.errors.map((e, j) => (
              <div key={`e${j}`} className="err">
                {e}
              </div>
            ))}
            {issue.warnings.map((w, j) => (
              <div key={`w${j}`} className="ts-warn">
                {w}
              </div>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
