import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { errorMessage } from "../api/errors";
import { onSsoExpired } from "../api/invoke";
import type { ProfileInfo } from "../api/types";

/** 로그인 하나의 상태. 성공하면 목록에서 빠진다(= 대기). */
export type SsoStatus = { kind: "running" } | { kind: "failed"; message: string } | { kind: "cancelled" };

export interface SsoEntry {
  key: string;
  /** 로그인을 연 프로필(배너에 보여줄 이름) */
  profile: string;
  /** aws sso login에 넘긴 프로필 */
  target: string;
  status: SsoStatus;
}

/** 프로필의 로그인 키와 대상. SSO 설정이 없으면 그 프로필 자신이고 자동 로그인은 하지 않는다(백엔드와 같은 규칙). */
export function loginPlan(profiles: ProfileInfo[] | undefined, profile: string) {
  const info = profiles?.find((p) => p.name === profile);
  if (info?.ssoKey && info.ssoLogin) return { key: info.ssoKey, target: info.ssoLogin, auto: true };
  return { key: `profile:${profile}`, target: profile, auto: false };
}

/**
 * SSO 로그인 관리자. 명령이 SSO 만료로 실패하면 그 프로필의 세션에 로그인을 한 번 연다.
 * 실패하거나 취소한 세션은 사용자가 그 프로필을 다시 고르거나 직접 누를 때까지 자동으로 다시 열지 않는다.
 */
export function useSsoLogin(profiles: ProfileInfo[] | undefined) {
  const qc = useQueryClient();
  const [entries, setEntries] = useState<Record<string, SsoEntry>>({});
  // 알림 처리(동기)에서 최신 값을 보려고 ref에도 둔다
  const entriesRef = useRef(entries);
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;
  const flights = useRef(new Map<string, Promise<boolean>>());
  const cancelled = useRef(new Set<string>());

  const write = useCallback((next: (prev: Record<string, SsoEntry>) => Record<string, SsoEntry>) => {
    entriesRef.current = next(entriesRef.current);
    setEntries(entriesRef.current);
  }, []);

  const start = useCallback(
    (profile: string, opts: { manual: boolean }): Promise<boolean> => {
      const plan = loginPlan(profilesRef.current, profile);
      const running = flights.current.get(plan.key);
      if (running) return running;
      if (!opts.manual && (!plan.auto || entriesRef.current[plan.key])) return Promise.resolve(false);
      cancelled.current.delete(plan.key);
      const entry = (status: SsoStatus): SsoEntry => ({ key: plan.key, profile, target: plan.target, status });
      write((prev) => ({ ...prev, [plan.key]: entry({ kind: "running" }) }));
      const flight = api
        .ssoLogin(plan.target)
        .then(
          () => {
            write(({ [plan.key]: _done, ...rest }) => rest);
            const affected = new Set(
              (profilesRef.current ?? []).filter((p) => loginPlan(profilesRef.current, p.name).key === plan.key).map((p) => p.name),
            );
            affected.add(profile);
            void qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[1] === "string" && affected.has(q.queryKey[1]) });
            return true;
          },
          (e: unknown) => {
            const status: SsoStatus = cancelled.current.has(plan.key) ? { kind: "cancelled" } : { kind: "failed", message: errorMessage(e) };
            write((prev) => ({ ...prev, [plan.key]: entry(status) }));
            return false;
          },
        )
        .finally(() => flights.current.delete(plan.key));
      flights.current.set(plan.key, flight);
      return flight;
    },
    [qc, write],
  );

  const cancel = useCallback((key: string) => {
    const entry = entriesRef.current[key];
    if (entry?.status.kind !== "running") return;
    cancelled.current.add(key);
    void api.ssoLoginCancel(entry.target).catch(() => {});
  }, []);

  /** 실패 배너를 닫는다. 닫은 세션은 취소한 것처럼 자동으로 다시 열지 않는다. */
  const dismiss = useCallback(
    (key: string) => {
      write((prev) => (prev[key]?.status.kind === "failed" ? { ...prev, [key]: { ...prev[key], status: { kind: "cancelled" } } } : prev));
    },
    [write],
  );

  /** 사용자가 프로필을 직접 고르면 그 세션의 실패·취소 기록을 지워 자동 로그인을 다시 켠다. */
  const rearm = useCallback(
    (profile: string) => {
      const { key } = loginPlan(profilesRef.current, profile);
      write((prev) => {
        if (!prev[key] || prev[key].status.kind === "running") return prev;
        const { [key]: _old, ...rest } = prev;
        return rest;
      });
    },
    [write],
  );

  useEffect(() => onSsoExpired((profile) => void start(profile, { manual: false })), [start]);

  return useMemo(
    () => ({
      entries: Object.values(entries),
      statusFor: (profile: string): SsoStatus | null => entries[loginPlan(profiles, profile).key]?.status ?? null,
      start,
      cancel,
      dismiss,
      rearm,
    }),
    [entries, profiles, start, cancel, dismiss, rearm],
  );
}

export type SsoLogin = ReturnType<typeof useSsoLogin>;

export const SsoLoginContext = createContext<SsoLogin | null>(null);

/** 앱 안에서는 로그인 관리자를, 단독으로 그린 컴포넌트(테스트 등)에서는 null을 준다. */
export const useSsoLoginContext = () => useContext(SsoLoginContext);
