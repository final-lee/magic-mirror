import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "./api/errors";
import { useAccount, useProfiles, useServices, useSettings } from "./api/queries";
import type { Favorite } from "./api/types";
import { MainArea } from "./components/MainArea";
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
import { IamTab } from "./iam/IamTab";
import { refreshIam, useIamOverview } from "./iam/queries";
import type { S3Location } from "./lib/s3";
import { getVersion } from "@tauri-apps/api/app";
import { VpcMapTab } from "./vpcmap/VpcMapTab";
import { UpdateBanner } from "./components/UpdateBanner";
import { useUpdater } from "./lib/useUpdater";

const sameFav = (a: Favorite, b: Favorite) => a.service === b.service && a.type === b.type;

export default function App() {
  const qc = useQueryClient();
  const services = useServices();
  const profiles = useProfiles();
  const { settings, update, ...settingsQuery } = useSettings();
  const [profile, setProfile] = useState<string | null>(null);
  const [region, setRegion] = useState("us-east-1");
  const [selection, setSelection] = useState<Favorite | null>(null);
  const [filter, setFilter] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);
  const account = useAccount(profile);
  const [activeTab, setActiveTab] = useState<string>("resources");
  const [explorerTabs, setExplorerTabs] = useState<{ id: string; location: S3Location }[]>([]);
  const [diffTabs, setDiffTabs] = useState<{ id: string; left: FileRef; right: FileRef }[]>([]);
  const [vpcTabs, setVpcTabs] = useState<{ id: string; vpcId: string; name: string; region: string }[]>([]);
  // IAM 탭은 하나뿐이다(id "iam"). focus는 리소스 목록에서 넘어온 대상 ARN, nonce는 열 때마다 올라가 같은 대상도 다시 이동시킨다.
  const [iamTab, setIamTab] = useState<{ focus: string | null; nonce: number } | null>(null);
  const iamOverview = useIamOverview(iamTab ? profile : null);
  const onTransferSettled = useCallback(
    (_req: TransferRequest) => {
      void qc.invalidateQueries({ queryKey: ["s3"] });
      void qc.invalidateQueries({ queryKey: ["local"] });
      void qc.invalidateQueries({ queryKey: ["diff"] });
    },
    [qc],
  );
  const transfers = useTransfers(profile, onTransferSettled);
  const updater = useUpdater();
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
  }, [qc, profile]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      const key = e.key.toLowerCase();
      if (key === "f") {
        e.preventDefault();
        filterRef.current?.focus();
      } else if (key === "r") {
        e.preventDefault();
        refresh();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [refresh]);

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
  const openVpc = (v: { vpcId: string; name: string; region: string }) => {
    const id = `vpc:${v.vpcId}`;
    setVpcTabs((tabs) => (tabs.some((t) => t.id === id) ? tabs : [...tabs, { id, ...v }]));
    setActiveTab(id);
    setFilter("");
  };
  const openIam = (focus: string | null = null) => {
    setIamTab((t) => ({ focus, nonce: (t?.nonce ?? 0) + 1 }));
    setActiveTab("iam");
    setFilter("");
  };
  const closeTab = (id: string) => {
    if (id === "iam") setIamTab(null);
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
    ...explorerTabs.map((t) => ({ id: t.id, title: `S3: ${t.location.bucket}`, closable: true })),
    ...vpcTabs.map((t) => ({ id: t.id, title: `🗺 ${t.name}`, closable: true })),
    ...diffTabs.map((t) => ({ id: t.id, title: diffTitle(t.left, t.right), closable: true })),
  ];
  const diffTool: DiffTool = settings.diffTool ?? "filemerge";

  const changeProfile = (name: string) => {
    const info = profiles.data?.find((p) => p.name === name);
    const nextRegion = info?.region ?? region;
    setProfile(name);
    setRegion(nextRegion);
    // 버킷과 IAM은 계정에 속하므로 버킷 탭, 비교 탭, IAM 탭을 모두 닫는다.
    setExplorerTabs([]);
    setDiffTabs([]);
    setVpcTabs([]);
    setIamTab(null);
    if (activeTab.startsWith("s3:") || activeTab.startsWith("vpc:") || activeTab.startsWith("diff:") || activeTab === "iam") setActiveTab("resources");
    update({ lastProfile: name, lastRegion: nextRegion });
  };

  const changeRegion = (r: string) => {
    setRegion(r);
    update({ lastRegion: r });
  };

  const select = (sel: Favorite) => {
    setSelection(sel);
    setFilter("");
  };

  const toggleFavorite = (sel: Favorite) => {
    const exists = settings.favorites.some((f) => sameFav(f, sel));
    update({ favorites: exists ? settings.favorites.filter((f) => !sameFav(f, sel)) : [...settings.favorites, sel] });
  };

  const mainKey = [profile, region, selection?.service, selection?.type].join("|");

  return (
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
      />
      <UpdateBanner updater={updater} transfersActive={transfersActive} />
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
          onRefresh={refresh}
          active={activeTab === "resources"}
        />
      </div>
      {profile && iamTab && (
        <div className="tabpane" hidden={activeTab !== "iam"}>
          <IamTab profile={profile} active={activeTab === "iam"} filter={activeTab === "iam" ? filter : ""} focus={iamTab.focus} nonce={iamTab.nonce} />
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
            <VpcMapTab profile={profile} region={t.region} vpcId={t.vpcId} name={t.name} active={activeTab === t.id} />
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
          diffTool={diffTool}
          diffToolCommand={settings.diffToolCommand ?? null}
          onDiffToolChange={(tool, command) => update({ diffTool: tool, diffToolCommand: command })}
          updater={updater}
          appVersion={appVersion}
        />
      )}
    </div>
  );
}
