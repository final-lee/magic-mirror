import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSettings } from "../api/queries";
import { ErrorState } from "../components/ErrorState";
import { DoneNotice } from "../components/DoneNotice";
import { useApplyNotices } from "../iam/useApplyFlow";
import { ChangeDialog, useK8sChange } from "./ChangeFlow";
import { ChangeLog } from "./ChangeLog";
import { CHANGE_DONE } from "./text";
import { ContextPicker } from "./ContextPicker";
import { EventsView } from "./EventsView";
import { K8sError } from "./K8sError";
import { K8sNav, type K8sView, type NavBookmark } from "./K8sNav";
import { BUILTIN, NODES, bookmarkKey, bookmarkOf } from "./kinds";
import { LaneResizer, useLaneWidths } from "./lanes";
import { moved } from "./useReorder";
import { MyRules } from "./MyRules";
import { NoContext } from "./NoContext";
import { OverviewView } from "./OverviewView";
import { NAMESPACES, chooseContext, ssoProfileOf } from "./targets";
import { ALL, TopBar, type K8sConnection } from "./TopBar";
import { WorkloadsView, type WorkloadsFocus } from "./WorkloadsView";
import { BOOKMARK_MISSING, savedMissing, NO_CONTEXT, NO_KUBECONFIG, STATE_CONNECTING, updateCommand } from "./text";
import { refreshK8s, useK8sContext, useK8sKinds, useK8sRules, useK8sSession } from "./queries";
import type { K8sChange, K8sKindRef, K8sTarget } from "./types";
import { useK8sWatch } from "./useK8sWatch";

interface Props {
  target: K8sTarget;
  /** 이 탭이 보이는 탭인지(이후 단계의 단축키용) */
  active: boolean;
  /** 서비스 어카운트의 IAM 역할 ARN을 IAM 작업 공간에서 연다 */
  onOpenIam?: (arn: string) => void;
}

