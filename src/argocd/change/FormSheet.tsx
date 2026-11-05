import { useEffect, type ReactNode } from "react";
import { useModal } from "../../iam/useModal";
import { CHANGE_CANCEL } from "./text";

interface Props {
  label: string;
  /** 넓은 시트(diff·목록이 있는 폼) */
  wide?: boolean;
  onCancel: () => void;
  submit: { label: string; disabled?: boolean; title?: string; onClick: () => void };
  children: ReactNode;
}

/** 변경 전에 옵션을 고르는 폼의 공통 틀: 제목, 본문, 취소·진행 버튼. 진행하면 호출한 쪽이 ChangeSheet로 미리 본다. */
export function FormSheet({ label, wide, onCancel, submit, children }: Props) {
  const { sheetRef, trapTab } = useModal(onCancel);
  useEffect(() => {
    sheetRef.current?.focus();
  }, [sheetRef]);
  return (
    <div
      className="modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className={wide ? "sheet wide" : "sheet"} role="dialog" aria-modal="true" aria-label={label} ref={sheetRef} tabIndex={-1} onKeyDown={trapTab}>
        <h3>{label}</h3>
        {children}
        <div className="foot">
          <button className="btn plain tone-ghost" onClick={onCancel}>
            {CHANGE_CANCEL}
          </button>
          <button className="btn plain tone-primary" disabled={submit.disabled} title={submit.title} onClick={submit.onClick}>
            {submit.label}
          </button>
        </div>
      </div>
    </div>
  );
}
