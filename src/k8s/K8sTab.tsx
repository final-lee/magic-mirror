import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ErrorState } from "../components/ErrorState";
import { DiagnoseTargetProvider } from "../tailscale/DiagnoseContext";
import { DoneNotice } from "../components/DoneNotice";
import { useCommand } from "../keymap/registry";
import { useApplyNotices } from "../iam/useApplyFlow";
import { AccessScreen } from "./access/AccessScreen";
import { BatchDialog, useK8sBatch } from "./ChangeBatch";
import { ChangeDialog, useK8sChange } from "./ChangeFlow";
import { ChangeLog } from "./ChangeLog";
import { DrainProgress } from "./DrainProgress";
import { CHANGE_DONE } from "./text";
import { ContextPicker } from "./ContextPicker";
import { EventsView } from "./EventsView";
import { ForwardsView } from "./ForwardsView";
import { HelmView } from "./helm/HelmView";
import { CartHost } from "./rbac/CartHost";
import { isRbacChange } from "./rbac/changes";
import { refreshAccess } from "./rbac/refresh";
import { K8sError } from "./K8sError";
import { K8sNav, type K8sView, type NavBookmark } from "./K8sNav";
import { NODES, PODS, bookmarkKey, bookmarkOf } from "./kinds";
import { LaneResizer, useLaneWidths } from "./lanes";
import { GotoBar } from "./nav/GotoBar";
import type { Goto } from "./nav/goto";
import { moved } from "../lib/useReorder";
import { MyRules } from "./MyRules";
import { NoContext } from "./NoContext";
import { OverviewView } from "./OverviewView";
import { NetworkView } from "./network/NetworkView";
import { SecurityView } from "./security/SecurityView";
import type { VpcOpen } from "./network/types";
import { NAMESPACES } from "./targets";
import { ALL, TopBar, type K8sConnection } from "./TopBar";
import { WorkloadsView, type WorkloadsFocus, type WorkloadsGoto } from "./WorkloadsView";
import { YamlCreate } from "./YamlCreate";
import { TerminalView } from "./terminal/TerminalView";
import { useTerminals } from "./terminal/useTerminals";
import { BOOKMARK_MISSING, savedMissing, NO_CONTEXT, NO_KUBECONFIG, STATE_CONNECTING, updateCommand } from "./text";
import { refreshK8s, useK8sKinds, useK8sRules, useUsageSampler } from "./queries";
import { useK8sConnection } from "./useK8sConnection";
import type { K8sChange, K8sKindRef, K8sTarget, ObjectRef } from "./types";
import type { K8sOpen } from "./open";
import { useK8sWatch } from "./useK8sWatch";

interface Props {
  target: K8sTarget;
  /** 이 탭이 보이는 탭인지(이후 단계의 단축키용) */
  active: boolean;
  /** 서비스 어카운트의 IAM 역할 ARN을 IAM 작업 공간에서 연다 */
  onOpenIam?: (arn: string) => void;
  /** 클러스터의 VPC 다이어그램을 노드·로드 밸런서 강조와 함께 연다(앱이 VPC 탭을 연다) */
  onOpenVpc?: (open: VpcOpen) => void;
  /** 다른 탭(ArgoCD)의 부탁: 이 Pod의 셸을 연다. 새 요청마다 nonce가 바뀐다 */
  open?: K8sOpen | null;
}

/** 사용량 그래프의 기록을 모은다. 읽을 때마다 다시 그려지는 것이 이 빈 컴포넌트뿐이도록 탭과 떼어 둔다. */
function UsageSampler({ target, context, namespace, ssoProfile, live }: {
  target: K8sTarget; context: string; namespace: string | null; ssoProfile: string; live: boolean;
}) {
  useUsageSampler(target, context, namespace, ssoProfile, live);
  return null;
}

