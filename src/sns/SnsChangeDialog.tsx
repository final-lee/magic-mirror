import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { errorMessage, isAppError } from "../api/errors";
import { ErrorState } from "../components/ErrorState";
import { ConfirmField, PreviewAlerts, WarningList, useSheetFocus } from "../iam/previewParts";
import { snsApi } from "./api";
import { classifyDiff, formatSnsValue, isStalePlan } from "./change";
import * as t from "./changeText";
import { invalidateAfterChange } from "./queries";
import type { SnsApplyResult, SnsCall, SnsChangeRequest, SnsPlan } from "./types";

/**
 * 변경 대화창(S5 변경 틀). 진단의 고치기, 변경 기록의 되돌리기, 뒤 단계(S5b 구독·필터·정책 변경, S6 엿보기·다시 보내기)가 함께 쓴다.
 * 열리면 바로 미리보기(plan)를 받고, 호출·바뀌는 값·진단 변화·경고를 보여 준 뒤 [적용]을 눌러야 AWS에 쓴다.
 * ConfirmDialog와 같은 규칙: 처음 초점은 [취소], Esc는 취소(적용 중에는 안 됨), Tab은 창 안을 돌고, Enter로는 아무것도 실행하지 않는다.
 *
 * props
 * - `profile`, `region`: 쓸 프로필과 리전(주제 탭의 target).
 * - `request`: 무엇을 바꿀지. `{ kind: "undo", id }`면 변경 기록 `id`를 되돌리는 계획(undoPlan)을 받는다.
 *   다른 요청이 필요하면 `key`를 바꿔서 새로 여세요: 요청은 열릴 때 한 번만 읽고, [미리보기 다시 받기]는 같은 요청으로 다시 받는다.
 * - `onClose`: 창을 닫는다. 취소와 결과 화면의 [닫기]가 부른다(적용이 끝나도 저절로 닫지 않는다: 결과를 보여 줘야 해서).
 * - `onApplied?`: 적용 호출이 끝났을 때(일부만 적용하고 실패한 경우 포함) 결과와 함께 한 번 부른다.
 *
 * 동작
 * - 계획의 `confirm`이 있으면 그 글을 정확히 입력하기 전에는 [적용]이 꺼져 있다.
 * - 적용이 `stalePlan`으로 거절되면(미리보기 뒤에 상태가 바뀜) 알림을 띄우고 같은 요청으로 미리보기를 다시 받는다. 확인 문구도 다시 입력해야 한다.
 * - 적용을 마치면 이 주제의 스냅샷·진단·정책·변경 기록 쿼리를 무효화하고, 창은 결과(실행한 호출과 오류)로 바뀐다.
 * - [적용]의 색: 보내는 일이라 파랑(실행, `tone-primary`). 되돌리기(`plan.undoOf`가 있거나 `request.kind === "undo"`)는 주황(`tone-caution`). [취소]는 투명.
 */
export interface SnsChangeDialogProps {
  profile: string;
  region: string;
  request: SnsChangeRequest;
  onClose: () => void;
  onApplied?: (result: SnsApplyResult) => void;
}

type Phase = "loading" | "ready" | "applying" | "done";

