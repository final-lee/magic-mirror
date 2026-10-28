import { useState } from "react";
import { ConfirmField, GATE_HINT, PreviewAlerts, useSheetFocus } from "../iam/previewParts";
import { applyGate } from "../iam/useIamChange";
import { changeSummary } from "./changeText";
import { PasswordResult } from "./PasswordResult";
import { PreviewBody } from "./PreviewBody";
import type { PgChange } from "./types";
import type { PendingPgChange } from "./usePgChange";

interface Props {
  pending: PendingPgChange;
  /** 적용을 누르면 입력한 확인 문구와 함께 부른다. 적용 가능 여부는 여기서도 훅에서도 따로 확인한다 */
  onApply: (typed: string) => void;
  onRetry: () => void;
  /** 취소. 비밀번호 단계에서는 닫기(비밀번호가 사라진다) */
  onCancel: () => void;
  /** 경고가 담아 둔 변경(기본 권한 등)을 장바구니에 담는다. 주지 않으면 경고의 [기본 권한도 담기]를 보이지 않는다 */
  onAddDefaults?: (changes: PgChange[]) => void;
}

/**
 * 변경 미리보기 창. 실행할 SQL, 권한 증감, 경고를 보여 주고, 막힘이면 적용을 끄며 확인 문구를 정확히 입력해야 적용할 수 있다.
 * ConfirmDialog와 같은 규칙: 처음 초점은 [취소], Esc는 취소, Enter로는 위험한 동작이 실행되지 않는다.
 * 새 비밀번호를 만든 변경은 적용 뒤 같은 창이 비밀번호 결과(PasswordResult)로 바뀐다.
 */
export function PgChangeDialog(props: Props) {
  // 미리보기를 새로 받으면(rev가 바뀌면) 창을 새로 열어서 입력해 둔 확인 문구를 버린다
  return <Sheet key={props.pending.rev} {...props} />;
}

function Sheet({ pending, onApply, onRetry, onCancel, onAddDefaults }: Props) {
  const { preview, phase, error, stale, undoOf, change, password } = pending;
  const applying = phase === "applying";
  const [typed, setTyped] = useState("");
  const { sheetRef, trapTab, cancelRef, retryRef } = useSheetFocus(phase, onCancel);

  // 요약은 미리보기에 있고, 받기 전에는 앱이 같은 글을 직접 만든다
  const summary = preview?.summary ?? changeSummary(change);

  if (phase === "password" && password !== null) {
    return (
      <div className="modal">
        <div className="sheet wide cp" role="dialog" aria-modal="true" aria-label="새 비밀번호" ref={sheetRef} onKeyDown={trapTab}>
          <PasswordResult password={password} summary={summary} onClose={onCancel} />
        </div>
      </div>
    );
  }

  const gate = preview ? applyGate(preview, typed) : null;
  const canApply = !!preview && gate?.ok === true && phase === "ready" && !stale;
  const needsRetry = (error?.kind === "preview" || stale) && !applying;
  const danger = !!preview && (!!preview.confirmText || preview.warnings.some((w) => w.level !== "block"));
  const title = undoOf ? "되돌리기 미리보기" : summary;
  const hint = gate && !gate.ok && gate.reason !== "text" ? GATE_HINT[gate.reason] : null;

  return (
    <div className="modal">
      <div className="sheet wide cp" role="dialog" aria-modal="true" aria-label={title} ref={sheetRef} onKeyDown={trapTab}>
        <div className="cp-body">
          <h3>{title}</h3>
          {preview && <p className="cp-user">{`적용할 DB 사용자: ${preview.loginUser}`}</p>}
          {/* 되돌리기의 제목은 "되돌리기 미리보기"라서, 무엇을 하는 변경인지는 따로 적는다 */}
          {undoOf && <p className="cp-sum">{summary}</p>}
          {phase === "loading" && <p>미리보기를 불러오는 중이에요…</p>}
          {preview && <PreviewBody preview={preview} onAddDefaults={onAddDefaults} />}
          {preview?.confirmText && <ConfirmField required={preview.confirmText} typed={typed} onTyped={setTyped} locked={applying} />}
        </div>
        {/* 오류는 스크롤되는 본문 밖, 버튼 바로 위에 둔다: 미리보기가 길어도 가려지지 않는다 */}
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
          <button className={`btn ${danger ? "danger" : "primary"}`} disabled={!canApply} onClick={() => onApply(typed)}>
            {applying ? "적용 중…" : "적용"}
          </button>
        </div>
      </div>
    </div>
  );
}
