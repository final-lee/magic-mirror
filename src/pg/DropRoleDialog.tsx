import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { errorMessage } from "../api/errors";
import { PreviewFooter } from "../iam/PreviewFooter";
import { ConfirmField, WarningList, useSheetFocus } from "../iam/previewParts";
import { applyGate } from "../iam/useIamChange";
import { pgApi } from "./api";
import { collate, confirmLabel } from "./labels";
import { PgError } from "./PgError";
import { REFRESH_FAILED_TEXT, refreshPgAfterChange, usePgDropPlan } from "./queries";
import type { PgDropPlan, PgDropResult, PgOverview, PgTarget } from "./types";

/** 삭제를 마친 역할의 안내 글 */
export const droppedSummary = (role: string) => `역할 삭제: ${role}`;
/** 계획에서 아직 실행하지 않은 단계에 붙는 말(중간에 멈췄을 때) */
export const NOT_RUN_TEXT = "실행하지 않음";

interface Props {
  target: PgTarget;
  role: string;
  overview: PgOverview;
  /** 닫기. 적용 중에는 닫을 수 없다 */
  onClose: () => void;
  /** 역할을 모두 지웠다(창은 이 호출 뒤에 닫힌다). refreshed가 false면 목록을 다시 읽지 못했다 */
  onDropped: (role: string, refreshed: boolean) => void;
}

const counts = (s: PgDropPlan["steps"][number]) => `객체 ${s.owned}개 · 권한 ${s.privileges}개 · 기본 권한 ${s.defaults}개`;

/**
 * 역할 삭제 창: 넘겨받을 역할을 고르면 그때마다 삭제 계획(pg_drop_plan)을 새로 받는다. 계획은 단계마다 데이터베이스와 실행할 SQL을 보인다.
 * 이름을 입력해 확인하고 [삭제]를 누르면 pg_apply_drop이 단계를 차례로 돈다. 도중에 멈추면 창을 연 채 그 말과 어디까지 했는지를 보인다.
 * 성공이든 멈췄든 화면은 다시 읽는다: 멈추기 전의 단계는 이미 커밋됐다.
 */
