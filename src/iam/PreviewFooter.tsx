import type { RefObject } from "react";
import { GATE_HINT, PreviewAlerts } from "./previewParts";
import { applyGate, type Gated } from "./useIamChange";

interface Props {
  /** 받은 미리보기의 경고와 확인 문구(묶음은 변경마다의 경고까지 모은 것). 아직 받지 못했으면 null이고 [적용]은 꺼진다 */
  gated: Gated | null;
  phase: string;
  error: { kind: "preview" | "apply"; message: string } | null;
  /** 적용에 실패했다. 미리보기를 다시 받기 전에는 적용할 수 없다 */
  stale: boolean;
  /** 입력해 둔 확인 문구 */
  typed: string;
  /** useSheetFocus가 준 ref: 처음 초점은 [취소]에, 적용이 끝나 돌아온 초점은 [미리보기 다시 받기](없으면 [취소])에 간다 */
  cancelRef: RefObject<HTMLButtonElement>;
  retryRef: RefObject<HTMLButtonElement>;
  /** 적용을 누르면 입력한 확인 문구와 함께 부른다 */
  onApply: (typed: string) => void;
  onRetry: () => void;
  onCancel: () => void;
  /** [적용] 버튼의 글. 주지 않으면 "적용" */
  applyLabel?: string;
  /** 적용 중일 때 [적용] 버튼의 글. 주지 않으면 "적용 중…" */
  busyLabel?: string;
  /** 지금은 바꿀 수 없는 이유(changeBlockReason). 있으면 [적용]이 꺼지고 이 글이 제목이다. 주지 않으면 IAM처럼 막지 않는다 */
  blockReason?: string | null;
}

/**
 * 변경 미리보기 창(IAM 하나짜리, PostgreSQL 하나짜리와 묶음)이 함께 쓰는 아래쪽: 오류 안내, 안내 문구, [취소] [미리보기 다시 받기] [적용].
 * - 적용은 applyGate가 허락하고 미리보기를 받았고 적용 중이 아니고 낡지 않았을 때만 켠다(훅의 apply도 같은 규칙을 따로 확인한다).
 * - 확인 문구로 풀 수 없는 이유(막힘, 문구 없음)는 버튼 옆에 적는다. 문구를 입력 중일 때는 아무 말도 하지 않는다.
 * - 확인 문구나 막힘이 아닌 경고가 있으면 위험한 변경이라 버튼을 danger로 칠한다.
 * 오류는 스크롤되는 본문 밖, 버튼 바로 위에 둔다: 미리보기가 길어도 가려지지 않는다.
 */
export function PreviewFooter({ gated, phase, error, stale, typed, cancelRef, retryRef, onApply, onRetry, onCancel, applyLabel = "적용", busyLabel = "적용 중…", blockReason = null }: Props) {
  const applying = phase === "applying";
  const gate = gated ? applyGate(gated, typed) : null;
  const canApply = gate?.ok === true && phase === "ready" && !stale && blockReason === null;
  const needsRetry = (error?.kind === "preview" || stale) && !applying;
  const danger = !!gated && (!!gated.confirmText || gated.warnings.some((w) => w.level !== "block"));
  const hint = gate && !gate.ok && gate.reason !== "text" ? GATE_HINT[gate.reason] : null;

  return (
    <>
      <PreviewAlerts error={error} stale={stale} />
      <div className="foot">
        {hint && <span className="cp-hint">{hint}</span>}
        <button ref={cancelRef} className="btn plain" disabled={applying} onClick={onCancel}>
          취소
        </button>
        {needsRetry && (
          <button ref={retryRef} className="btn" onClick={onRetry}>
            미리보기 다시 받기
          </button>
        )}
        <button className={`btn ${danger ? "danger" : "primary"}`} disabled={!canApply} title={blockReason ?? undefined} aria-description={blockReason ?? undefined} onClick={() => onApply(typed)}>
          {applying ? busyLabel : applyLabel}
        </button>
      </div>
    </>
  );
}
