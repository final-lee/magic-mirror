import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useLayoutEffect } from "react";

export type Theme = "system" | "light" | "dark";
const CACHE_KEY = "magic-mirror-theme";

function cachedTheme(): Theme {
  try {
    const value = localStorage.getItem(CACHE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

/** 설정이 준비되기 전에는 마지막으로 적용한 테마를 쓴다. */
export function initializeTheme() {
  applyTheme(cachedTheme())();
}

export function applyTheme(theme: Theme): () => void {
  const media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const apply = () => {
    const resolved = theme === "system" ? (media?.matches ? "dark" : "light") : theme;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
  };
  apply();
  if (theme === "system") media?.addEventListener?.("change", apply);
  try { localStorage.setItem(CACHE_KEY, theme); } catch { /* 저장소를 쓸 수 없어도 화면은 바뀐다. */ }
  if (isTauri()) void getCurrentWindow().setTheme(theme === "system" ? null : theme).catch(() => {});
  return () => media?.removeEventListener?.("change", apply);
}

export function useTheme(theme: Theme | undefined, loaded: boolean) {
  useLayoutEffect(() => {
    if (!loaded) return;
    return applyTheme(theme ?? "system");
  }, [theme, loaded]);
}
