import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage } from "../api/errors";
import { useResources } from "../api/queries";
import type { Resource } from "../api/types";
import { ApiRequired } from "./ApiRequired";
import { coverage, EXIT_ROUTES, isExitRoute } from "./coverage";
import { DeviceChange } from "./DeviceChange";
import { devicesApi } from "./api";
import type { Device, Preview } from "./devicesApi";
import * as text from "./devicesText";
import * as t from "./text";
import { useTailscaleApi } from "./useTailscaleApi";

const vpcService = { id: "vpc", name: "VPC", global: false, types: [] };

export function RoutesView({ profile, region }: { profile?: string | null; region?: string }) {
  const { tailnet, connected, isLoading } = useTailscaleApi();
  if (isLoading) return <div className="empty">{text.CONNECTION_LOADING}</div>;
  if (!connected || !tailnet) return <ApiRequired title={t.ROUTES_TITLE} />;
  return <Routes tailnet={tailnet} profile={profile ?? null} region={region ?? "us-east-1"} />;
}

function Routes({ tailnet, profile, region }: { tailnet: string; profile: string | null; region: string }) {
  const qc = useQueryClient();
  const devices = useQuery({
    queryKey: ["tailscale", "devices", tailnet],
    queryFn: () => devicesApi.list(tailnet),
    retry: false,
  });
  const vpcs = useResources(profile, region, vpcService, "vpcs");
  const [plan, setPlan] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function approve(device: Device, routes: string[]) {
    setBusy(true);
    setError("");
    try {
      const enabled = Array.from(new Set([...(device.enabledRoutes ?? []), ...routes]));
      setPlan(await devicesApi.preview(tailnet, [device.id], "routes", enabled));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const routers = (devices.data ?? []).filter((d) => (d.advertisedRoutes?.length ?? 0) > 0 || (d.enabledRoutes?.length ?? 0) > 0);
  const approved = routers.flatMap((d) => (d.enabledRoutes ?? []).filter((route) => !isExitRoute(route)));
  return (
    <div className="argowf-list">
      <div className="awc-bar">
        <h2 className="awc-title">{text.ROUTES_TITLE}</h2>
        <span className="awc-stat">{text.DEVICE} <b>{routers.length}</b></span>
        <div className="awc-bar-end"><button className="btn small" onClick={() => void devices.refetch()}>{t.REFRESH}</button></div>
      </div>
      <div className="awc-scroll">
        <div className="awc-filters">{text.ROUTES_DESCRIPTION}</div>
        {devices.isLoading && <div className="awc-filters">{text.ROUTES_LOADING}</div>}
        {devices.error && <p className="err awc-note" role="alert">{errorMessage(devices.error)}</p>}
        {error && <p className="err awc-note" role="alert">{error}</p>}
        <RouteTable routers={routers} busy={busy} onApprove={(device, routes) => void approve(device, routes)} />
        {profile && (
          <VpcCoverage
            profile={profile}
            region={region}
            vpcs={vpcs.data?.items}
            loading={vpcs.isLoading}
            error={vpcs.error}
            approved={approved}
          />
        )}
      </div>
      {plan && (
        <DeviceChange
          tailnet={tailnet}
          preview={plan}
          onClose={() => setPlan(null)}
          onDone={() => void qc.invalidateQueries({ queryKey: ["tailscale", "devices", tailnet] })}
        />
      )}
    </div>
  );
}

function RouteTable({ routers, busy, onApprove }: { routers: Device[]; busy: boolean; onApprove: (device: Device, routes: string[]) => void }) {
  return (
    <table className="argowf-table">
      <thead><tr><th>{text.DEVICE}</th><th>{text.ADVERTISED}</th><th>{text.AUTHORIZE}</th><th /></tr></thead>
      <tbody>
        {routers.flatMap((device) => {
          const advertised = device.advertisedRoutes ?? [];
          const enabled = device.enabledRoutes ?? [];
          const routes = Array.from(new Set([...advertised, ...enabled]));
          const rows = routes.filter((route) => !isExitRoute(route)).map((route) => ({
            key: route, label: route, advertised: advertised.includes(route), enabled: enabled.includes(route), routes: [route],
          }));
          // exit node는 두 경로(0.0.0.0/0, ::/0)를 한 줄로 보이고 함께 승인한다
          if (routes.some(isExitRoute)) rows.push({
            key: "exit", label: text.EXIT_NODE, advertised: advertised.some(isExitRoute),
            enabled: EXIT_ROUTES.every((route) => enabled.includes(route)), routes: EXIT_ROUTES,
          });
          return rows.map((row) => (
            <tr key={`${device.id}-${row.key}`}>
              <td>{device.name}</td>
              <td>{row.advertised ? row.label : text.NONE}</td>
              <td>{row.enabled ? row.label : text.PENDING}</td>
              <td>
                {row.advertised && !row.enabled && (
                  <button className="btn small" disabled={busy} onClick={() => onApprove(device, row.routes)}>
                    {text.AUTHORIZE}
                  </button>
                )}
              </td>
            </tr>
          ));
        })}
      </tbody>
    </table>
  );
}

function VpcCoverage({ profile, region, vpcs, loading, error, approved }: {
  profile: string; region: string; vpcs: Resource[] | undefined; loading: boolean; error: unknown; approved: string[];
}) {
  return (
    <>
      <div className="awc-bar">
        <h2 className="awc-title">{text.VPC_TITLE}</h2>
        <span className="awc-stat">{text.vpcDescription(profile, region)}</span>
      </div>
      {loading && <div className="awc-filters">{text.VPC_LOADING}</div>}
      {!!error && <p className="err awc-note" role="alert">{errorMessage(error)}</p>}
      <table className="argowf-table">
        <thead><tr><th>{text.VPC}</th><th>{text.CIDR}</th><th>{text.COVERAGE}</th></tr></thead>
        <tbody>
          {vpcs?.map((v) => (
            <tr key={v.id}><td>{v.name}</td><td>{v.values.cidr}</td><td>{coverage(v.values.cidr ?? "", approved)}</td></tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
