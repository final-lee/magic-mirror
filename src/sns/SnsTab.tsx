import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { errorMessage } from "../api/errors";
import { ErrorState } from "../components/ErrorState";
import { RawModal } from "../components/RawModal";
import { shortcutTitle } from "../keymap/keybindings";
import { useHistoryKeys } from "../lib/useHistoryKeys";
import { useRouteHistory } from "../lib/useRouteHistory";
import { Diagnosis } from "./Diagnosis";
import { FilterTester } from "./FilterTester";
import { Flow } from "./Flow";
import { endpointLabel, parseJsonText, topicHeadline } from "./format";
import { Metrics } from "./Metrics";
import { Overview } from "./Overview";
import { refreshSns, useSnsTopic } from "./queries";
import { SNS_HOME, SNS_VIEW_LABEL, sameSnsRoute, snsSubscriptionRoute } from "./route";
import { SnsNav } from "./SnsNav";
import { Subscriptions } from "./Subscriptions";
import { SubscriptionDetail } from "./SubscriptionDetail";
import { snsTabId, type ResourceJump, type SnsOpen, type SnsTopicRef } from "./targets";
import * as t from "./text";
import type { SnsTopic } from "./types";
import type { IamRoute } from "../iam/route";
import { Policy } from "./Policy";
import { ChangeLog } from "./ChangeLog";

interface Props {
  target: SnsTopicRef;
  /** 이 탭이 보이는 탭일 때만 마우스 뒤로/앞으로 버튼과 ⌘F에 반응한다(⌘[ ⌘]는 탭의 뿌리 상자가 보이는지로 가린다) */
  active: boolean;
  /** 탭을 열면서 요청한 화면(구독 상세 등). nonce가 바뀔 때마다 그 화면으로 이동한다 */
  open?: SnsOpen;
  /** 구독 상세의 [SQS 큐 열기] 같은 단추: 리소스 브라우저의 그 행으로 간다 */
  onOpenResource?: (jump: ResourceJump) => void;
  /** 정책 화면의 [IAM에서 … 보기]: IAM 탭을 열고 '누가 할 수 있나'를 채운다 */
  onOpenIam?: (focus: string | null, route?: IamRoute) => void;
}

/** 원본 데이터: 속성, 태그, 데이터 보호 정책(JSON이면 풀어서) */
function rawText(topic: SnsTopic): string {
  return JSON.stringify({ attributes: topic.attributes, tags: topic.tags, dataProtectionPolicy: parseJsonText(topic.dataProtectionPolicy) ?? topic.dataProtectionPolicy }, null, 2);
}

export function SnsTab({ target, active, open, onOpenResource, onOpenIam }: Props) {
  const qc = useQueryClient();
  const q = useSnsTopic(target);
  const topic = q.data;
  const { route, canBack, canForward, navigate, back, forward } = useRouteHistory(SNS_HOME, sameSnsRoute);
  const root = useRef<HTMLDivElement>(null);
  useHistoryKeys(root, active, back, forward);
  const [showRaw, setShowRaw] = useState(false);

  // 탭을 열면서 받은 요청(또는 이미 열려 있는 탭에 새로 온 요청)으로 이동한다
  const seen = useRef<number | null>(null);
  useEffect(() => {
    if (!open || open.nonce === seen.current) return;
    seen.current = open.nonce;
    navigate(open.route);
  }, [open, navigate]);

  const reread = () => void refreshSns(qc, target);

  const renderView = (topic: SnsTopic): ReactNode => {
    switch (route.view) {
      case "overview":
        return <Overview topic={topic} onShowRaw={() => setShowRaw(true)} />;
      case "subscriptions":
        return <Subscriptions topic={topic} target={target} active={active} onOpen={(key) => navigate(snsSubscriptionRoute(key))} />;
      case "subscription":
        return <SubscriptionDetail topic={topic} subscriptionKey={route.subscription ?? ""} onBack={() => navigate({ view: "subscriptions" })} onOpenResource={onOpenResource} />;
      case "flow":
        return <Flow topic={topic} target={target} onOpen={(key) => navigate(snsSubscriptionRoute(key))} />;
      case "diagnosis":
        return <Diagnosis target={target} topic={topic} />;
      case "filter":
        return <FilterTester topic={topic} tabId={snsTabId(target)} />;
      case "policy":
        return <Policy target={target} onOpenIam={onOpenIam} />;
      case "changes":
        return <ChangeLog target={target} />;
      case "metrics":
        return <Metrics profile={target.profile} topic={topic} />;
      default: {
        // 뒤 단계가 화면을 더하면 여기서 컴파일 오류가 나서 그리는 곳을 더하게 한다
        const unhandled: never = route.view;
        return unhandled;
      }
    }
  };

  const crumb = (topic: SnsTopic): ReactNode => {
    if (route.view !== "subscription") return <b>{SNS_VIEW_LABEL[route.view]}</b>;
    const sub = topic.subscriptions.find((s) => s.key === route.subscription);
    return (
      <>
        <button className="link crumb-link" onClick={() => navigate({ view: "subscriptions" })}>
          {SNS_VIEW_LABEL.subscriptions}
        </button>
        <span aria-hidden="true">›</span>
        <b className="mono">{sub ? endpointLabel(sub, topic).name : SNS_VIEW_LABEL.subscription}</b>
      </>
    );
  };

  let content: ReactNode;
  if (!topic) {
    content = q.isError ? <ErrorState error={q.error} profile={target.profile} onRetry={reread} /> : <div className="empty">{t.LOADING}</div>;
  } else {
    content = (
      <>
        <SnsNav view={route.view} onSelect={(view) => navigate({ view })} />
        <div className="iam-body">
          <div className="iam-bar">
            <button className="icon" aria-label={t.NAV_BACK} title={shortcutTitle(t.NAV_BACK, "tab.back")} disabled={!canBack} onClick={back}>
              ‹
            </button>
            <button className="icon" aria-label={t.NAV_FORWARD} title={shortcutTitle(t.NAV_FORWARD, "tab.forward")} disabled={!canForward} onClick={forward}>
              ›
            </button>
            <nav className="iam-crumb" aria-label={t.CRUMB_LABEL}>
              {crumb(topic)}
            </nav>
          </div>
          <div className="iam-main">{renderView(topic)}</div>
        </div>
      </>
    );
  }

  return (
    <div className="sns-tab" ref={root}>
      <div className="sns-top" role="group" aria-label={t.INFO_GROUP}>
        <b className="sns-ident-name">{topic?.name ?? target.topicName}</b>
        {topic && <span className="dim">{topicHeadline(topic)}</span>}
        <span className="sns-top-end">
          <button className="btn small tone-refresh" onClick={reread} disabled={q.isFetching}>
            {q.isFetching ? t.READING : t.REREAD}
          </button>
        </span>
      </div>
      {topic && q.isError && <ErrorState compact error={q.error} profile={target.profile} onRetry={reread} />}
      {topic && topic.errors.length > 0 && (
        <div className="sns-partial dim" role="status" aria-label={t.PARTIAL_LABEL}>
          {`${t.PARTIAL(topic.errors.length)}: ${[...new Set(topic.errors.map(errorMessage))].join(" · ")}`}
        </div>
      )}
      <div className="sns-main">{content}</div>
      {showRaw && topic && <RawModal title={topic.name} text={rawText(topic)} onClose={() => setShowRaw(false)} />}
    </div>
  );
}
