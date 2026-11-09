import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { ErrorState } from "../components/ErrorState";
import { useCopyShortcut } from "../hooks/useCopyShortcut";
import { formatDateTime } from "../iam/format";
import { hasProblem } from "./group";
import { QueueDetail, type DetailTab } from "./QueueDetail";
import { QueueList } from "./QueueList";
import { RegionFlow } from "./RegionFlow";
import { refreshSqs, useSqsOverview } from "./queries";
import * as t from "./text";
import type { SqsJump } from "./types";

/** SQS 탭 밖으로 가는 길(큐는 탭 안에서 고르므로 빠진다) */
export type SqsExternalJump = Exclude<SqsJump, { kind: "queue" }>;

interface Props {
  profile: string;
  region: string;
  /** 이 탭이 보이는 탭인가. 보일 때만 다시 읽는다 */
  active: boolean;
  /** 리소스 목록에서 연 큐. nonce가 바뀔 때마다 그 큐를 고른다(같은 큐를 다시 열어도) */
  focus: { url: string; nonce: number } | null;
  onJump: (jump: SqsExternalJump) => void;
}

type View = "list" | "map";

/** 리전 단위 SQS 탭: 왼쪽 큐 목록(또는 리전 흐름 지도), 오른쪽 큐 상세 */
export function SqsTab({ profile, region, active, focus, onJump }: Props) {
  const qc = useQueryClient();
  const overview = useSqsOverview(profile, region, active);
  const [view, setView] = useState<View>("list");
  const [selectedUrl, setSelectedUrl] = useState<string | null>(focus?.url ?? null);
  const [tab, setTab] = useState<DetailTab>("overview");
  const [problemOnly, setProblemOnly] = useState(false);
  const [rereading, setRereading] = useState(false);

  const focusNonce = useRef(focus?.nonce);
  useEffect(() => {
    if (!focus || focus.nonce === focusNonce.current) return;
    focusNonce.current = focus.nonce;
    setSelectedUrl(focus.url);
    setTab("overview");
    setView("list");
  }, [focus]);

  const queues = useMemo(() => overview.data?.queues ?? [], [overview.data]);
  const selected = queues.find((q) => q.url === selectedUrl) ?? null;
  const problems = useMemo(() => queues.filter(hasProblem).length, [queues]);
  const listActive = active && view === "list";
  const root = useRef<HTMLDivElement>(null);
  useCopyShortcut(active ? selectedUrl : null, root);

  const select = (url: string) => {
    setSelectedUrl(url);
    setView("list");
  };
  // 큐는 이 탭에서 고르고, 나머지는 앱이 맡는다
  const jump = (to: SqsJump) => (to.kind === "queue" ? select(to.url) : onJump(to));
  const reread = () => {
    setRereading(true);
    void refreshSqs(qc, profile, region).finally(() => setRereading(false));
  };

  if (!overview.data) {
    return (
      <div className="sqs-tab" ref={root}>
        {overview.isError ? <ErrorState error={overview.error} profile={profile} onRetry={() => void overview.refetch()} /> : <div className="empty">{t.LOADING}</div>}
      </div>
    );
  }
  const data = overview.data;
  return (
    <div className="sqs-tab" ref={root}>
      <div className="sqs-top">
        <span className="kv-seg" role="group" aria-label={t.VIEW_GROUP}>
          <button type="button" className={`kv-seg-btn${view === "list" ? " on" : ""}`} aria-pressed={view === "list"} onClick={() => setView("list")}>
            {t.VIEW_LIST}
          </button>
          <button type="button" className={`kv-seg-btn${view === "map" ? " on" : ""}`} aria-pressed={view === "map"} onClick={() => setView("map")}>
            {t.VIEW_MAP}
          </button>
        </span>
        <span className="dim">{t.queueCount(queues.length)}</span>
        {problems > 0 && <span className="sqs-top-problems">{t.problemCount(problems)}</span>}
        {data.activityAt !== null && <span className="dim">{t.activityAt(formatDateTime(new Date(data.activityAt).toISOString()))}</span>}
        <span className="sqs-top-end">
          <button type="button" className="btn small tone-refresh" onClick={reread} disabled={rereading || overview.isFetching}>
            {rereading || overview.isFetching ? t.READING : t.REREAD}
          </button>
        </span>
      </div>
      {overview.isError && <ErrorState compact error={overview.error} profile={profile} onRetry={() => void overview.refetch()} />}
      {data.truncated && <div className="notice">{t.TRUNCATED}</div>}
      {data.activityError && <div className="notice">{t.activityFailed(data.activityError)}</div>}
      <div className="sqs-body" hidden={view !== "list"}>
        <QueueList queues={queues} selectedUrl={selectedUrl} onSelect={select} active={listActive} problemOnly={problemOnly} onProblemOnly={setProblemOnly} />
        {selected ? (
          <QueueDetail key={selected.url} profile={profile} region={region} active={listActive} queue={selected} queues={queues} tab={tab} onTab={setTab} onJump={jump} />
        ) : (
          <div className="empty sqs-detail-empty">{selectedUrl ? t.QUEUE_GONE : t.DETAIL_PICK}</div>
        )}
      </div>
      {view === "map" && (
        <div className="sqs-body sqs-map-body">
          <RegionFlow profile={profile} region={region} queues={queues} onJump={jump} />
        </div>
      )}
    </div>
  );
}
