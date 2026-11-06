import { useState } from "react";
import { errorMessage } from "../../api/errors";
import { useApps } from "../queries";
import type { ArgoAppRow } from "../types";
import { ControllerPanel } from "./ControllerPanel";
import { DeployPanel } from "./DeployPanel";
import { DriftPanel } from "./DriftPanel";
import { ImagesPanel } from "./ImagesPanel";
import { SettingsPanel } from "./SettingsPanel";
import { METRICS_TEXT as T } from "./text";
import { UsagePanel } from "./UsagePanel";
import "./metrics.css";

type Tab = "deploy" | "drift" | "images" | "usage" | "controller" | "settings";
const TABS: Tab[] = ["deploy", "drift", "images", "usage", "controller", "settings"];

/** 지표 화면: 배포 지표, 드리프트, 이미지 목록, 앱 리소스 사용량, ArgoCD 자체 상태, 설정(지표·알림) */
export function MetricsView({ url, live, onOpen }: { url: string; live: boolean; onOpen: (row: ArgoAppRow) => void }) {
  const [tab, setTab] = useState<Tab>("deploy");
  const apps = useApps(url, live);
  const rows = apps.data ?? [];
  return (
    <div className="argo-metrics">
      <div className="k8s-tabs" role="tablist" aria-label={T.tabs}>
        {TABS.map((t) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{T[t]}</button>)}
      </div>
      {apps.isError && <div className="empty err">{errorMessage(apps.error)}</div>}
      {apps.isPending && <div className="empty">{T.loading}</div>}
      {apps.data && tab === "deploy" && <DeployPanel url={url} rows={rows} />}
      {apps.data && tab === "drift" && <DriftPanel url={url} rows={rows} onOpen={onOpen} />}
      {apps.data && tab === "images" && <ImagesPanel url={url} rows={rows} onOpen={onOpen} />}
      {apps.data && tab === "usage" && <UsagePanel url={url} rows={rows} live={live} onOpen={onOpen} />}
      {tab === "controller" && <ControllerPanel url={url} live={live} onSettings={() => setTab("settings")} />}
      {tab === "settings" && <SettingsPanel url={url} />}
    </div>
  );
}
