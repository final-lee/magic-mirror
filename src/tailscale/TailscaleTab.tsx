import { useQuery } from "@tanstack/react-query";
import { Fragment, useMemo, useState, type ComponentType } from "react";
import { ErrorState } from "../components/ErrorState";
import { tailscaleApi } from "./api";
import { ConnectView } from "./ConnectView";
import { DiagnoseView } from "./DiagnoseView";
import { DnsView } from "./DnsView";
import * as dnsText from "./dnsText";
import { MacView, value } from "./MacView";
import { PeersView } from "./PeersView";
import { PolicyView } from "./PolicyView";
import { RoutesView } from "./RoutesView";
import { ServicesView } from "./ServicesView";
import * as servicesText from "./servicesText";
import { OrgView } from "./OrgView";
import * as orgText from "./orgText";
import { IntegrationsView } from "./IntegrationsView";
import * as integrationsText from "./integrationsText";
import { SettingsView } from "./SettingsView";
import * as settingsText from "./settingsText";
import { UsersView } from "./UsersView";
import * as usersText from "./usersText";
import { KeysView } from "./KeysView";
import * as k from "./keysText";
import { LogsView } from "./LogsView";
import * as l from "./logsText";
import { ShareView } from "./ShareView";
import * as shareText from "./shareText";
import { TailscaleTabsProvider, type DeviceView, type TailscaleTabId } from "./TabContext";
import * as t from "./text";
import type { TsNode } from "./types";

type ViewProps = { node: TsNode; profile?: string | null; region?: string };

/**
 * 왼쪽 메뉴. 묶음(group)이 바뀌는 자리에 구분선을 긋는다:
 * 1 상태·사람(이 Mac·기기·사용자) · 2 네트워크(경로·Services·DNS·정책) · 3 보안·운영(키·로그·연동)
 * · 4 이 Mac의 도구(공유·진단) · 5 관리(설정·연결·조직)
 */
const views: { id: TailscaleTabId; label: string; group: number; View: ComponentType<ViewProps> }[] = [
  { id: "mac", label: t.TAB_MAC, group: 1, View: MacView },
  { id: "peers", label: t.TAB_PEERS, group: 1, View: PeersView },
  { id: "users", label: usersText.TITLE, group: 1, View: UsersView },
  { id: "routes", label: t.ROUTES_TITLE, group: 2, View: RoutesView },
  { id: "services", label: servicesText.TITLE, group: 2, View: ServicesView },
  { id: "dns", label: dnsText.TITLE, group: 2, View: DnsView },
  { id: "policy", label: t.TAB_POLICY, group: 2, View: PolicyView },
  { id: "keys", label: k.TAB_KEYS, group: 3, View: KeysView },
  { id: "logs", label: l.TAB_LOGS, group: 3, View: LogsView },
  { id: "integrations", label: integrationsText.TITLE, group: 3, View: IntegrationsView },
  { id: "share", label: shareText.TITLE, group: 4, View: ShareView },
  { id: "diagnosis", label: t.TAB_DIAGNOSIS, group: 4, View: DiagnoseView },
  { id: "settings", label: settingsText.TITLE, group: 5, View: SettingsView },
  { id: "connect", label: t.TAB_CONNECT, group: 5, View: ConnectView },
  { id: "org", label: orgText.TITLE, group: 5, View: OrgView },
];
const CLI_VIEWS: TailscaleTabId[] = ["mac", "share", "diagnosis"];

export function TailscaleTab({ active, profile, region }: { active: boolean; profile?: string | null; region?: string }) {
  const [tab, setTab] = useState<TailscaleTabId>("mac");
  const [deviceView, setDeviceView] = useState<DeviceView>("table");
  const tabs = useMemo(() => ({ select: setTab, deviceView, setDeviceView }), [deviceView]);
  const node = useQuery({
    queryKey: ["tailscale", "node"],
    queryFn: tailscaleApi.node,
    enabled: active,
    refetchInterval: active ? 10_000 : false,
    retry: false,
  });
  if (node.isError) return <ErrorState error={node.error} profile="" onRetry={() => void node.refetch()} />;
  if (!node.data) return <div className="empty">{t.LOADING}</div>;
  const data = node.data;
  const { View } = views.find((view) => view.id === tab)!;
  return (
    <TailscaleTabsProvider value={tabs}>
      <div className="argo argowf">
        <header className="argo-bar argo-top">
          <strong>{value(data.tailnet)}</strong>
          <span>{value(data.self?.hostName)}</span>
          <span className="argo-session mono">{value(data.user)}</span>
          <span title={value(data.backendState)}>{t.backendState(data.backendState)}</span>
        </header>
        <div className="argowf-workspace">
          <nav className="argowf-menu" aria-label={t.TABS_LABEL}>
            {views.map((view, index) => (
              <Fragment key={view.id}>
                {index > 0 && views[index - 1].group !== view.group && <div className="argowf-nav-gap" role="separator" />}
                <button className="argowf-nav-item" aria-pressed={tab === view.id} onClick={() => setTab(view.id)}>
                  {view.label}
                </button>
              </Fragment>
            ))}
          </nav>
          <main className="argowf-content">
            {!data.cli && CLI_VIEWS.includes(tab) ? <div className="empty">{t.CLI_MISSING}</div> : <View node={data} profile={profile} region={region} />}
          </main>
        </div>
      </div>
    </TailscaleTabsProvider>
  );
}
