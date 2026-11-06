import { useEffect, useRef, type ReactNode } from "react";
import { useModal } from "../iam/useModal";
import * as t from "./editText";

interface Props {
  title: string;
  children: ReactNode;
  /** [미리 보기…]: 입력으로 변경 대화창(SnsChangeDialog)을 연다. 아무것도 바꾸지 않는다 */
  onPreview: () => void;
  onClose: () => void;
  /** 이유가 있으면 [미리 보기…]가 꺼지고 이유가 title에 나온다 */
  blocked: string | null;
  tone?: string;
}

/**
 * 변경을 정하는 입력 창의 틀. ConfirmDialog와 같은 규칙: 처음 초점은 [취소], Esc는 취소, Tab은 창 안을 돈다.
 * 마지막 단추 [미리 보기…]는 보내는 일의 입구라 파랑(실행, `tone-primary`)이고, 실제 쓰기는 그 뒤의 변경 대화창이 한다.
 */
export function FormSheet({ title, children, onPreview, onClose, blocked, tone = "tone-primary" }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { sheetRef, trapTab } = useModal(onClose);
  useEffect(() => cancelRef.current?.focus(), []);
  return (
    <div className="modal">
      <div className="sheet wide sns-form" role="dialog" aria-modal="true" aria-label={title} ref={sheetRef} onKeyDown={trapTab}>
        <h3>{title}</h3>
        <div className="sns-form-body">{children}</div>
        <div className="foot">
          {blocked && <span className="cp-hint">{blocked}</span>}
          <button ref={cancelRef} className="btn plain tone-ghost" onClick={onClose}>
            {t.CANCEL}
          </button>
          <button className={`btn plain ${tone}`} disabled={blocked !== null} title={blocked ?? undefined} aria-description={blocked ?? undefined} onClick={onPreview}>
            {t.PREVIEW}
          </button>
        </div>
      </div>
    </div>
  );
}
