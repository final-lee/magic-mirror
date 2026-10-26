import { useEffect } from "react";
import { desktop } from "../api/desktop";

export function useCopyShortcut(value: string | null) {
  useEffect(() => {
    if (!value) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey || e.key !== "c") return;
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (window.getSelection()?.toString() || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      e.preventDefault();
      void desktop.copy(value);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [value]);
}
