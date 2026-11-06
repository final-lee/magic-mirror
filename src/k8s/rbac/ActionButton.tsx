import type { ReactNode } from "react";

export type ActionTone = "primary" | "create" | "warn" | "danger" | "secondary" | "ghost";

interface Props {
  tone: ActionTone;
  /** 권한이 없거나 할 수 없는 이유. 있으면 버튼을 끄고 이유를 보인다(변경 버튼은 늘 보인다) */
  reason?: string;
  onClick: () => void;
  children: ReactNode;
}

/** 권한이 없으면 이유와 함께 꺼 두는 변경 버튼 */
export function ActionButton({ tone, reason, onClick, children }: Props) {
  return (
    <button className={`btn small tone-${tone}`} disabled={!!reason} title={reason} aria-description={reason} onClick={onClick}>
      {children}
    </button>
  );
}
