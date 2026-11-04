import type { ReactNode } from "react";

/** 버튼 색: primary(파랑) 실행·미리보기, warn(노랑) 주의 조작, danger(빨강) 지우기, secondary(회색) 보조, ghost(투명) 취소 */
export type ActionTone = "primary" | "warn" | "danger" | "secondary" | "ghost";

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
