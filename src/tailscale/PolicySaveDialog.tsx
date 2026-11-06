import { useMemo, useState } from "react";
import { errorMessage } from "../api/errors";
import { PreviewAlerts, CallList, ConfirmField, useSheetFocus } from "../iam/previewParts";
import { tailscaleApi } from "./api";
import { diffStats, lineDiff, withContext } from "./lineDiff";
import * as p from "./policyText";
import type { PolicySaveOutcome } from "./policyTypes";

interface Props {
  tailnet: string;
  /** 불러올 때의 정책 글과 ETag */
  before: string;
  etag: string | null;
  /** 저장할 정책 글 */
  after: string;
  onCancel: () => void;
  onSaved: (outcome: PolicySaveOutcome) => void;
  /** 다른 곳에서 정책이 바뀌었을 때 편집을 버리고 다시 불러온다 */
  onReload: () => void;
}

/** 정책 저장 미리보기: 줄 단위 차이, 보낼 API 호출, 테일넷 이름 입력 확인. 저장은 `If-Match`로 보낸다. */
export function PolicySaveDialog({ tailnet, before, etag, after, onCancel, onSaved, onReload }: Props) {
  const [typed, setTyped] = useState("");
  const [phase, setPhase] = useState<"ready" | "applying">("ready");
  const [error, setError] = useState<string | null>(null);
  const { sheetRef, trapTab, cancelRef, retryRef } = useSheetFocus(phase, onCancel);

  const diff = useMemo(() => lineDiff(before, after), [before, after]);
  const rows = useMemo(() => withContext(diff), [diff]);
  const { added, removed } = diffStats(diff);
  const failed = error !== null;
  const canSave = phase === "ready" && !failed && etag !== null && typed === tailnet;

  const save = async () => {
    if (!canSave || etag === null) return;
    setPhase("applying");
    try {
      onSaved(await tailscaleApi.policySave(tailnet, before, after, etag));
    } catch (e) {
      setError(errorMessage(e));
      setPhase("ready");
    }
  };

  return (
    <div className="modal" onClick={(e) => { if (e.target === e.currentTarget && phase !== "applying") onCancel(); }}>
      <div className="sheet wide cp" role="dialog" aria-modal="true" aria-label={p.SAVE_TITLE} ref={sheetRef} onKeyDown={trapTab}>
        <div className="cp-body">
          <h3>{p.SAVE_TITLE}</h3>
          <p className="cp-sum">{p.SAVE_SUMMARY}</p>

          <h4>{p.CALLS}</h4>
          <CallList
            calls={[
              {
                api: "POST /tailnet/-/acl",
                params: { "If-Match": etag ?? "-", "Content-Type": "application/hujson", 본문: p.bodySummary(after.split("\n").length), 권한: "policy_file" },
              },
            ]}
          />

          <h4>
            {p.DIFF_LABEL} <span className="dim">{p.diffStats(added, removed)}</span>
          </h4>
          <pre className="ts-diff" aria-label={p.DIFF_LABEL}>
            {rows.map((row, i) =>
              row.kind === "gap" ? (
                <div key={i} className="ts-diff-gap">
                  {p.gap(row.hidden)}
                </div>
              ) : (
                <div key={i} className={`ts-diff-${row.kind}`}>
                  {row.kind === "add" ? "+ " : row.kind === "del" ? "− " : "  "}
                  {row.text}
                </div>
              ),
            )}
          </pre>
          <p className="dim">{p.REVERSIBLE}</p>
          {etag === null && <div className="err">{p.NO_ETAG}</div>}
          <ConfirmField required={tailnet} typed={typed} onTyped={setTyped} locked={phase === "applying"} />
        </div>
        {error && <PreviewAlerts error={{ kind: "apply", message: error }} stale={false} />}
        <div className="foot">
          <button ref={cancelRef} className="btn plain tone-ghost" disabled={phase === "applying"} onClick={onCancel}>
            {p.CANCEL}
          </button>
          {error === p.CHANGED_ELSEWHERE && (
            <button ref={retryRef} className="btn plain tone-ghost-danger" onClick={onReload}>
              {p.RELOAD_DISCARD}
            </button>
          )}
          <button className="btn plain tone-primary" disabled={!canSave} title={etag === null ? p.NO_ETAG : undefined} onClick={() => void save()}>
            {phase === "applying" ? p.SAVING : p.SAVE}
          </button>
        </div>
      </div>
    </div>
  );
}
