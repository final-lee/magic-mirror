import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { errorMessage } from "../api/errors";
import { onSsoExpired } from "../api/invoke";
import type { ProfileInfo } from "../api/types";

/**
 * 로그인 하나의 상태. 성공하면 목록에서 빠진다(= 대기).
 * afterSuccess는 로그인에 성공한 직후 또 만료를 알려서 생긴 실패에만 붙는다. 로그인 자체가 실패한 것이 아니라 프로필 설정 문제라서 배너가 다른 문구를 쓴다.
 */
export type SsoStatus = { kind: "running" } | { kind: "failed"; message: string; afterSuccess?: true } | { kind: "cancelled" };

export interface SsoEntry {
  key: string;
  /** 로그인을 연 프로필(배너에 보여줄 이름) */
  profile: string;
  /** aws sso login에 넘긴 프로필 */
  target: string;
  status: SsoStatus;
}

/** 로그인에 성공한 뒤 이 시간 안에 같은 세션이 또 만료를 알리면 프로필 설정 문제로 보고 자동으로 다시 열지 않는다. */
const RELOGIN_COOLDOWN_MS = 5 * 60_000;
const STILL_NO_CREDENTIALS = "로그인했는데도 자격 증명을 받지 못했어요. 프로필 설정을 확인해 주세요";

/** 프로필별 데이터를 담은 쿼리 키의 첫 요소. 이 키들은 두 번째 요소가 프로필 이름이다. */
const PROFILE_SCOPED_ROOTS = new Set(["account", "resources", "s3", "diff", "vpc-topology", "iam"]);

/** 프로필의 로그인 키와 대상. SSO 설정이 없으면 그 프로필 자신이고 자동 로그인은 하지 않는다(백엔드와 같은 규칙). */
export function loginPlan(profiles: ProfileInfo[] | undefined, profile: string) {
  const info = profiles?.find((p) => p.name === profile);
  if (info?.ssoKey && info.ssoLogin) return { key: info.ssoKey, target: info.ssoLogin, auto: true };
  return { key: `profile:${profile}`, target: profile, auto: false };
}

/**
 * SSO 로그인 관리자. 명령이 SSO 만료로 실패하면 지금 보고 있는 프로필의 세션에 로그인을 한 번 연다.
 * - 실패하거나 취소한 세션은 사용자가 그 프로필을 다시 고르거나 직접 누를 때까지 자동으로 다시 열지 않는다.
 * - 로그인에 성공한 직후(5분 안)에 시작한 호출이 또 만료로 실패하면 프로필 설정 문제로 보고 실패 줄만 띄운다(afterSuccess).
 *   성공하기 전에 시작한 호출의 늦은 보고는 무시한다.
 * - 성공하면 그 세션 프로필의 쿼리 중 돌고 있던 것은 취소한 뒤 무효화한다. 켜진 쿼리는 로그인 뒤에 새로 시작하고,
 *   누를 때만 도는 쿼리(enabled: false)는 다시 불리지 않으므로 그 쿼리의 ErrorState가 onLoggedIn으로 자기 쿼리만 다시 부른다.
 * - 지금 보고 있는 프로필의 세션이 아닌 보고는 자동으로 처리하지 않는다. 직접 누른 시작은 언제나 한다.
 */
