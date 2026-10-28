import { memo, useState } from "react";
import { PreviewFooter } from "./PreviewFooter";
import { CallList, ConfirmField, ImpactList, ReversibleNote, useSheetFocus, WarningList } from "./previewParts";
import type { ChangePreview } from "./types";
import type { PendingChange } from "./useIamChange";

interface Props {
  pending: PendingChange;
  /** 적용을 누르면 입력한 확인 문구와 함께 부른다. 적용 가능 여부는 여기서도 훅에서도 따로 확인한다 */
  onApply: (typed: string) => void;
  onRetry: () => void;
  onCancel: () => void;
}

/**
 * 변경 미리보기 창. 호출할 API, 권한 증감, 경고를 보여 주고, 막힘이면 적용을 끄며 확인 문구를 정확히 입력해야 적용할 수 있다.
 * ConfirmDialog와 같은 규칙: 처음 초점은 [취소], Esc는 취소, Enter로는 위험한 동작이 실행되지 않는다.
 */
export function ChangePreviewDialog(props: Props) {
  // 미리보기를 새로 받으면(rev가 바뀌면) 창을 새로 열어서 입력해 둔 확인 문구를 버린다
  return <Sheet key={props.pending.rev} {...props} />;
}

function Sheet({ pending, onApply, onRetry, onCancel }: Props) {
  const { preview, phase, error, stale, undoOf } = pending;
  const applying = phase === "applying";
  const [typed, setTyped] = useState("");
  const { sheetRef, trapTab, cancelRef, retryRef } = useSheetFocus(phase, onCancel);

  const title = undoOf ? "되돌리기 미리보기" : "변경 미리보기";

  return (
    <div className="modal">
      <div className="sheet wide cp" role="dialog" aria-modal="true" aria-label={title} ref={sheetRef} onKeyDown={trapTab}>
        <div className="cp-body">
          <h3>{title}</h3>
          {phase === "loading" && <p>미리보기를 불러오는 중이에요…</p>}
          {preview && <PreviewDetails preview={preview} />}
          {preview?.confirmText && <ConfirmField required={preview.confirmText} typed={typed} onTyped={setTyped} locked={applying} />}
        </div>
        <PreviewFooter
          gated={preview}
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

/**
 * 미리보기 본문: 요약, 경고, 호출할 API, 영향받는 주체, 되돌릴 수 있는지.
 * 관리자 정책 같은 큰 변경은 영향 목록이 길어서, 확인 문구를 한 글자씩 입력할 때마다 다시 그리지 않도록 미리보기가 바뀔 때만 그린다.
 */
const PreviewDetails = memo(function PreviewDetails({ preview }: { preview: ChangePreview }) {
  return (
    <>
      <p className="cp-sum">{preview.summary}</p>

      <WarningList warnings={preview.warnings} />

      {preview.calls.length > 0 && (
        <>
          <h4>호출할 API</h4>
          <CallList calls={preview.calls} />
        </>
      )}

      <ImpactList impacts={preview.impacts} omitted={preview.impactsOmitted ?? 0} />

      <ReversibleNote reversible={preview.reversible} />
    </>
  );
});
