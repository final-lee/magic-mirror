import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { envOf } from "../argoEnv";
import { argoKeys } from "../queries";
import type { ArgoAppRow, ArgoWatchEvent, ArgocdServer } from "../types";
import { deliver } from "./deliver";
import { DEFAULT_NOTIFY, NotifyState, type Notice } from "./rules";

/** OutOfSync 지속을 살피는 간격 */
const TICK_MS = 30_000;

/**
 * 앱 스트림의 메시지(행 갱신·기록된 이벤트)를 알림 규칙에 먹여 macOS 알림을 낸다. 서버의 알림 설정이 켜져 있을 때만 일한다.
 * `listen`을 `useAppsWatch`의 listener로 넘기면 된다. 이 탭이 보이지 않아도 스트림이 열려 있는 동안 알린다.
 */
export function useArgoNotifier(server: ArgocdServer | null) {
  const qc = useQueryClient();
  const url = server?.url ?? "";
  const config = server?.notify ?? DEFAULT_NOTIFY;
  const state = useMemo(() => new NotifyState(), [url]);
  const latest = useRef({ config, name: server?.name ?? "" });
  latest.current = { config, name: server?.name ?? "" };

  const envFor = useCallback((namespace: string, name: string) => {
    const row = qc.getQueryData<ArgoAppRow[]>(argoKeys.apps(url))?.find((r) => r.namespace === namespace && r.name === name);
    return row ? envOf(row).env : "unknown";
  }, [qc, url]);

  const send = useCallback((notice: Notice) => {
    void deliver(latest.current.name, notice).catch((e: unknown) => console.error("알림을 보내지 못했어요", e));
  }, []);

  const listen = useCallback((event: ArgoWatchEvent<ArgoAppRow>) => {
    if (event.type === "upsert") state.row(event.row, Date.now());
    else if (event.type === "delete") state.remove(event.namespace, event.name);
    else if (event.type === "event") {
      const notice = state.event(event.event, latest.current.config, envFor);
      if (notice) send(notice);
    }
  }, [state, envFor, send]);

  useEffect(() => {
    if (!config.enabled) return;
    const timer = setInterval(() => {
      for (const notice of state.due(latest.current.config, Date.now(), envFor)) send(notice);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [config.enabled, state, envFor, send]);

  return { enabled: config.enabled, listen };
}
