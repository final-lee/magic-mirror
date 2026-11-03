import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "./api/errors";
import { GLOBAL, hardResetResourceCache, resourceTtlMs, useAccount, useProfiles, useServices, useSettings } from "./api/queries";
import type { Favorite } from "./api/types";
import { MainArea } from "./components/MainArea";
import type { ResourceFocus } from "./components/ResourceArea";
import { ResourcePalette, type PalettePick } from "./components/ResourcePalette";
import { NoProfiles } from "./components/NoProfiles";
import { ServiceSettings } from "./components/ServiceSettings";
import { Sidebar } from "./components/Sidebar";
import { TabBar, type TabInfo } from "./components/TabBar";
import { Toolbar } from "./components/Toolbar";
import { DiffTab } from "./explorer/DiffTab";
import { ExplorerTab } from "./explorer/ExplorerTab";
import { refKey, refName } from "./explorer/rows";
import type { DiffTool, FileRef, TransferRequest } from "./explorer/types";
import { useTransfers } from "./explorer/useTransfers";
import { K8sTab } from "./k8s/K8sTab";
import { closeK8s, refreshK8s } from "./k8s/queries";
import { k8sTabId } from "./k8s/targets";
import { tabTitle } from "./k8s/text";
import type { K8sTarget } from "./k8s/types";
import { IamTab } from "./iam/IamTab";
import { refreshIam, useIamOverview } from "./iam/queries";
import { ArgocdTab } from "./argocd/ArgocdTab";
import { ARGOCD_TITLE } from "./argocd/text";
import { ArgoWfTab } from "./argowf/ArgoWfTab";
import { ARGOWF_TITLE } from "./argowf/text";
import { CostTab } from "./cost/CostTab";
import { refreshCost } from "./cost/queries";
import { COST_TITLE } from "./cost/text";
import type { S3Location } from "./lib/s3";
import { PgTab } from "./pg/PgTab";
import { closePg, refreshPg } from "./pg/queries";
import { pgTabId } from "./pg/targets";
import type { PgTarget } from "./pg/types";
import { getVersion } from "@tauri-apps/api/app";
import { VpcMapTab } from "./vpcmap/VpcMapTab";
import type { VpcHighlight } from "./vpcmap/types";
import { UpdateBanner } from "./components/UpdateBanner";
import { useUpdater } from "./lib/useUpdater";
import { SsoBanner } from "./components/SsoBanner";
import { SsoLoginContext, useSsoLogin } from "./lib/useSsoLogin";
import { useTheme } from "./lib/theme";

const sameFav = (a: Favorite, b: Favorite) => a.service === b.service && a.type === b.type;

