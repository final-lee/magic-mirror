import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { argowfApi } from "./api";
import { argowfKeys } from "./queries";
import type { ArgoWfConn } from "./types";
import { emptyQuery } from "./wfQuery";

/** 목록을 다시 읽는 간격: 네임스페이스는 자주 바뀌지 않는다 */
const NAMESPACES_STALE_MS = 5 * 60_000;
export const NS_ALL = "모든 네임스페이스";
export const NS_UNKNOWN = "Argo 자원이 있는 네임스페이스를 찾지 못했어요. 쓸 네임스페이스 이름을 넣어 주세요";
export const NS_TYPE = "직접 넣기…";

/**
 * Argo 자원이 있는 네임스페이스 중에서 고른다. Argo의 네임스페이스는 쿠버네티스 네임스페이스 그 자체지만 대부분에는 Argo 자원이
 * 없으니, Argo가 보여 주는 Workflow·Cron·템플릿·Event Binding이 있는 네임스페이스만 목록에 둔다.
 * 하나도 찾지 못하면(아직 아무것도 없는 클러스터, 한 네임스페이스만 볼 수 있는 토큰 등) 이름을 직접 넣는다 — 그러지 않으면 고를 길이 없다.
 * 서버가 managedNamespace로 정해 두면 잠긴다.
 */
export function NamespaceBox({
  conn,
  value,
  lockedBy,
  onCommit,
}: {
  conn: ArgoWfConn;
  value: string | null;
  lockedBy: string | null;
  onCommit(namespace: string | null): void;
}) {
  const locked = lockedBy !== null;
  // 모든 네임스페이스 목록을 읽어 네임스페이스를 모은다(하나라도 읽히면 그것으로)
  const seen = useQuery({
    queryKey: [...argowfKeys.data(conn.url), "namespaces-seen"],
    enabled: !locked,
    staleTime: NAMESPACES_STALE_MS,
    retry: false,
    queryFn: async () => {
      const results = await Promise.allSettled([
        argowfApi.workflows(conn, { ...emptyQuery(null), limit: 500 }).then((p) => p.rows.map((r) => r.namespace)),
        argowfApi.crons(conn, null).then((rows) => rows.map((r) => r.namespace)),
        argowfApi.templates(conn, null).then((rows) => rows.flatMap((r) => (r.namespace ? [r.namespace] : []))),
        argowfApi.eventBindings(conn, null).then((rows) => rows.map((r) => r.namespace)),
      ]);
      return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    },
  });
  const found = [...new Set(seen.data ?? [])].filter(Boolean);
  const loading = !locked && seen.isPending;
  const unknown = !locked && !loading && found.length === 0;
  // 지금 고른 것이 목록에 없어도(직접 넣었거나 자원이 지워졌으면) 그대로 보인다
  const names = [...new Set([...found, ...(value ? [value] : [])])].sort((a, b) => a.localeCompare(b));
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");

  if (locked) {
    return (
      <label className="argowf-ns" title={`서버가 ${lockedBy} 네임스페이스로 정해 두었어요`}>
        네임스페이스{" "}
        <select aria-label="네임스페이스" value={lockedBy} disabled>
          <option value={lockedBy}>{lockedBy}</option>
        </select>
        <span aria-hidden="true"> 🔒</span>
      </label>
    );
  }

  if (typing) {
    const commit = () => {
      setTyping(false);
      const next = draft.trim() || null;
      if (next !== value) onCommit(next);
    };
    return (
      <label className="argowf-ns" title={NS_UNKNOWN}>
        네임스페이스{" "}
        <input
          aria-label="네임스페이스 이름"
          autoFocus
          spellCheck={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setTyping(false);
          }}
        />
      </label>
    );
  }

  return (
    <label className="argowf-ns" title={unknown ? NS_UNKNOWN : undefined}>
      네임스페이스{" "}
      <select
        aria-label="네임스페이스"
        value={value ?? ""}
        disabled={loading}
        onChange={(e) => {
          if (e.target.value === "\u0000type") {
            setDraft(value ?? "");
            setTyping(true);
            return;
          }
          const next = e.target.value || null;
          if (next !== value) onCommit(next);
        }}
      >
        <option value="">{loading ? "목록을 읽는 중…" : NS_ALL}</option>
        {names.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
        {unknown && <option value={"\u0000type"}>{NS_TYPE}</option>}
      </select>
    </label>
  );
}