export function DropRoleDialog({ target, role, overview, onClose, onDropped }: Props) {
  const qc = useQueryClient();
  const id = useId();
  const [reassignTo, setReassignTo] = useState(overview.loginUser);
  const [typed, setTyped] = useState("");
  const [phase, setPhase] = useState<"ready" | "applying">("ready");
  const [error, setError] = useState<{ kind: "apply"; message: string } | null>(null);
  const [stale, setStale] = useState(false);
  // 멈춘 결과. 그때의 계획을 함께 들어 둔다: 다시 읽으면 계획이 줄어서 어디까지 했는지 알 수 없다
  const [stopped, setStopped] = useState<{ plan: PgDropPlan; result: PgDropResult; refreshed: boolean } | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const q = usePgDropPlan(target, role, stopped ? null : reassignTo);
  const plan = q.data;
  const { sheetRef, trapTab, cancelRef, retryRef } = useSheetFocus(phase, onClose);

  // 넘겨받을 수 있는 역할: 시스템이 아닌 역할(지우는 역할은 빼고)과 로그인한 역할
  const heirs = overview.roles.filter((r) => r.name !== role && (!r.system || r.name === overview.loginUser)).map((r) => r.name).sort(collate);

  const refresh = () =>
    new Promise<boolean>((resolve) => {
      void refreshPgAfterChange(qc, target, overview.target.defaultDatabase, resolve);
    });

  const apply = async (text: string) => {
    if (!plan || phase !== "ready" || stale || !applyGate(plan, text).ok) return;
    setPhase("applying");
    setError(null);
    try {
      const result = await pgApi.applyDrop(target, role, reassignTo, text);
      if (!alive.current) return;
      const refreshed = await refresh();
      if (!alive.current) return;
      if (result.stopped === null) {
        onDropped(role, refreshed);
        return;
      }
      setStopped({ plan, result, refreshed });
      setPhase("ready");
    } catch (e) {
      if (!alive.current) return;
      // 일부 단계가 이미 커밋됐을 수 있고 계획을 다시 비교하느라 백엔드가 새로 읽었으니 화면도 다시 읽는다
      void refresh();
      setError({ kind: "apply", message: errorMessage(e) });
      setStale(true);
      setPhase("ready");
    }
  };

  const retry = () => {
    setStale(false);
    setError(null);
    void q.refetch();
  };

  const shown = stopped?.plan ?? plan;
  const done = stopped?.result.done ?? 0;

  return (
    <div className="modal">
      <div className="sheet wide cp" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} ref={sheetRef} onKeyDown={trapTab}>
        <div className="cp-body">
          <h3 id={`${id}-title`}>역할 삭제</h3>
          <p className="cp-user">{`적용할 DB 사용자: ${overview.loginUser}`}</p>
          <p className="cp-sum">{droppedSummary(role)}</p>
          <label className="pg-form-field" htmlFor={`${id}-heir`}>
            넘겨받을 역할
          </label>
          <select id={`${id}-heir`} value={reassignTo} disabled={phase === "applying" || !!stopped} onChange={(e) => setReassignTo(e.target.value)}>
            {heirs.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          {!shown && (q.isError ? <PgError error={q.error} target={target} onRetry={() => void q.refetch()} /> : <p>삭제 계획을 불러오는 중이에요…</p>)}
          {shown && (
            <>
              <WarningList warnings={shown.warnings} />
              <h4>삭제 단계</h4>
              <ol className="pg-drop-steps" role="list" aria-label="삭제 단계">
                {shown.steps.map((step, i) => (
                  <li key={i} className="pg-drop-step">
                    <div className="pg-drop-head">
                      <b>{step.database ?? overview.target.defaultDatabase}</b>
                      <span className="dim">{counts(step)}</span>
                      {stopped && (i < done ? <span className="iam-chip allowed">✓</span> : <span className="dim">{NOT_RUN_TEXT}</span>)}
                    </div>
                    <ol className="cp-sql" role="list" aria-label={`${step.database ?? overview.target.defaultDatabase} 실행할 SQL`}>
                      {step.sql.map((statement, j) => (
                        <li key={j}>
                          <code className="mono cp-val">{statement}</code>
                        </li>
                      ))}
                    </ol>
                  </li>
                ))}
              </ol>
              {shown.grantedMemberships.length > 0 && (
                <>
                  <h4>함께 지워지는 구성원 관계</h4>
                  <ul className="pg-drop-members" aria-label="함께 지워지는 구성원 관계">
                    {shown.grantedMemberships.map((m) => (
                      <li key={`${m.member}\u0000${m.group}`}>
                        {`${m.member} → ${m.group}`}
                        {m.lost && <span className="dim"> 그룹에서 빠져요</span>}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {!stopped && <ConfirmField required={shown.confirmText} typed={typed} onTyped={setTyped} locked={phase === "applying"} label={confirmLabel(shown.confirmText)} />}
            </>
          )}
          {stopped && (
            <div className="cp-error" role="alert">
              <div>{stopped.result.stopped}</div>
              {!stopped.refreshed && <div>{REFRESH_FAILED_TEXT}</div>}
            </div>
          )}
        </div>
        {stopped ? (
          <div className="foot">
            <button ref={cancelRef} className="btn primary" onClick={onClose}>
              닫기
            </button>
          </div>
        ) : (
          <PreviewFooter
            gated={plan ?? null}
            phase={plan ? phase : "loading"}
            error={error}
            stale={stale}
            typed={typed}
            cancelRef={cancelRef}
            retryRef={retryRef}
            onApply={(text) => void apply(text)}
            onRetry={retry}
            onCancel={onClose}
          />
        )}
      </div>
    </div>
  );
}
