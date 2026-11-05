import { useEffect, useRef, useState } from "react";
import { desktop } from "../api/desktop";
import { COPIED, COPY, COPY_FAILED } from "./text";

const FEEDBACK_MS = 1500;

/** 값을 클립보드로 복사하는 단추. 복사한 뒤 잠시 결과를 보인다. text가 함수면 누를 때 만든다(큰 값을 미리 만들지 않는다). */
export function CopyButton({ text, label = COPY, ariaLabel, className = "link" }: { text: string | (() => string); label?: string; ariaLabel?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    const value = typeof text === "function" ? text() : text;
    const finish = (next: "done" | "failed") => {
      setState(next);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setState("idle"), FEEDBACK_MS);
    };
    Promise.resolve(desktop.copy(value)).then(
      () => finish("done"),
      () => finish("failed"),
    );
  };
  return (
    <button type="button" className={className} aria-label={ariaLabel} onClick={copy}>
      {state === "done" ? COPIED : state === "failed" ? COPY_FAILED : label}
    </button>
  );
}
