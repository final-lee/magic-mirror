import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "./api/errors";
import { useAccount, useProfiles, useServices, useSettings } from "./api/queries";
import type { Favorite } from "./api/types";
import { MainArea } from "./components/MainArea";
import { NoProfiles } from "./components/NoProfiles";
import { ServiceSettings } from "./components/ServiceSettings";
import { Sidebar } from "./components/Sidebar";
import { Toolbar } from "./components/Toolbar";
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
  const [s3, setS3] = useState<S3Location | null>(null);
  const [filter, setFilter] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);
  const account = useAccount(profile);

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

  const changeProfile = (name: string) => {
    const info = profiles.data?.find((p) => p.name === name);
    const nextRegion = info?.region ?? region;
    setProfile(name);
    setRegion(nextRegion);
    setS3(null);
    update({ lastProfile: name, lastRegion: nextRegion });
  };

  const changeRegion = (r: string) => {
    setRegion(r);
    setS3(null);
    update({ lastRegion: r });
  };

  const select = (sel: Favorite) => {
    setSelection(sel);
    setS3(null);
    setFilter("");
  };

  const toggleFavorite = (sel: Favorite) => {
    const exists = settings.favorites.some((f) => sameFav(f, sel));
    update({ favorites: exists ? settings.favorites.filter((f) => !sameFav(f, sel)) : [...settings.favorites, sel] });
  };

  const mainKey = [profile, region, selection?.service, selection?.type, s3?.bucket, s3?.prefix].join("|");

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
      <div className="main">
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
          s3={s3}
          onS3Change={setS3}
          onRefresh={refresh}
        />
      </div>
      {showSettings && (
        <ServiceSettings
          services={services.data}
          enabled={settings.enabledServices}
          onChange={(ids) => update({ enabledServices: ids })}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
