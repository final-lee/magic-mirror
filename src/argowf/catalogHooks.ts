import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../api/errors";
import { argowfKeys, isTokenError } from "./queries";
import type { ArgoWfConn } from "./types";

/** 토큰 문제는 목록·상세가 아니라 서버 단위의 일이라 토큰 폼으로 돌려보낸다(ArgoView와 같다) */
export function useTokenGate(errors: unknown[], onTokenError: (message: string) => void) {
  const latest = useRef(onTokenError);
  latest.current = onTokenError;
  useEffect(() => {
    const bad = errors.find(isTokenError);
    if (bad) latest.current(errorMessage(bad));
    // errors는 호출마다 새 배열이라 안의 값으로 본다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, errors);
}

/**
 * 조작 하나를 돌린다: 끝나면 "…했어요"를 3초 보이고 서버의 모든 데이터를 다시 읽게 한다(기다리지 않는다).
 * 실패하면 서버 메시지를 error에 두고 null을 돌려준다. 토큰 문제면 토큰 폼으로도 알린다.
 */
export function useCatalogAction(conn: ArgoWfConn, onTokenError: (message: string) => void) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 3000);
    return () => clearTimeout(t);
  }, [note]);

  const run = async <T>(action: () => Promise<T>, done: string): Promise<{ value: T } | null> => {
    setBusy(true);
    setError(null);
    try {
      const value = await action();
      setNote(done);
      void qc.invalidateQueries({ queryKey: argowfKeys.data(conn.url) });
      return { value };
    } catch (e) {
      if (isTokenError(e)) onTokenError(errorMessage(e));
      setError(errorMessage(e));
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, note, run, clearError: () => setError(null) };
}
