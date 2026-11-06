import { useEffect, useState } from "react";
import { desktop } from "../api/desktop";
import { ErrorState } from "../components/ErrorState";
import { QueueActions } from "./change/QueueActions";
import { SqsChangeLog } from "./change/SqsChangeLog";
import { Flow } from "./Flow";
import { Messages } from "./messages/Messages";
import { Overview } from "./Overview";
import { useSqsQueue } from "./queries";
import * as t from "./text";
import type { SqsJump, SqsQueue } from "./types";

export type DetailTab = keyof typeof t.DETAIL_TABS;
const TAB_ORDER: DetailTab[] = ["overview", "flow", "messages", "log"];

interface Props {
  profile: string;
  region: string;
  /** SQS 탭이 보이는가. 보일 때만 5초마다 읽는다 */
  active: boolean;
  /** 목록에서 읽은 큐(고른 큐를 아직 못 읽었거나 읽기에 실패했을 때 이 값을 보여 준다) */
  queue: SqsQueue;
  queues: SqsQueue[];
  tab: DetailTab;
  onTab: (tab: DetailTab) => void;
  onJump: (jump: SqsJump) => void;
}

/** 오른쪽 큐 상세: 탭 개요 | 흐름 | 메시지 | 기록. 고른 큐는 5초마다 다시 읽는다 */
export function QueueDetail({ profile, region, active, queue: listed, queues, tab, onTab, onJump }: Props) {
  const q = useSqsQueue(profile, region, listed.url, active);
  const queue = q.data ?? listed;
  // 메시지 탭은 한 번 열면 계속 둔다: 탭을 옮겨도 받아 둔 메시지와 보류가 이어지고, 큐를 바꾸거나 탭을 닫을 때만 놓아준다
  const [messagesOpened, setMessagesOpened] = useState(false);
  useEffect(() => {
    if (tab === "messages") setMessagesOpened(true);
  }, [tab]);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const onSelect = (url: string) => onJump({ kind: "queue", url });

  return (
    <section className="sqs-detail" aria-label={queue.name}>
      <header className="sqs-detail-head">
        <h3 className="mono">{queue.name}</h3>
        {queue.fifo && <span className="iam-chip">{t.BADGE_FIFO}</span>}
        {queue.isDlq && <span className="iam-chip">{t.BADGE_DLQ}</span>}
        <div className="sqs-detail-end">
          <button
            type="button"
            className="btn small tone-secondary"
            onClick={() => {
              void desktop.copy(queue.url);
              setCopied(true);
            }}
          >
            {copied ? t.COPIED : t.COPY_URL}
          </button>
          <QueueActions profile={profile} region={region} queue={queue} queues={queues} />
        </div>
      </header>
      <div className="sqs-detail-tabs" role="tablist" aria-label={t.DETAIL_TABS_LABEL}>
        {TAB_ORDER.map((id) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={`sqs-detail-tab${tab === id ? " on" : ""}`} onClick={() => onTab(id)}>
            {t.DETAIL_TABS[id]}
          </button>
        ))}
      </div>
      {q.isError && <ErrorState compact error={q.error} profile={profile} onRetry={() => void q.refetch()} />}
      <div className="sqs-detail-body">
        {tab === "overview" && <Overview profile={profile} region={region} queue={queue} queues={queues} onSelect={onSelect} />}
        {tab === "flow" && <Flow key={queue.url} profile={profile} region={region} queue={queue} active={active} onJump={onJump} />}
        {messagesOpened && (
          <div className="sqs-detail-pane" hidden={tab !== "messages"}>
            <Messages key={queue.url} profile={profile} region={region} queue={queue} queues={queues} active={active && tab === "messages"} />
          </div>
        )}
        {tab === "log" && <SqsChangeLog profile={profile} region={region} url={queue.url} />}
      </div>
    </section>
  );
}
