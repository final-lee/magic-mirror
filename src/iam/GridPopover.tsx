import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

const POP_W = 300;
/** 창이 화면 가장자리에서 떨어져야 하는 간격 */
const EDGE = 8;

interface Props {
  role: "dialog" | "menu";
  label: string;
  /** 이 창을 연 버튼(칸이나 ⋯). 창은 이 버튼 아래에 뜨고, 아래가 모자라면 위에 뜬다 */
  trigger: HTMLElement;
  onClose: () => void;
  children: ReactNode;
}

/**
 * 표 위에 떠 있는 작은 창(받은 곳 안내, 행 메뉴).
 * 열리면 안으로 초점을 준다. 바깥을 누르거나 초점이 바깥으로 가면 닫고, Esc는 초점을 버튼으로 돌려 놓고 닫는다.
 * 이 창을 연 버튼은 바깥이 아니다. 버튼을 한 번 더 누르면 누르는 순간 초점이 창에서 버튼으로 옮겨 오는데,
 * 이때 닫아 버리면 이어서 오는 click이 창을 다시 연다. 닫는 일은 그 click의 몫이다.
 */
export function GridPopover({ role, label, trigger, onClose, children }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);

  // 자리는 버튼 아래. 창 아래로 넘치면(맨 아래 행) 버튼 위로 올린다. 크기를 재야 해서 그린 직후, 화면에 나가기 전에 한다
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const anchor = trigger.getBoundingClientRect();
    box.style.left = `${Math.min(anchor.left, Math.max(EDGE, window.innerWidth - POP_W - EDGE))}px`;
    box.style.top = `${anchor.bottom + 4}px`;
    const size = box.getBoundingClientRect();
    if (size.bottom > window.innerHeight - EDGE) box.style.top = `${Math.max(EDGE, anchor.top - size.height - 4)}px`;
  }, [trigger]);

  // 열리면 안으로 초점을 준다: 누를 수 있는 첫 버튼, 없으면 창 자체
  useEffect(() => {
    const box = boxRef.current;
    (box?.querySelector<HTMLElement>("button:not(:disabled)") ?? box)?.focus();
  }, []);

  useEffect(() => {
    const inside = (target: EventTarget | null) => {
      const node = target as Node | null;
      return !!node && (!!boxRef.current?.contains(node) || trigger.contains(node));
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!inside(e.target)) onClose();
    };
    // 초점이 창이나 버튼을 떠나 둘 밖으로, 또는 아무 데도 아닌 곳으로 가면 닫는다.
    // 창에서 버튼으로 가는 것은 닫지 않는다. 버튼에서 다시 다른 곳으로 가는 것(Shift+Tab 두 번)도 여기서 잡힌다
    const onFocusOut = (e: FocusEvent) => {
      if (inside(e.target) && !inside(e.relatedTarget)) onClose();
    };
    // 초점이 버튼에 있을 때의 Esc: 초점은 그대로 두고 닫는다
    const onTriggerKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusout", onFocusOut);
    trigger.addEventListener("keydown", onTriggerKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusout", onFocusOut);
      trigger.removeEventListener("keydown", onTriggerKey);
    };
  }, [trigger, onClose]);

  return (
    <div
      ref={boxRef}
      className="asg-pop"
      role={role}
      aria-label={label}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        if (trigger.isConnected) trigger.focus();
        onClose();
      }}
    >
      {children}
    </div>
  );
}