export function K8sTab({ target, active, onOpenIam, onOpenVpc, open }: Props) {
  const qc = useQueryClient();
  const { settings, update, settingsReady, ctx, info, chosen, missing, candidate, session, ssoProfile, live } = useK8sConnection(target);

  const [userNs, setUserNs] = useState<string | null>(null);
  const [view, setView] = useState<K8sView>("overview");
  const [appliedChange, setAppliedChange] = useState<K8sChange | null>(null);
  const [focus, setFocus] = useState<WorkloadsFocus | null>(null);
  // `:` 명령 줄(k9s): 열려 있는지, 마지막으로 고른 종류, 열기 전에 커서가 있던 곳
  const root = useRef<HTMLDivElement>(null);
  const [gotoOpen, setGotoOpen] = useState(false);
  const [gotoKind, setGotoKind] = useState<WorkloadsGoto | null>(null);
  // 목록 화면이 지금 보이는 종류(`:ns`가 그 목록의 네임스페이스를 바꾸는지 정한다)
  const [shownKind, setShownKind] = useState<K8sKindRef | null>(null);
  // 목록에서 `:ns`로 네임스페이스를 바꾸면 늘어난다: 다시 읽은 목록에 커서를 둔다
  const [listFocus, setListFocus] = useState(0);
  const beforeGoto = useRef<Element | null>(null);
  const terminals = useTerminals();
  // 터미널 화면을 처음 열면 셸을 하나 띄운다(터미널은 다른 화면을 보는 동안에도 유지된다)
  const selectView = (next: K8sView) => {
    if (next === "terminal" && terminals.tabs.length === 0) terminals.open(null);
    setView(next);
  };
  // 플러그인 명령은 새 터미널 탭에서 실행한다
  const runPlugin = (command: string, title: string) => {
    terminals.open(command, title);
    setView("terminal");
  };
  useCommand("k8s.terminal", () => selectView("terminal"), { host: root, enabled: active });
  const notices = useApplyNotices();
  const change = useK8sChange(
    target,
    ssoProfile,
    (applied) => {
      notices.announce(CHANGE_DONE, []);
      setAppliedChange(applied);
      void qc.invalidateQueries({ queryKey: ["k8s-change-log"] });
      if (isRbacChange(applied)) void refreshAccess(qc, target, chosen);
    },
    () => void qc.invalidateQueries({ queryKey: ["k8s-change-log"] }),
  );
  const batch = useK8sBatch(target, ssoProfile, (applied) => {
    notices.announce(CHANGE_DONE, []);
    setAppliedChange(applied[applied.length - 1]);
    void qc.invalidateQueries({ queryKey: ["k8s-change-log"] });
  });
  const [creating, setCreating] = useState(false);
  const onRbacApplied = (applied: K8sChange[]) => {
    notices.announce(CHANGE_DONE, []);
    setAppliedChange(applied[applied.length - 1]);
    void qc.invalidateQueries({ queryKey: ["k8s-change-log"] });
    void refreshAccess(qc, target, chosen);
  };
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
    setGotoKind(null);
    setFocus((f) => ({ ref: { kind: NODES, namespace: null, name }, nonce: (f?.nonce ?? 0) + 1 }));
    setView("workloads");
  };
  // 네트워크·Helm 화면의 링크(Service, Ingress, Pod, NetworkPolicy, 릴리스 리소스)도 같은 길로 워크로드 화면에서 연다
  const openObject = (ref: ObjectRef) => {
    setGotoKind(null);
    setFocus((f) => ({ ref, nonce: (f?.nonce ?? 0) + 1 }));
    setView("workloads");
  };
  // 부탁받은 Pod 셸: 그 네임스페이스의 Pod 상세를 셸 탭으로 연다(확인 단계는 셸 탭이 평소대로 거친다)
  useEffect(() => {
    if (open?.kind !== "shell") return;
    setGotoKind(null);
    setUserNs(open.namespace);
    setFocus({ ref: { kind: PODS, namespace: open.namespace, name: open.pod }, nonce: open.nonce, shell: { container: open.container } });
    setView("workloads");
    // 요청이 바뀔 때(nonce)만 연다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open?.nonce]);

  const connected = settingsReady && !ctx.isPending && !ctx.isError && chosen !== null;
  useCommand(
    "k8s.goto",
    () => {
      beforeGoto.current = document.activeElement;
      setGotoOpen(true);
    },
    { host: root, enabled: connected && !gotoOpen },
  );
  // 종류 이동과 목록에서의 네임스페이스 바꾸기는 목록이 다시 그려진 뒤 WorkloadsView가 커서를 목록에 둔다
  const listTakesFocus = useRef(false);
  const goto = (g: Goto) => {
    if (g.type === "kind") {
      setFocus(null);
      setGotoKind((k) => ({ kind: g.kind, nonce: (k?.nonce ?? 0) + 1 }));
      setView("workloads");
      listTakesFocus.current = true;
    } else if (g.type === "view") {
      selectView(g.view);
    } else {
      setUserNs(g.namespace);
      if (listView) {
        setListFocus((n) => n + 1);
        listTakesFocus.current = true;
      }
    }
  };
  // 닫으면 커서를 돌려 놓는다: 목록이 맡지 않은 이동이면 새 화면의 첫 칸으로(레인 크기 조절 막대는 빼고), 이동하지 않았으면 열기 전 자리로
  const closeGoto = (went: boolean) => {
    setGotoOpen(false);
    const byList = went && listTakesFocus.current;
    listTakesFocus.current = false;
    if (byList) return;
    setTimeout(() => {
      const next = went ? root.current?.querySelector<HTMLElement>(".k8s-body [tabindex=\"0\"]:not([role=\"separator\"])") : beforeGoto.current;
      (next as HTMLElement | null)?.focus?.();
    }, 0);
  };

  const reconnect = () => void refreshK8s(qc, target, ssoProfile);
  const recheck = () => void ctx.refetch();
  // 종류 발견은 로그인 관리자가 무효화하지 않는 쿼리라서, 다시 시도와 로그인 뒤 이 쿼리만 다시 읽는다(exec 프로필로)
  const refetchKinds = () => void kinds.refetch();

  // 북마크는 모든 클러스터에 같이 쓴다. 이 클러스터의 종류 목록을 받았으면 그 버전으로 열고, 목록에 없으면 열지 못한다.
  const lanes = useLaneWidths();
  const bookmarks = settings?.k8sBookmarks ?? [];
  const marks = new Set(bookmarks.map(bookmarkKey));
  // 발견 결과가 있으면 제공하지 않는 북마크는 열지 않는다.
  const served = (b: K8sKindRef): K8sKindRef | null => {
    const key = bookmarkKey(b);
    const found = kinds.data?.find((k) => bookmarkKey(k) === key);
    if (found) return found;
    return !kinds.data ? b : null;
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
  const gotoCurrent = listView && shownKind?.namespaced ? { kind: shownKind, namespace } : undefined;

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
  const content = (
    <div className="pg" ref={root}>
      {gotoOpen && <GotoBar ctx={{ kinds: kinds.data ?? [], namespaces: names, current: gotoCurrent }} onGo={goto} onClose={closeGoto} />}
      {/* 연결돼 있는 동안 고른 네임스페이스(전체면 모두)의 사용량을 계속 모은다 */}
      <UsageSampler target={target} context={chosen} namespace={nsOrAll} ssoProfile={ssoProfile} live={live} />
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
        onCreateYaml={() => setCreating(true)}
      />
      {missing && <p className="err k8s-notes">{savedMissing(missing)}</p>}
      {namespaces.error && <K8sError error={namespaces.error} target={target} ssoProfile={ssoProfile} compact />}
      {notices.notices.map((notice) => <DoneNotice key={notice.id} notice={notice} onDismiss={() => notices.dismissNotice(notice.id)} />)}
      {change.pending && <ChangeDialog pending={change.pending} apply={change.apply} retry={change.retry} cancel={change.cancel} force={change.force} />}
      {change.drain && <DrainProgress run={change.drain} onStop={change.stopDrain} onClose={change.closeDrain} />}
      {creating && !batch.batch && (
        <YamlCreate
          kinds={kinds.data ?? []}
          namespace={nsOrAll}
          onPreview={(entries) => {
            setCreating(false);
            batch.api.start(entries);
          }}
          onClose={() => setCreating(false)}
        />
      )}
      {batch.batch && <BatchDialog batch={batch.batch} api={batch.api} />}
      <CartHost target={target} ssoProfile={ssoProfile} onApplied={onRbacApplied} />
      <div className="pg-main">
        <K8sNav
          view={view}
          onSelect={(v) => {
            // 메뉴로 직접 옮기면 `:` 명령이 고른 종류는 잊는다(All로 돌아올 때 기본 종류부터)
            setGotoKind(null);
            selectView(v);
          }}
          bookmarks={navBookmarks}
          onMoveBookmark={(from, to) => update({ k8sBookmarks: moved(bookmarks, from, to) })}
          onRemoveBookmark={removeBookmark}
          width={lanes.width("nav")}
        />
        <LaneResizer lane="nav" onResize={lanes.resize} onCommit={lanes.commit} />
        <div className={`k8s-body${listView || view === "access" || view === "network" || view === "helm" || view === "security" || view === "terminal" ? " flush" : ""}`}>
          {session.isError ? (
            <K8sError error={session.error} target={target} ssoProfile={ssoProfile} />
          ) : view === "overview" ? (
            <OverviewView
              target={target}
              context={chosen}
              ssoProfile={ssoProfile}
              live={live}
              visible={active}
              onOpenNode={openNode}
              sessionEpoch={session.dataUpdatedAt}
              onOpenEvents={() => setView("events")}
            />
          ) : listView ? (
            <WorkloadsView
              key={view}
              target={target}
              context={chosen}
              sessionEpoch={session.dataUpdatedAt}
              ssoProfile={ssoProfile}
              live={live}
              visible={active}
              namespace={nsOrAll}
              kinds={kinds.data ?? []}
              discoveryAvailable={kinds.data !== undefined}
              focus={focus}
              goto={gotoKind}
              onKindShown={setShownKind}
              listFocus={listFocus}
              onAllNamespaces={() => setUserNs(ALL)}
              onOpenIam={onOpenIam}
              onChange={change.start}
              appliedChange={appliedChange}
              plugins={settings?.k8sPlugins}
              onRunPlugin={runPlugin}
              banner={kinds.isError && <ErrorState error={kinds.error} profile={ssoProfile} compact onRetry={refetchKinds} onLoggedIn={refetchKinds} />}
              fixedKind={fixedKind}
              bookmarked={marks}
              onToggleBookmark={toggleBookmark}
              lanes={lanes}
            />
          ) : bookmarkView ? (
            <div className="empty">{BOOKMARK_MISSING}</div>
          ) : view === "network" ? (
            <NetworkView target={target} context={chosen} ssoProfile={ssoProfile} live={live} namespace={nsOrAll} onOpenObject={openObject} onOpenVpc={onOpenVpc} lanes={lanes} />
          ) : view === "events" ? (
            <EventsView target={target} context={chosen} sessionEpoch={session.dataUpdatedAt} ssoProfile={ssoProfile} live={live} namespace={nsOrAll} />
          ) : view === "forwards" ? (
            <ForwardsView target={target} ssoProfile={ssoProfile} />
          ) : view === "access" ? (
            <AccessScreen target={target} context={chosen} ssoProfile={ssoProfile} live={live} namespace={nsOrAll} onOpenIam={onOpenIam} onOpenMyRules={() => setView("myRules")} onChange={change.start} />
          ) : view === "security" ? (
            <SecurityView
              target={target}
              context={chosen}
              ssoProfile={ssoProfile}
              live={live}
              setting={settings?.k8sSecurityChecks}
              onSetting={(next) => update({ k8sSecurityChecks: next })}
              appliedChange={appliedChange}
              onChange={change.start}
              onOpenObject={openObject}
              onOpenIam={onOpenIam}
              onOpenAccess={() => setView("access")}
              lanes={lanes}
            />
          ) : view === "helm" ? (
            <HelmView
              target={target}
              context={chosen}
              ssoProfile={ssoProfile}
              live={live}
              visible={active}
              namespace={nsOrAll}
              kinds={kinds.data ?? []}
              appliedChange={appliedChange}
              onChange={change.start}
              onOpenObject={openObject}
              lanes={lanes}
            />
          ) : view === "terminal" ? null : view === "changeLog" ? (
            <ChangeLog target={target} onStart={change.start} />
          ) : rules.isError ? (
            <K8sError error={rules.error} target={target} ssoProfile={ssoProfile} />
          ) : rules.data ? (
            <MyRules rules={rules.data} allNamespaces={namespace === ALL} />
          ) : (
            <div className="empty">{STATE_CONNECTING}</div>
          )}
          {/* 터미널은 열려 있는 동안 다른 화면을 봐도 유지한다: 숨기기만 한다 */}
          {(terminals.tabs.length > 0 || view === "terminal") && (
            <TerminalView
              target={target}
              context={chosen}
              ssoProfile={ssoProfile}
              visible={view === "terminal" && !session.isError}
              tabs={terminals.tabs}
              active={terminals.active}
              onSelect={terminals.select}
              onClose={terminals.close}
              onNew={() => terminals.open(null)}
            />
          )}
        </div>
      </div>
    </div>
  );
  return <DiagnoseTargetProvider value={info?.endpoint ?? null}>{content}</DiagnoseTargetProvider>;
}
