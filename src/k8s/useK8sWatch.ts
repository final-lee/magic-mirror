import { useEffect, useMemo, useState } from "react";
import type { AppError } from "../api/types";
import { k8sApi } from "./api";
import { targetKey } from "./targets";
import type { K8sKindRef, K8sRow, K8sTarget } from "./types";
import { watchRegistry, type WatchSnapshot } from "./watchRegistry";

const LOADING: WatchSnapshot = { rows: [], status: "loading", error: null };

const byNameThenNamespace = (a: K8sRow, b: K8sRow) =>
  a.name.localeCompare(b.name) || (a.namespace ?? "").localeCompare(b.namespace ?? "");

/**
 * 한 종류의 목록을 감시한다. 같은 대상·context·종류·네임스페이스의 호출은 감시 하나를 나눠 쓴다.
 * 구독은 세션의 수명을 따른다: 호출한 쪽은 enabled = session.isSuccess && !session.isFetching 을 넘기고,
 * sessionEpoch에 세션이 열린 시각(session.dataUpdatedAt)을 넘긴다. 다시 연결해 세션이 새로 열리면 값이 바뀌어 새로 구독한다.
 * dropTarget은 구독자를 비우기만 하고 스스로 다시 구독하게 하지 않는다.
 */
export function useK8sWatch(
  target: K8sTarget,
  context: string,
  sessionEpoch: number,
  ssoProfile: string,
  kind: K8sKindRef,
  namespace: string | null,
  enabled: boolean,
): { rows: K8sRow[]; status: "loading" | "ready" | "error"; error: AppError | null } {
  const tk = targetKey(target);
  const key = `${tk}|${context}|${kind.group}/${kind.version}/${kind.plural}|${namespace ?? "*"}`;
  const [snap, setSnap] = useState<WatchSnapshot>(LOADING);

  useEffect(() => {
    if (!enabled) {
      setSnap(LOADING);
      return;
    }
    return watchRegistry.subscribe(key, (onMessage) => k8sApi.watch(target, kind, namespace, ssoProfile, onMessage), setSnap, ssoProfile);
    // key가 target·context·kind·namespace를 모두 담는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, ssoProfile, sessionEpoch]);

  const rows = useMemo(() => [...snap.rows].sort(byNameThenNamespace), [snap.rows]);
  return { rows, status: snap.status, error: snap.error };
}
