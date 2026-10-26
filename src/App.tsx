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
import type { S3Location } from "./lib/s3";

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
  const onTransferSettled = useCallback(
    (_req: TransferRequest) => {
      void qc.invalidateQueries({ queryKey: ["s3"] });
      void qc.invalidateQueries({ queryKey: ["local"] });
      void qc.invalidateQueries({ queryKey: ["diff"] });
    },
    [qc],
  );
  const transfers = useTransfers(profile, onTransferSettled);

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
  const closeTab = (id: string) => {
    setExplorerTabs((tabs) => tabs.filter((t) => t.id !== id));
    setDiffTabs((tabs) => tabs.filter((t) => t.id !== id));
    if (activeTab === id) setActiveTab("explorer");
  };
  const activate = (id: string) => {
    setActiveTab(id);
    setFilter("");
  };
  const diffTitle = (l: FileRef, r: FileRef) => (refName(l) === refName(r) ? `⇄ ${refName(l)}` : `⇄ ${refName(l)} ↔ ${refName(r)}`);
  const tabs: TabInfo[] = [
    { id: "resources", title: "리소스", closable: false },
    { id: "explorer", title: "S3 탐색기", closable: false },
    ...explorerTabs.map((t) => ({ id: t.id, title: `S3: ${t.location.bucket}`, closable: true })),
    ...diffTabs.map((t) => ({ id: t.id, title: diffTitle(t.left, t.right), closable: true })),
  ];
  const diffTool: DiffTool = settings.diffTool ?? "filemerge";

  const changeProfile = (name: string) => {
    const info = profiles.data?.find((p) => p.name === name);
    const nextRegion = info?.region ?? region;
    setProfile(name);
    setRegion(nextRegion);
    // 버킷은 계정에 속하므로 버킷 탭과 비교 탭을 모두 닫는다.
    setExplorerTabs([]);
    setDiffTabs([]);
    if (activeTab.startsWith("s3:") || activeTab.startsWith("diff:")) setActiveTab("resources");
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
          onRefresh={refresh}
          active={activeTab === "resources"}
        />
      </div>
      <div className="tabpane" hidden={activeTab !== "explorer"}>
        <ExplorerTab
          profile={profile}
          region={region}
          s3Service={s3Service}
          filter={activeTab === "explorer" ? filter : ""}
          active={activeTab === "explorer"}
          initialLocalPath={settings.explorerLocalPath ?? null}
          onLocalPathChange={(path) => update({ explorerLocalPath: path })}
          transfers={transfers}
          onOpenDiff={openDiff}
          onRefresh={refresh}
        />
      </div>
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
        />
      )}
    </div>
  );
}
