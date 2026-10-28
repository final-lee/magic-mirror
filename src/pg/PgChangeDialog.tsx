import { useState } from "react";
import { PreviewFooter } from "../iam/PreviewFooter";
import { ConfirmField, useSheetFocus } from "../iam/previewParts";
import { changeSummary } from "./changeText";
import { confirmLabel } from "./labels";
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
 * 새 비밀번호를 만든 변경은 적용 뒤 같은 창이 비밀번호 결과(PasswordResult)로 바뀐다. 그 창은 Esc로 닫히지 않는다: 비밀번호는 한 번만 보여 줄 수
 * 있어서, 키를 잘못 눌러 잃지 않도록 버리는 길을 [닫기] 하나로 둔다.
 */
export function PgChangeDialog(props: Props) {
  // 미리보기를 새로 받으면(rev가 바뀌면) 창을 새로 열어서 입력해 둔 확인 문구를 버린다
  return <Sheet key={props.pending.rev} {...props} />;
}

const ignore = () => {};

function Sheet({ pending, onApply, onRetry, onCancel, onAddDefaults }: Props) {
  const { preview, phase, error, stale, undoOf, change, password } = pending;
  const applying = phase === "applying";
  const [typed, setTyped] = useState("");
  const { sheetRef, trapTab, cancelRef, retryRef } = useSheetFocus(phase, phase === "password" ? ignore : onCancel);

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

  const title = undoOf ? "되돌리기 미리보기" : summary;

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
          {preview?.confirmText && (
            <ConfirmField required={preview.confirmText} typed={typed} onTyped={setTyped} locked={applying} label={confirmLabel(preview.confirmText)} />
          )}
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