export function K8sTab({ target, onOpenIam }: Props) {
  const qc = useQueryClient();
  const { settings, isError: settingsFailed, update } = useSettings();
  const settingsReady = settings !== undefined || settingsFailed;
  const kubeconfig = settings?.kubeconfigPath ?? null;
  // 저장해 둔 context는 ARN을 알아야 찾을 수 있어서, 백엔드에는 늘 null을 넘기고 고르는 일은 여기서 한다.
  const ctx = useK8sContext(target, kubeconfig, null, settingsReady);
  const info = ctx.data;
  const saved = info ? settings?.k8sContexts?.[info.arn] ?? null : null;
  const [chosen, missing] = info
    ? chooseContext(
        info.candidates.map((c) => c.name),
        saved,
      )
    : [null, null];
  const candidate = info?.candidates.find((c) => c.name === chosen) ?? null;

  const [userNs, setUserNs] = useState<string | null>(null);
  const [view, setView] = useState<K8sView>("overview");
  const [changeMode, setChangeMode] = useState(false);
  const [appliedChange, setAppliedChange] = useState<K8sChange | null>(null);
  const [focus, setFocus] = useState<WorkloadsFocus | null>(null);
  const session = useK8sSession(target, kubeconfig, settingsReady ? chosen : null, ssoProfileOf(target, candidate, null));
  const ssoProfile = ssoProfileOf(target, candidate, session.data);
  const live = session.isSuccess && !session.isFetching;
  const notices = useApplyNotices();
  const change = useK8sChange(target, ssoProfile, (applied) => {
    notices.announce(CHANGE_DONE, []);
    setAppliedChange(applied);
    void qc.invalidateQueries({ queryKey: ["k8s-change-log"] });
  });
  const namespaces = useK8sWatch(target, chosen ?? "", session.dataUpdatedAt, ssoProfile, NAMESPACES, null, live);
  const names = namespaces.rows.map((r) => r.name);

  // 처음 고르는 값: context의 기본 네임스페이스, 없으면 default, 그것도 없으면 모두
  const fallback = candidate?.namespace || (names.includes("default") ? "default" : ALL);
  const namespace = userNs ?? fallback;
  const rulesNs = namespace === ALL ? "default" : namespace;
  // 내 권한 화면에서만 읽는다(ObjectDetail의 Secret 확인은 자기 네임스페이스를 따로 묻는다)
  const rules = useK8sRules(target, chosen, rulesNs, ssoProfile, live && view === "myRules");
  const kinds = useK8sKinds(target, chosen, ssoProfile, live);
  const nsOrAll = namespace === ALL ? null : namespace;
  const openNode = (name: string) => {
    setFocus((f) => ({ ref: { kind: NODES, namespace: null, name }, nonce: (f?.nonce ?? 0) + 1 }));
    setView("workloads");
  };

  const reconnect = () => void refreshK8s(qc, target, ssoProfile);
  const recheck = () => void ctx.refetch();
  // 종류 발견은 로그인 관리자가 무효화하지 않는 쿼리라서, 다시 시도와 로그인 뒤 이 쿼리만 다시 읽는다(exec 프로필로)
  const refetchKinds = () => void kinds.refetch();

  // 북마크는 모든 클러스터에 같이 쓴다. 이 클러스터의 종류 목록을 받았으면 그 버전으로 열고, 목록에 없으면 열지 못한다.
  const lanes = useLaneWidths();
  const bookmarks = settings?.k8sBookmarks ?? [];
  const marks = new Set(bookmarks.map(bookmarkKey));
  // 내장 종류는 All 트리처럼 늘 연다. 사용자 정의 종류는 이 클러스터의 목록에 있어야 연다(목록을 아직 모르면 일단 연다).
  const served = (b: K8sKindRef): K8sKindRef | null => {
    const key = bookmarkKey(b);
    const found = kinds.data?.find((k) => bookmarkKey(k) === key);
    if (found) return found;
    return !kinds.data || BUILTIN.some((k) => bookmarkKey(k) === key) ? b : null;
  };
  const navBookmarks: NavBookmark[] = bookmarks.map((b) => {
    const missing = served(b) === null;
    return { key: bookmarkKey(b), label: b.kind, title: missing ? BOOKMARK_MISSING : `${b.group || "core"}/${b.version} ${b.plural}`, missing };
  });
  const toggleBookmark = (k: K8sKindRef) => {
    const key = bookmarkKey(k);
    update({ k8sBookmarks: marks.has(key) ? bookmarks.filter((b) => bookmarkKey(b) !== key) : [...bookmarks, bookmarkOf(k)] });
  };
  const removeBookmark = (key: string) => {
    update({ k8sBookmarks: bookmarks.filter((b) => bookmarkKey(b) !== key) });
    if (view === `bookmark:${key}`) setView("workloads");
  };
  const bookmarkView = view.startsWith("bookmark:");
  const shownBookmark = bookmarkView ? bookmarks.find((b) => `bookmark:${bookmarkKey(b)}` === view) : undefined;
  const fixedKind = shownBookmark ? served(shownBookmark) ?? undefined : undefined;
  const listView = view === "workloads" || fixedKind !== undefined;

  if (!settingsReady || ctx.isPending) return <div className="empty">{STATE_CONNECTING}</div>;
  if (ctx.isError) {
    return <K8sError error={ctx.error} target={target} ssoProfile={target.profile} />;
  }
  if (chosen === null) {
    if (info!.candidates.length === 0) return <NoContext message={info!.kubeconfigMissing ? NO_KUBECONFIG(info!.kubeconfigPaths) : NO_CONTEXT} command={info!.updateCommand} onRecheck={recheck} />;
    return (
      <ContextPicker
        candidates={info!.candidates}
        missing={missing}
        onPick={(name) => update({ k8sContexts: { ...settings?.k8sContexts, [info!.arn]: name } })}
      />
    );
  }

  const connection: K8sConnection = session.isError ? "failed" : session.isSuccess && !session.isFetching ? "connected" : "connecting";
  return (
    <div className="pg">
      <TopBar
        context={chosen}
        identity={session.data?.identity ?? null}
        connection={connection}
        execProfile={session.data?.execProfile ?? candidate?.execProfile ?? null}
        profile={target.profile}
        namespaces={names}
        namespace={namespace}
        onNamespace={setUserNs}
        onReconnect={reconnect}
        changeMode={changeMode}
        onChangeMode={setChangeMode}
      />
      {missing && <p className="err k8s-notes">{savedMissing(missing)}</p>}
      {namespaces.error && <K8sError error={namespaces.error} target={target} ssoProfile={ssoProfile} compact />}
      {notices.notices.map((notice) => <DoneNotice key={notice.id} notice={notice} onDismiss={() => notices.dismissNotice(notice.id)} />)}
      {change.pending && <ChangeDialog pending={change.pending} apply={change.apply} retry={change.retry} cancel={change.cancel} />}
      <div className="pg-main">
        <K8sNav
          view={view}
          onSelect={setView}
          bookmarks={navBookmarks}
          onMoveBookmark={(from, to) => update({ k8sBookmarks: moved(bookmarks, from, to) })}
          onRemoveBookmark={removeBookmark}
          width={lanes.width("nav")}
        />
        <LaneResizer lane="nav" onResize={lanes.resize} onCommit={lanes.commit} />
        <div className={`k8s-body${listView ? " flush" : ""}`}>
          {session.isError ? (
            <K8sError error={session.error} target={target} ssoProfile={ssoProfile} />
          ) : view === "overview" ? (
            <OverviewView target={target} context={chosen} ssoProfile={ssoProfile} live={live} onOpenNode={openNode} />
          ) : listView ? (
            <WorkloadsView
              key={view}
              target={target}
              context={chosen}
              sessionEpoch={session.dataUpdatedAt}
              ssoProfile={ssoProfile}
              live={live}
              namespace={nsOrAll}
              kinds={kinds.data ?? []}
              focus={focus}
              onOpenIam={onOpenIam}
              changeMode={changeMode}
              onChange={change.start}
              appliedChange={appliedChange}
              banner={kinds.isError && <ErrorState error={kinds.error} profile={ssoProfile} compact onRetry={refetchKinds} onLoggedIn={refetchKinds} />}
              fixedKind={fixedKind}
              bookmarked={marks}
              onToggleBookmark={toggleBookmark}
              lanes={lanes}
            />
          ) : bookmarkView ? (
            <div className="empty">{BOOKMARK_MISSING}</div>
          ) : view === "events" ? (
            <EventsView target={target} context={chosen} sessionEpoch={session.dataUpdatedAt} ssoProfile={ssoProfile} live={live} namespace={nsOrAll} />
          ) : view === "changeLog" ? (
            <ChangeLog target={target} onStart={change.start} changeMode={changeMode} />
          ) : rules.isError ? (
            <K8sError error={rules.error} target={target} ssoProfile={ssoProfile} />
          ) : rules.data ? (
            <MyRules rules={rules.data} allNamespaces={namespace === ALL} />
          ) : (
            <div className="empty">{STATE_CONNECTING}</div>
          )}
        </div>
      </div>
    </div>
  );
}
