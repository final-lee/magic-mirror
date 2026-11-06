import { useEffect, useRef, useState, type ReactNode } from "react";
import { useModal } from "../iam/useModal";

interface Props {
  title: string;
  /** 무엇을 하는지, 되돌릴 수 있는지 */
  note: string;
  confirmLabel: string;
  /** 빨간 버튼(삭제·Terminate) */
  danger?: boolean;
  tone?: string;
  /** 이 글을 그대로 쳐야 [적용]이 켜진다(이름·네임스페이스에 prod가 들어간 대상). 없으면 null */
  requireName?: string | null;
  busy?: boolean;
  /** 서버가 돌려준 실패 메시지. 있으면 확인 버튼이 "다시 시도"가 된다 */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  /** 대상 정보와 옵션(체크박스, 파라미터 폼) */
  children?: ReactNode;
}

export const ACTION_CANCEL = "취소";
export const ACTION_RETRY = "다시 시도";
export const typeNameHint = (name: string) => `확인하려면 ${name}을(를) 입력하세요`;

/** 이름이나 네임스페이스에 prod가 들어가면 위험한 대상으로 본다(k8s 변경과 같은 규칙) */
export const needsTypedName = (...parts: (string | null | undefined)[]) => parts.some((p) => p?.toLowerCase().includes("prod"));

/**
 * Argo Workflows 조작 확인 창. Esc·바깥 누르기·[취소]로 닫고, 처음 초점은 [취소]다(Enter로 바로 적용되지 않는다).
 * requireName이 있으면 그 글을 그대로 쳐야 확인 버튼이 켜진다.
 */
export function ActionDialog({
  title,
  note,
  confirmLabel,
  danger = false,
  tone,
  requireName = null,
  busy = false,
  error = null,
  onConfirm,
  onCancel,
  children,
}: Props) {
  const [typed, setTyped] = useState("");
  const { sheetRef, trapTab } = useModal(onCancel);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);
  const blocked = busy || (requireName !== null && typed !== requireName);
  return (
    <div
      className="modal"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} ref={sheetRef} onKeyDown={trapTab}>
        <h3>{title}</h3>
        <p>{note}</p>
        {children}
        {requireName !== null && (
          <input
            className="field-input mono"
            aria-label={typeNameHint(requireName)}
            placeholder={typeNameHint(requireName)}
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        )}
        {error && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
        <div className="foot">
          <button ref={cancelRef} className="btn plain tone-ghost" onClick={onCancel} disabled={busy}>
            {ACTION_CANCEL}
          </button>
          <button className={`btn plain ${tone ?? (danger ? "tone-danger" : "tone-primary")}`} disabled={blocked} onClick={onConfirm}>
            {error ? ACTION_RETRY : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