export default function App() {
  const qc = useQueryClient();
  const services = useServices();
  const profiles = useProfiles();
  const { settings, update, ...settingsQuery } = useSettings();
  useTheme(settings?.theme, !!settings);
  const [profile, setProfile] = useState<string | null>(null);
  const [region, setRegion] = useState("us-east-1");
  const [selection, setSelection] = useState<Favorite | null>(null);
  const [filter, setFilter] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);
  // ⌘K 리소스 찾기. focus는 거기서 고른 리소스로, nonce가 바뀔 때마다 그 행을 고른다(같은 리소스를 다시 골라도).
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [focus, setFocus] = useState<ResourceFocus | null>(null);
  const focusNonce = useRef(0);
  const account = useAccount(profile);
  const [activeTab, setActiveTab] = useState<string>("resources");
  const [explorerTabs, setExplorerTabs] = useState<{ id: string; location: S3Location }[]>([]);
  const [diffTabs, setDiffTabs] = useState<{ id: string; left: FileRef; right: FileRef }[]>([]);
  const [vpcTabs, setVpcTabs] = useState<{ id: string; vpcId: string; name: string; region: string; highlight?: VpcHighlight }[]>([]);
  // 대상(프로필·리전·종류·식별자)마다 탭 하나. 탭을 닫거나 프로필을 바꾸면 그 대상의 DB 연결도 닫는다.
  const [pgTabs, setPgTabs] = useState<{ id: string; target: PgTarget; title: string }[]>([]);
  // 클러스터마다 탭 하나(id는 리전과 이름). 탭을 닫거나 프로필을 바꾸면 그 클러스터의 연결과 감시도 닫는다.
  const [k8sTabs, setK8sTabs] = useState<{ id: string; target: K8sTarget }[]>([]);
  // IAM 탭은 하나뿐이다(id "iam"). focus는 리소스 목록에서 넘어온 대상 ARN, nonce는 열 때마다 올라가 같은 대상도 다시 이동시킨다.
  const [iamTab, setIamTab] = useState<{ focus: string | null; nonce: number } | null>(null);
  const iamOverview = useIamOverview(iamTab ? profile : null);
  // 비용 탭도 프로필마다 하나다(id "cost"). 리전과 상관없다.
  const [costTab, setCostTab] = useState(false);
  // ArgoCD 탭도 하나뿐이다(id "argocd"). AWS 프로필과 상관없어 프로필을 바꿔도 닫지 않는다.
  const [argocdTab, setArgocdTab] = useState(false);
  const [argowfTab, setArgowfTab] = useState(false);
  const onTransferSettled = useCallback(
    (_req: TransferRequest) => {
      void qc.invalidateQueries({ queryKey: ["s3"] });
      void qc.invalidateQueries({ queryKey: ["local"] });
      void qc.invalidateQueries({ queryKey: ["diff"] });
    },
    [qc],
  );
  const transfers = useTransfers(profile, onTransferSettled);
  // vite 개발 서버로 뜬 개발 빌드(npm run tauri:dev)는 릴리스 업데이트를 확인하지 않는다
  const updater = useUpdater({ devBuild: import.meta.env.DEV });
  const sso = useSsoLogin(profiles.data, profile);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    getVersion().then(setAppVersion, () => {});
  }, []);
  const transfersActive = transfers.items.some((i) => i.event.status === "queued" || i.event.status === "running");

  // 첫 로드: 마지막 프로필/리전 복원
  useEffect(() => {
    if (profile || !settings || !profiles.data?.length) return;
    const p = profiles.data.find((x) => x.name === settings.lastProfile) ?? profiles.data[0];
    setProfile(p.name);
    setRegion(settings.lastRegion ?? p.region ?? "us-east-1");
  }, [profile, settings, profiles.data]);

  const refresh = useCallback(() => {
    if (!profile) return;
    void qc.invalidateQueries({ queryKey: ["resources", profile] });
    void qc.invalidateQueries({ queryKey: ["s3", profile] });
    void qc.invalidateQueries({ queryKey: ["account", profile] });
    void qc.invalidateQueries({ queryKey: ["local"] });
    void qc.invalidateQueries({ queryKey: ["diff", profile] });
    void qc.invalidateQueries({ queryKey: ["vpc-topology", profile] });
    void refreshIam(qc, profile);
    // 비용은 Cost Explorer 요청마다 돈이 들어서 비용 탭을 보고 있을 때만 캐시를 건너뛰고 다시 읽는다
    if (activeTab === "cost") void refreshCost(qc, profile);
    // 보고 있는 PostgreSQL 탭은 연결부터 다시 읽는다. 보이지 않는 PostgreSQL 탭은 DB 연결을 열어 둔 채로 그대로 둔다.
    const pg = pgTabs.find((t) => t.id === activeTab);
    if (pg) void refreshPg(qc, pg.target);
    // 보고 있는 Kubernetes 탭은 연결을 닫고 다시 읽는다. 앱은 exec 프로필을 모르니 앱에서 고른 프로필을 넘긴다.
    const k8s = k8sTabs.find((t) => t.id === activeTab);
    if (k8s) void refreshK8s(qc, k8s.target, k8s.target.profile);
  }, [qc, profile, pgTabs, k8sTabs, activeTab]);

  // 하드 리셋: 모든 프로필·리전의 리소스 목록 캐시(메모리·디스크)를 버리고 보이는 목록을 처음부터 다시 읽는다
  const hardReset = useCallback(() => hardResetResourceCache(qc), [qc]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      const key = e.key.toLowerCase();
      if (key === "f") {
        e.preventDefault();
        filterRef.current?.focus();
      } else if (key === "r" && e.shiftKey) {
        e.preventDefault();
        hardReset().catch((err: unknown) => console.error("리소스 캐시를 비우지 못했어요", err));
      } else if (key === "r") {
        e.preventDefault();
        refresh();
      } else if (key === "k") {
        e.preventDefault();
        if (profile) setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [refresh, hardReset, profile]);

  if (profiles.data && profiles.data.length === 0) return <NoProfiles />;
  const failed = [
    { isError: services.isError && !services.data, error: services.error, refetch: services.refetch },
    { isError: settingsQuery.isError && !settings, error: settingsQuery.error, refetch: settingsQuery.refetch },
    { isError: profiles.isError && !profiles.data, error: profiles.error, refetch: profiles.refetch },
  ].filter((q) => q.isError);
  if (failed.length > 0) {
    return (
      <div className="empty full">
        <div className="err">{errorMessage(failed[0].error)}</div>
        <button className="btn" onClick={() => failed.forEach((q) => void q.refetch())}>
          다시 시도
        </button>
      </div>
    );
  }
  if (!services.data || !settings || !profiles.data) return <div className="empty full">불러오는 중…</div>;

  const enabled = services.data.filter((s) => settings.enabledServices.includes(s.id));

  const s3Service = services.data.find((s) => s.id === "s3");

  const openDiff = (left: FileRef, right: FileRef) => {
    const id = `diff:${refKey(left)}|${refKey(right)}`;
    setDiffTabs((tabs) => (tabs.some((t) => t.id === id) ? tabs : [...tabs, { id, left, right }]));
    setActiveTab(id);
  };
  const openExplorer = (loc: S3Location) => {
    const id = `s3:${loc.bucket}`;
    setExplorerTabs((tabs) => (tabs.some((t) => t.id === id) ? tabs : [...tabs, { id, location: { ...loc, prefix: "" } }]));
    setActiveTab(id);
    setFilter("");
  };
  // highlight는 EKS 탭이 노드·로드 밸런서를 강조해서 열 때만 온다. 이미 열린 탭은 새 강조를 받을 때만 바꾸고, 목록에서 다시 열 때는 그대로 둔다.
  const openVpc = (v: { vpcId: string; name: string; region: string; highlight?: VpcHighlight }) => {
    const id = `vpc:${v.vpcId}`;
    setVpcTabs((tabs) => (tabs.some((t) => t.id === id) ? tabs.map((t) => (t.id === id && v.highlight ? { ...t, highlight: v.highlight } : t)) : [...tabs, { id, ...v }]));
    setActiveTab(id);
    setFilter("");
  };
  const openPg = (target: PgTarget, title: string) => {
    const id = pgTabId(target);
    setPgTabs((tabs) => (tabs.some((t) => t.id === id) ? tabs : [...tabs, { id, target, title }]));
    setActiveTab(id);
    setFilter("");
  };
  const openK8s = (target: K8sTarget) => {
    const id = k8sTabId(target);
    setK8sTabs((tabs) => (tabs.some((t) => t.id === id) ? tabs : [...tabs, { id, target }]));
    setActiveTab(id);
    setFilter("");
  };
  const openIam = (focus: string | null = null) => {
    setIamTab((t) => ({ focus, nonce: (t?.nonce ?? 0) + 1 }));
    setActiveTab("iam");
    setFilter("");
  };
  const openCost = () => {
    setCostTab(true);
    setActiveTab("cost");
    setFilter("");
  };
  const openArgocd = () => {
    setArgocdTab(true);
    setActiveTab("argocd");
    setFilter("");
  };
  const openArgoWorkflows = () => {
    setArgowfTab(true);
    setActiveTab("argowf");
    setFilter("");
  };
  const closeTab = (id: string) => {
    if (id === "iam") setIamTab(null);
    if (id === "argocd") setArgocdTab(false);
    if (id === "argowf") setArgowfTab(false);
    if (id === "cost") setCostTab(false);
    const pg = pgTabs.find((t) => t.id === id);
    if (pg) void closePg(qc, pg.target);
    setPgTabs((tabs) => tabs.filter((t) => t.id !== id));
    const k8s = k8sTabs.find((t) => t.id === id);
    if (k8s) void closeK8s(qc, k8s.target, k8s.target.profile);
    setK8sTabs((tabs) => tabs.filter((t) => t.id !== id));
    setVpcTabs((tabs) => tabs.filter((t) => t.id !== id));
    setExplorerTabs((tabs) => tabs.filter((t) => t.id !== id));
    setDiffTabs((tabs) => tabs.filter((t) => t.id !== id));
    if (activeTab === id) {
      const order = tabs.map((t) => t.id);
      setActiveTab(order[order.indexOf(id) - 1] ?? "resources");
    }
  };
  const activate = (id: string) => {
    setActiveTab(id);
    setFilter("");
  };
  const diffTitle = (l: FileRef, r: FileRef) => (refName(l) === refName(r) ? `⇄ ${refName(l)}` : `⇄ ${refName(l)} ↔ ${refName(r)}`);
  const tabs: TabInfo[] = [
    { id: "resources", title: "리소스", closable: false },
    ...(iamTab ? [{ id: "iam", title: iamOverview.data ? `🔐 IAM · ${iamOverview.data.accountId}` : "🔐 IAM", closable: true }] : []),
    ...(costTab ? [{ id: "cost", title: COST_TITLE, closable: true }] : []),
    ...(argocdTab ? [{ id: "argocd", title: ARGOCD_TITLE, closable: true }] : []),
    ...(argowfTab ? [{ id: "argowf", title: ARGOWF_TITLE, closable: true }] : []),
    ...explorerTabs.map((t) => ({ id: t.id, title: `S3: ${t.location.bucket}`, closable: true })),
    ...vpcTabs.map((t) => ({ id: t.id, title: `🗺 ${t.name}`, closable: true })),
    ...pgTabs.map((t) => ({ id: t.id, title: t.title, closable: true })),
    ...k8sTabs.map((t) => ({ id: t.id, title: tabTitle(t.target.cluster), closable: true })),
    ...diffTabs.map((t) => ({ id: t.id, title: diffTitle(t.left, t.right), closable: true })),
  ];
  const diffTool: DiffTool = settings.diffTool ?? "filemerge";

  const changeProfile = (name: string) => {
    const info = profiles.data?.find((p) => p.name === name);
    const nextRegion = info?.region ?? region;
    // 사용자가 직접 고른 프로필이므로 그 SSO 세션의 실패·취소 기록을 지워 자동 로그인을 다시 켠다
    sso.rearm(name);
    setProfile(name);
    setRegion(nextRegion);
    setFocus(null);
    setPaletteOpen(false);
    // 버킷, IAM, 비용은 계정에 속하므로 버킷 탭, 비교 탭, IAM 탭, 비용 탭을 모두 닫는다. DB 연결은 그 프로필의 자격 증명으로 열었으니 PostgreSQL 탭도 닫는다.
    pgTabs.forEach((t) => void closePg(qc, t.target));
    setExplorerTabs([]);
    setDiffTabs([]);
    setVpcTabs([]);
    setPgTabs([]);
    k8sTabs.forEach((t) => void closeK8s(qc, t.target, t.target.profile));
    setK8sTabs([]);
    setIamTab(null);
    setCostTab(false);
    if (activeTab.startsWith("s3:") || activeTab.startsWith("vpc:") || activeTab.startsWith("diff:") || activeTab.startsWith("pg:") || activeTab.startsWith("k8s:") || activeTab === "iam" || activeTab === "cost") setActiveTab("resources");
    update({ lastProfile: name, lastRegion: nextRegion });
  };

  const changeRegion = (r: string) => {
    setRegion(r);
    setFocus(null);
    update({ lastRegion: r });
  };

  const select = (sel: Favorite) => {
    setSelection(sel);
    setFocus(null);
    setFilter("");
  };

  // ⌘K에서 고른 리소스로 간다: 리소스 탭, 그 리전(전역 서비스는 그대로), 그 종류, 그 행
  const pickResource = (p: PalettePick) => {
    setPaletteOpen(false);
    setActiveTab("resources");
    setFilter("");
    if (p.region !== GLOBAL && p.region !== region) changeRegion(p.region);
    setSelection({ service: p.service, type: p.type });
    focusNonce.current += 1;
    setFocus({ id: p.id, nonce: focusNonce.current });
  };

  const toggleFavorite = (sel: Favorite) => {
    const exists = settings.favorites.some((f) => sameFav(f, sel));
    update({ favorites: exists ? settings.favorites.filter((f) => !sameFav(f, sel)) : [...settings.favorites, sel] });
  };

  const mainKey = [profile, region, selection?.service, selection?.type].join("|");

  return (
    <SsoLoginContext.Provider value={sso}>
      <div className="app">
        <Toolbar
          profiles={profiles.data}
          profile={profile}
          onProfile={changeProfile}
          region={region}
          onRegion={changeRegion}
          filter={filter}
          onFilter={setFilter}
          filterRef={filterRef}
          onRefresh={refresh}
          onOpenSettings={() => setShowSettings(true)}
          onOpenPalette={() => profile && setPaletteOpen(true)}
        />
        <UpdateBanner updater={updater} transfersActive={transfersActive} />
        <SsoBanner entries={sso.entries} onCancel={sso.cancel} onRetry={(p) => void sso.start(p, { manual: true })} onDismiss={sso.dismiss} />
        <TabBar tabs={tabs} active={activeTab} onActivate={activate} onClose={closeTab} />
        <div className="tabpane main" hidden={activeTab !== "resources"}>
          <Sidebar
            services={enabled}
            profile={profile}
            region={region}
            selection={selection}
            favorites={settings.favorites}
            onSelect={select}
            onToggleFavorite={toggleFavorite}
            onOpenIam={() => openIam()}
            onOpenCost={openCost}
            onOpenArgocd={openArgocd}
            onOpenArgoWorkflows={openArgoWorkflows}
          />
          <MainArea
            key={mainKey}
            services={enabled}
            selection={selection}
            profile={profile}
            region={region}
            account={account.data}
            filter={filter}
            onOpenBucket={openExplorer}
            onOpenVpc={openVpc}
            onOpenIam={openIam}
            onOpenPg={(target) => openPg(target, `🐘 ${target.id}`)}
            onOpenK8s={openK8s}
            onRefresh={refresh}
            active={activeTab === "resources"}
            focus={focus}
          />
        </div>
        {profile && iamTab && (
          <div className="tabpane" hidden={activeTab !== "iam"}>
            <IamTab profile={profile} active={activeTab === "iam"} filter={activeTab === "iam" ? filter : ""} focus={iamTab.focus} nonce={iamTab.nonce} />
          </div>
        )}
        {profile && costTab && (
          <div className="tabpane" hidden={activeTab !== "cost"}>
            <CostTab key={profile} profile={profile} />
          </div>
        )}
        {argocdTab && (
          <div className="tabpane argo-pane" hidden={activeTab !== "argocd"}>
            <ArgocdTab active={activeTab === "argocd"} />
          </div>
        )}
        {argowfTab && (
          <div className="tabpane" hidden={activeTab !== "argowf"}>
            <ArgoWfTab active={activeTab === "argowf"} />
          </div>
        )}
        {explorerTabs.map((t) => (
          <div key={t.id} className="tabpane" hidden={activeTab !== t.id}>
            <ExplorerTab
              profile={profile}
              region={region}
              s3Service={s3Service}
              initialLocation={t.location}
              filter={activeTab === t.id ? filter : ""}
              active={activeTab === t.id}
              initialLocalPath={settings.explorerLocalPath ?? null}
              onLocalPathChange={(path) => update({ explorerLocalPath: path })}
              transfers={transfers}
              onOpenDiff={openDiff}
              onRefresh={refresh}
            />
          </div>
        ))}
        {profile &&
          vpcTabs.map((t) => (
            <div key={t.id} className="tabpane" hidden={activeTab !== t.id}>
              <VpcMapTab profile={profile} region={t.region} vpcId={t.vpcId} name={t.name} active={activeTab === t.id} highlight={t.highlight} />
            </div>
          ))}
        {pgTabs.map((t) => (
          <div key={t.id} className="tabpane" hidden={activeTab !== t.id}>
            <PgTab target={t.target} title={t.title} active={activeTab === t.id} filter={activeTab === t.id ? filter : ""} />
          </div>
        ))}
        {k8sTabs.map((t) => (
          <div key={t.id} className="tabpane k8s-pane" hidden={activeTab !== t.id}>
            <K8sTab target={t.target} active={activeTab === t.id} onOpenIam={openIam} onOpenVpc={openVpc} />
          </div>
        ))}
        {diffTabs.map((t) => (
          <div key={t.id} className="tabpane" hidden={activeTab !== t.id}>
            <DiffTab
              profile={profile}
              left={t.left}
              right={t.right}
              active={activeTab === t.id}
              transfers={transfers}
            />
          </div>
        ))}
        {showSettings && (
          <ServiceSettings
            services={services.data}
            enabled={settings.enabledServices}
            onChange={(ids) => update({ enabledServices: ids })}
            onClose={() => setShowSettings(false)}
            theme={settings.theme}
            onThemeChange={(theme) => update({ theme })}
            diffTool={diffTool}
            diffToolCommand={settings.diffToolCommand ?? null}
            onDiffToolChange={(tool, command) => update({ diffTool: tool, diffToolCommand: command })}
            kubeconfigPath={settings.kubeconfigPath ?? null}
            onKubeconfigPathChange={(path) => {
              update({ kubeconfigPath: path });
              // 연결을 닫고 감시를 버린 뒤 다시 열어야 새 kubeconfig의 인증을 쓴다.
              for (const t of k8sTabs) void refreshK8s(qc, t.target, t.target.profile);
            }}
            updater={updater}
            appVersion={appVersion}
            cacheTtlMinutes={settings.resourceCacheTtlMinutes ?? null}
            onCacheTtlChange={(minutes) => update({ resourceCacheTtlMinutes: minutes })}
            onClearCache={hardReset}
          />
        )}
        {paletteOpen && profile && (
          <ResourcePalette profile={profile} services={enabled} ttlMs={resourceTtlMs(settings.resourceCacheTtlMinutes)} onPick={pickResource} onClose={() => setPaletteOpen(false)} />
        )}
      </div>
    </SsoLoginContext.Provider>
  );
}
