import { useState } from "react";
import { fuzzyKeep } from "../lib/fuzzy";
import { ApiPeersView } from "./ApiPeersView";
import { DeviceMap } from "./DeviceMap";
import * as deviceText from "./devicesText";
import { useTailscaleApi } from "./useTailscaleApi";
import { useDeviceView, useTailscaleTabs } from "./TabContext";
import * as t from "./text";
import type { TsNode, TsPeer } from "./types";

type Filter = "all" | "online" | "router" | "exit";

const filters: { id: Filter; label: string; match: (p: TsPeer) => boolean }[] = [
  { id: "all", label: t.ALL, match: () => true },
  { id: "online", label: t.ONLINE, match: (p) => p.online },
  { id: "router", label: t.SUBNET_ROUTER, match: (p) => p.routes.length > 0 },
  { id: "exit", label: t.EXIT_NODE, match: (p) => p.exitNodeOption },
];

const headers = [t.NAME, t.OS, t.IPS, t.STATE, t.CONNECTION, t.ROLE, t.TAGS, t.OWNER];

/** API를 연결하지 않았으면 이 Mac에서 보이는 기기만 보여준다. */
export function PeersView({ node, profile, region }: { node: TsNode; profile?: string | null; region?: string }) {
  const { tailnet, connected, isLoading } = useTailscaleApi();
  const tabs = useTailscaleTabs();
  if (isLoading) return <div className="empty">{t.PEERS_LOADING}</div>;
  if (connected && tailnet) return <ApiPeersView node={node} tailnet={tailnet} profile={profile} region={region} />;
  return <CliPeersView node={node} onConnect={() => tabs?.select("connect")} />;
}

function CliPeersView({ node, onConnect }: { node: TsNode; onConnect: () => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [view, setView] = useDeviceView();
  const searched = fuzzyKeep(node.peers, query, (p) => [p.hostName, p.dnsName, p.os, ...p.ips, ...p.routes, ...p.tags, p.owner, p.relay]);
  const shown = searched.filter(filters.find((f) => f.id === filter)!.match);
  return (
    <div className="argowf-list">
      <div className="awc-bar">
        <h2 className="awc-title">{t.TAB_PEERS}</h2>
        <span className="awc-stat">{t.ALL} <b>{node.peers.length}</b></span>
        <span className="awc-stat">{t.ONLINE} <b>{node.peers.filter((p) => p.online).length}</b></span>
        <input className="k8s-filter" aria-label={t.FILTER} placeholder={t.FILTER} value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="awc-bar-end">
          <button className="btn small" aria-pressed={view === "table"} onClick={() => setView("table")}>{deviceText.MAP_TABLE}</button>
          <button className="btn small" aria-pressed={view === "map"} onClick={() => setView("map")}>{deviceText.MAP}</button>
          <button className="btn small tone-nav" onClick={onConnect}>{t.API_REQUIRED_BUTTON}</button>
        </div>
      </div>
      <div className="argowf-filters">
        {filters.map((f) => (
          <button key={f.id} className="btn small" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
            {f.label} {searched.filter(f.match).length}
          </button>
        ))}
      </div>
      <p className="dim">{t.CLI_DESCRIPTION}</p>
      {view === "table" ? <div className="argowf-table-wrap">
        <table className="argowf-table">
          <thead>
            <tr>
              {headers.map((label) => (
                <th key={label}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((p, i) => (
              <tr key={`${p.dnsName}-${i}`}>
                <td>
                  <strong>{p.hostName}</strong>
                  <div className="dim">{p.dnsName}</div>
                </td>
                <td>{p.os || t.UNKNOWN}</td>
                <td>
                  {[...p.ips]
                    .sort((a, b) => Number(a.includes(":")) - Number(b.includes(":")))
                    .map((ip) => (
                      <div key={ip}>{ip}</div>
                    ))}
                </td>
                <td>
                  <span className={`argowf-phase ${p.online ? "Succeeded" : ""}`}>● {p.online ? t.ONLINE : t.OFFLINE}</span>
                  {!p.online && p.lastSeen && <div className="dim">{t.lastSeen(p.lastSeen)}</div>}
                </td>
                <td>{p.online ? (p.curAddr ? t.DIRECT : t.relay(p.relay || t.UNKNOWN)) : "—"}</td>
                <td>
                  {p.routes.length > 0 && (
                    <span className="k8s-chip" title={p.routes.join(", ")}>
                      {t.SUBNET_ROUTER}: {p.routes.join(", ")}
                    </span>
                  )}{" "}
                  {p.exitNodeOption && <span className="k8s-chip">{t.EXIT_NODE}</span>}{" "}
                  {p.exitNode && <span className="k8s-chip">{t.ACTIVE_EXIT}</span>}
                </td>
                <td>{p.tags.join(", ") || "—"}</td>
                <td>{p.owner || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div> : <DeviceMap devices={shown.map((p, i) => ({
        id: `${p.dnsName}-${i}`, name: p.dnsName, hostname: p.hostName, os: p.os, addresses: p.ips,
        tags: p.tags, user: p.owner ?? undefined, advertisedRoutes: p.routes, findings: [],
      }))} peers={node.peers} self={node.cli ? node.self : null}
        onShowTable={(name) => { setQuery(name); setFilter("all"); setView("table"); }} />}
      {shown.length === 0 && <p className="empty small">{t.NO_MATCH}</p>}
      <p className="dim ts-note">{t.ACL_NOTE}</p>
    </div>
  );
}
