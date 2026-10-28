import { useState } from "react";
import { PreviewFooter } from "../iam/PreviewFooter";
import { ConfirmField, useSheetFocus } from "../iam/previewParts";
import { batchSummary } from "./changeText";
import { confirmLabel } from "./labels";
import { PreviewBody } from "./PreviewBody";
import type { PgChange } from "./types";
import { pgBatchGated, type PendingPgBatch } from "./usePgBatch";

interface Props {
  pending: PendingPgBatch;
  /** 적용을 누르면 입력한 확인 문구와 함께 부른다. 적용 가능 여부는 여기서도 훅에서도 따로 확인한다 */
  onApply: (typed: string) => void;
  onRetry: () => void;
  onCancel: () => void;
  /** 경고가 담아 둔 변경(기본 권한 등)을 장바구니에 담는다. 주지 않으면 경고의 [기본 권한도 담기]를 보이지 않는다 */
  onAddDefaults?: (changes: PgChange[]) => void;
}

/**
 * 묶음 미리보기 창. 적용 순서대로 변경마다 요약과 경고를 보여 주고, 묶음 전체의 실행할 SQL과 권한 증감을 함께 보여 준다.
 * PgChangeDialog와 같은 규칙: 처음 초점은 [취소], Esc는 취소, Enter로는 위험한 동작이 실행되지 않고, 막힘이면 적용을 끄며
 * 확인 문구를 정확히 입력해야 적용할 수 있다. 묶음은 한 트랜잭션이라 중간에 멈춘 결과 화면은 없다.
 */
export function PgBatchDialog(props: Props) {
  // 미리보기를 새로 받으면(rev가 바뀌면) 창을 새로 열어서 입력해 둔 확인 문구를 버린다
  return <Sheet key={props.pending.rev} {...props} />;
}

function Sheet({ pending, onApply, onRetry, onCancel, onAddDefaults }: Props) {
  const { preview, phase, error, stale, undoOf } = pending;
  const applying = phase === "applying";
  const [typed, setTyped] = useState("");
  const { sheetRef, trapTab, cancelRef, retryRef } = useSheetFocus(phase, onCancel);

  const count = preview?.items.length ?? pending.changes.length;
  const title = undoOf ? "되돌리기 미리보기" : batchSummary(count);

  return (
    <div className="modal">
      <div className="sheet wide cp" role="dialog" aria-modal="true" aria-label={title} ref={sheetRef} onKeyDown={trapTab}>
        <div className="cp-body">
          <h3>{title}</h3>
          {preview && <p className="cp-user">{`적용할 DB 사용자: ${preview.loginUser}`}</p>}
          {phase === "loading" && <p>미리보기를 불러오는 중이에요…</p>}
          {preview && <PreviewBody preview={preview} items={preview.items} onAddDefaults={onAddDefaults} />}
          {preview?.confirmText && (
            <ConfirmField
              required={preview.confirmText}
              typed={typed}
              onTyped={setTyped}
              locked={applying}
              label={confirmLabel(preview.confirmText)}
              mismatchHint="입력한 문구가 달라요"
            />
          )}
        </div>
        <PreviewFooter
          gated={preview && pgBatchGated(preview)}
          phase={phase}
          error={error}
          stale={stale}
          typed={typed}
          cancelRef={cancelRef}
          retryRef={retryRef}
          onApply={onApply}
          onRetry={onRetry}
          onCancel={onCancel}
        />
      </div>
    </div>
  );
}