export function SnsChangeDialog({ profile, region, request, onClose, onApplied }: SnsChangeDialogProps) {
  const qc = useQueryClient();
  const [phase, setPhase] = useState<Phase>("loading");
  const [plan, setPlan] = useState<SnsPlan | null>(null);
  const [planError, setPlanError] = useState<unknown>(null);
  const [applyError, setApplyError] = useState<unknown>(null);
  const [stale, setStale] = useState(false);
  const [result, setResult] = useState<SnsApplyResult | null>(null);
  const [typed, setTyped] = useState("");
  const { sheetRef, trapTab, cancelRef, retryRef } = useSheetFocus(phase, onClose);

  // 요청은 열릴 때 한 번만 읽는다(호출한 쪽이 매번 새 객체를 넘겨도 다시 받지 않는다)
  const requestRef = useRef(request);
  // 낡은 응답을 버리는 번호. 창이 닫힐 때도 올려서 닫힌 창에 상태를 쓰지 않는다
  const seq = useRef(0);

  const load = async (keepStale = false) => {
    const n = ++seq.current;
    setPhase("loading");
    setPlan(null);
    setPlanError(null);
    setApplyError(null);
    setTyped("");
    if (!keepStale) setStale(false);
    const req = requestRef.current;
    try {
      const next = req.kind === "undo" ? await snsApi.undoPlan(profile, region, req.id) : await snsApi.plan(profile, region, req);
      if (n !== seq.current) return;
      setPlan(next);
    } catch (e) {
      if (n !== seq.current) return;
      setPlanError(e);
    }
    setPhase("ready");
  };

  useEffect(() => {
    void load();
    return () => {
      seq.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const undo = plan ? plan.undoOf !== null : request.kind === "undo";
  const gateOpen = plan !== null && (plan.confirm === null || typed === plan.confirm);
  const canApply = phase === "ready" && gateOpen;

  const apply = async () => {
    if (!plan || !canApply) return;
    const n = ++seq.current;
    setPhase("applying");
    setApplyError(null);
    setStale(false);
    try {
      const done = await snsApi.apply(profile, region, plan);
      if (n !== seq.current) return;
      setResult(done);
      setPhase("done");
      void invalidateAfterChange(qc, { profile, region, topicArn: plan.topicArn });
      onApplied?.(done);
    } catch (e) {
      if (n !== seq.current) return;
      if (isStalePlan(e)) {
        setStale(true);
        await load(true);
      } else {
        setApplyError(e);
        setPhase("ready");
      }
    }
  };

  const title = undo ? t.UNDO_TITLE : t.requestTitle(request);
  // 확인 문구를 기다리는 중에만 버튼 옆에 안내한다. 미리보기를 받기 전·적용 중에는 버튼의 title만 이유를 말한다
  const gateHint = plan && phase === "ready" && !gateOpen ? t.CONFIRM_GATE : null;
  const disabledWhy = plan === null || phase === "loading" ? t.NOT_READY : gateHint;

  if (phase === "done" && result) {
    return (
      <div className="modal">
        <div className="sheet wide cp" role="dialog" aria-modal="true" aria-label={title} ref={sheetRef} onKeyDown={trapTab}>
          <ResultView result={result} undo={undo} />
          <div className="foot">
            <button ref={cancelRef} className="btn plain tone-ghost" onClick={onClose}>
              {t.CLOSE}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal">
      <div className="sheet wide cp" role="dialog" aria-modal="true" aria-label={title} ref={sheetRef} onKeyDown={trapTab}>
        <div className="cp-body">
          <h3>{title}</h3>
          {phase === "loading" && (
            <p className="dim" role="status">
              {t.PLAN_LOADING}
            </p>
          )}
          {stale && (
            <p className="cp-stale" role="status">
              {t.STALE_NOTICE}
            </p>
          )}
          {planError !== null && (
            <>
              <p className="sns-plan-failed">{t.PLAN_FAILED}</p>
              <ErrorState error={planError} profile={profile} onRetry={() => void load()} onLoggedIn={() => void load()} compact />
            </>
          )}
          {plan && <PlanBody plan={plan} />}
          {plan?.confirm && <ConfirmField required={plan.confirm} typed={typed} onTyped={setTyped} locked={phase === "applying"} />}
        </div>
        {applyError !== null &&
          (isAppError(applyError) && applyError.kind === "ssoExpired" ? (
            <ErrorState compact error={applyError} profile={profile} onRetry={() => setApplyError(null)} onLoggedIn={() => setApplyError(null)} />
          ) : (
            <PreviewAlerts error={{ kind: "apply", message: errorMessage(applyError) }} stale={false} />
          ))}
        <div className="foot">
          {gateHint && <span className="cp-hint">{gateHint}</span>}
          <button ref={cancelRef} className="btn plain tone-ghost" disabled={phase === "applying"} onClick={onClose}>
            {t.CANCEL}
          </button>
          {plan && (
            <button ref={retryRef} className="btn plain tone-refresh" disabled={phase !== "ready"} onClick={() => void load()}>
              {t.REPLAN}
            </button>
          )}
          <button
            className={`btn plain ${undo ? "tone-caution" : "tone-primary"}`}
            disabled={!canApply}
            title={canApply ? undefined : (disabledWhy ?? undefined)}
            aria-description={canApply ? undefined : (disabledWhy ?? undefined)}
            onClick={() => void apply()}
          >
            {phase === "applying" ? (undo ? t.UNDOING : t.APPLYING) : undo ? t.UNDO_APPLY : t.APPLY}
          </button>
        </div>
      </div>
    </div>
  );
}

function PlanBody({ plan }: { plan: SnsPlan }) {
  return (
    <>
      <p className="sns-plan-topic mono dim">{plan.topicArn}</p>
      <h4>{t.SECTION_CALLS}</h4>
      <CallBlocks calls={plan.calls} label={t.SECTION_CALLS} />
      <h4>{t.SECTION_FIELDS}</h4>
      {plan.fields.length === 0 ? (
        <p className="cp-none dim">{t.NO_FIELDS}</p>
      ) : (
        <ul className="sns-fields" aria-label={t.SECTION_FIELDS}>
          {plan.fields.map((f, i) => (
            <li key={`${f.field}-${i}`}>
              <b className="mono">{f.field}</b>
              {f.diff !== null ? (
                <DiffText diff={f.diff} />
              ) : (
                <div className="sns-before-after">
                  <span className="dim">{t.FIELD_BEFORE}</span>
                  <pre className="cp-val mono">{formatSnsValue(f.before, t.FIELD_NONE)}</pre>
                  <span className="dim">{t.FIELD_AFTER}</span>
                  <pre className="cp-val mono">{formatSnsValue(f.after, t.FIELD_NONE)}</pre>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {plan.impact.length > 0 && (
        <>
          <h4>{t.SECTION_IMPACT}</h4>
          <ul className="sns-impact" aria-label={t.SECTION_IMPACT}>
            {plan.impact.map((row, i) => (
              <li key={`${row.subscription}-${row.check}-${i}`}>
                <span className="mono sns-impact-sub">{row.subscription}</span>
                <b>{row.check}</b>
                <span className="sns-impact-before">{row.before}</span>
                <span aria-hidden="true">→</span>
                <span className="sns-impact-after">{row.after}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <WarningList warnings={plan.warnings.map((message) => ({ level: "warn" as const, message }))} />
    </>
  );
}

/** 호출 목록: API 이름, 대상, 본문(보기 좋은 JSON) */
function CallBlocks({ calls, label }: { calls: SnsCall[]; label: string }) {
  return (
    <ul className="cp-calls sns-calls" aria-label={label}>
      {calls.map((c, i) => (
        <li key={i}>
          <b className="mono">{c.api}</b>
          <div className="cp-param">
            <span className="dim">{t.CALL_TARGET}</span>
            <span className="cp-val mono">{c.target}</span>
          </div>
          <div className="cp-param">
            <span className="dim">{t.CALL_BODY}</span>
            <pre className="cp-val mono sns-body">{JSON.stringify(c.body, null, 2) ?? "null"}</pre>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** 정책 같은 긴 글의 줄 차이: 더한 줄은 초록, 뺀 줄은 빨강 */
function DiffText({ diff }: { diff: string }) {
  return (
    <pre className="sns-diff mono" aria-label={t.DIFF_LABEL}>
      {classifyDiff(diff).map((line, i) => (
        <div key={i} className={`sns-diff-${line.kind}`}>
          {line.text || " "}
        </div>
      ))}
    </pre>
  );
}

function ResultView({ result, undo }: { result: SnsApplyResult; undo: boolean }) {
  const ran = result.callsRun.length;
  const heading = result.error === null ? (undo ? t.RESULT_UNDO_OK : t.RESULT_OK) : ran > 0 ? t.RESULT_PARTIAL : t.RESULT_NONE;
  return (
    <div className="cp-body" data-testid="sns-result">
      <h3>{heading}</h3>
      {result.error !== null && (
        <div className="cp-error" role="alert">
          <div>{t.APPLY_FAILED}</div>
          <div>{result.error}</div>
        </div>
      )}
      <h4>{t.RESULT_CALLS}</h4>
      {ran === 0 ? (
        <p className="cp-none dim">{t.RESULT_NO_CALLS}</p>
      ) : (
        <ul className="sns-done-calls" aria-label={t.RESULT_CALLS}>
          {result.callsRun.map((c, i) => (
            <li key={i}>
              <b className="mono">{c.api}</b> <span className="mono dim">{c.target}</span>
            </li>
          ))}
        </ul>
      )}
      {result.error !== null && ran > 0 && result.recordId !== null && <p className="cp-note">{t.RESULT_PARTIAL_NOTE}</p>}
      {result.recordId !== null && <p className="dim">{t.RESULT_RECORDED}</p>}
    </div>
  );
}