export function useSsoLogin(profiles: ProfileInfo[] | undefined, currentProfile: string | null) {
  const qc = useQueryClient();
  const [entries, setEntries] = useState<Record<string, SsoEntry>>({});
  // 세션마다 마지막으로 로그인에 성공한 시각. 화면(ErrorState)이 이 값이 바뀌는 것을 보고 onLoggedIn을 부른다.
  const [successes, setSuccesses] = useState<Record<string, number>>({});
  // 알림 처리(동기)에서 최신 값을 보려고 ref에도 둔다
  const entriesRef = useRef(entries);
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;
  const currentRef = useRef(currentProfile);
  currentRef.current = currentProfile;
  const flights = useRef(new Map<string, Promise<boolean>>());
  const cancelled = useRef(new Set<string>());
  /** 키마다 마지막으로 로그인에 성공한 시각. 다시 고르기로 지우지 않는다. */
  const lastSuccess = useRef(new Map<string, number>());

  const write = useCallback((next: (prev: Record<string, SsoEntry>) => Record<string, SsoEntry>) => {
    entriesRef.current = next(entriesRef.current);
    setEntries(entriesRef.current);
  }, []);

  /**
   * 자동 시작(manual: false)은 알린 명령이 시작된 시각 startedAt(모르면 지금)을 함께 받는다.
   * 직접 누른 시작(manual: true)은 어떤 프로필이든, 성공 직후든 언제나 로그인한다.
   */
  const start = useCallback(
    (profile: string, opts: { manual: boolean; startedAt?: number }): Promise<boolean> => {
      const plan = loginPlan(profilesRef.current, profile);
      const running = flights.current.get(plan.key);
      if (running) return running;
      const entry = (status: SsoStatus): SsoEntry => ({ key: plan.key, profile, target: plan.target, status });
      if (!opts.manual) {
        if (!plan.auto || entriesRef.current[plan.key]) return Promise.resolve(false);
        // 지금 보고 있는 프로필의 세션만 자동으로 연다(방금 떠난 프로필의 늦은 보고는 무시)
        const current = currentRef.current;
        if (current === null || loginPlan(profilesRef.current, current).key !== plan.key) return Promise.resolve(false);
        const lastOk = lastSuccess.current.get(plan.key);
        if (lastOk !== undefined) {
          // 로그인이 끝나기 전에 시작한 호출의 늦은 보고: 새 로그인으로 이미 해결됐을 수 있다
          if ((opts.startedAt ?? Date.now()) < lastOk) return Promise.resolve(false);
          // 로그인한 직후 시작한 호출이 또 만료로 실패하면 브라우저를 또 띄워도 소용없다
          if (Date.now() - lastOk < RELOGIN_COOLDOWN_MS) {
            write((prev) => ({ ...prev, [plan.key]: entry({ kind: "failed", message: STILL_NO_CREDENTIALS, afterSuccess: true }) }));
            return Promise.resolve(false);
          }
        }
      }
      cancelled.current.delete(plan.key);
      write((prev) => ({ ...prev, [plan.key]: entry({ kind: "running" }) }));
      const flight = api
        .ssoLogin(plan.target)
        .then(
          async () => {
            const at = Date.now();
            lastSuccess.current.set(plan.key, at);
            setSuccesses((prev) => ({ ...prev, [plan.key]: at }));
            write(({ [plan.key]: _done, ...rest }) => rest);
            const affected = new Set(
              (profilesRef.current ?? []).filter((p) => loginPlan(profilesRef.current, p.name).key === plan.key).map((p) => p.name),
            );
            affected.add(profile);
            const filters = {
              predicate: (q: { queryKey: readonly unknown[] }) =>
                PROFILE_SCOPED_ROOTS.has(String(q.queryKey[0])) && typeof q.queryKey[1] === "string" && affected.has(q.queryKey[1]),
            };
            // 데이터가 아직 없는 쿼리의 첫 조회가 이 순간에도 돌고 있으면, 무효화는 새로 부르지 않고 그 조회를 그대로 이어 간다.
            // 그 조회는 만료된 세션으로 시작했으니 곧 만료 오류로 끝나 화면에 남는다. 먼저 취소해서 로그인 뒤에 새로 시작하게 한다.
            // 취소된 조회의 늦은 결과는 TanStack이 버리고, 그 만료 보고는 낡은 것이라 위에서 무시한다.
            // 무효화가 다시 시작하는 것은 켜진(active) 쿼리뿐이라 취소도 그 쿼리만 한다. 누를 때만 도는 쿼리(enabled: false)의
            // 조회를 취소하면 아무도 다시 시작하지 않아, 10~30초 걸리던 조회가 사라지고 버튼만 남는다.
            await qc.cancelQueries({ ...filters, type: "active" });
            void qc.invalidateQueries(filters);
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

  /** 사용자가 프로필을 직접 고르면 그 세션의 실패·취소 기록을 지워 자동 로그인을 다시 켠다. 마지막 로그인 시각(5분 창)은 그대로 둔다. */
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

  useEffect(() => onSsoExpired((profile, startedAt) => void start(profile, { manual: false, startedAt })), [start]);

  return useMemo(
    () => ({
      entries: Object.values(entries),
      statusFor: (profile: string): SsoStatus | null => entries[loginPlan(profiles, profile).key]?.status ?? null,
      /** 이 프로필의 세션이 마지막으로 로그인에 성공한 시각(ms). 아직 없으면 null */
      lastSuccessAt: (profile: string): number | null => successes[loginPlan(profiles, profile).key] ?? null,
      start,
      cancel,
      dismiss,
      rearm,
    }),
    [entries, successes, profiles, start, cancel, dismiss, rearm],
  );
}

export type SsoLogin = ReturnType<typeof useSsoLogin>;

export const SsoLoginContext = createContext<SsoLogin | null>(null);

/** 앱 안에서는 로그인 관리자를, 단독으로 그린 컴포넌트(테스트 등)에서는 null을 준다. */
export const useSsoLoginContext = () => useContext(SsoLoginContext);
