import { useState } from "react";
import { useSettings } from "../api/queries";
import { ErrorState } from "../components/ErrorState";
import { usePrometheusCandidates, usePrometheusGraphs } from "./queries";
import * as t from "./text";
import type { K8sContainer, K8sObjectView, K8sTarget, ObjectRef, PrometheusEndpoint, PrometheusSeries } from "./types";

type Reference = { name: string; value: number; limit: boolean };
const COLORS = Array.from({ length: 8 }, (_, i) => `var(--log-c${i + 1})`);

/** 서비스 선택지와 저장된 서비스의 식별자. */
function endpointKey(endpoint: PrometheusEndpoint): string {
  return `${endpoint.namespace}/${endpoint.name}:${endpoint.port}`;
}

/** 상세가 읽은 요청·제한을 그래프 단위로 바꾼다. 워크로드는 Pod 템플릿 합계다. */
function references(containers: K8sContainer[], pod: boolean, cpu: boolean): Reference[] {
  const relevant = containers.filter((c) => !c.init && (pod ? c.state !== "template" : c.state === "template"));
  const result: Reference[] = [];
  if (!relevant.length) return result;
  for (const limit of [false, true]) {
    const values = relevant.map((c) => {
      const value = cpu ? (limit ? c.cpuLimit : c.cpuRequest) : (limit ? c.memoryLimit : c.memoryRequest);
      return { name: c.name, value: value == null ? null : cpu ? value / 1000 : value };
    });
    if (pod) {
      for (const item of values) {
        if (item.value !== null) result.push({ name: item.name, value: item.value, limit });
      }
    } else if (values.every((item) => item.value !== null)) {
      result.push({ name: "Pod", value: values.reduce((sum, item) => sum + (item.value ?? 0), 0), limit });
    }
  }
  return result;
}

/** 축의 같은 단위를 유지하면서 밀리코어 또는 MiB/GiB로 표시한다. */
function axisValue(value: number, max: number, cpu: boolean): string {
  const scale = cpu ? (max < 1 ? 1000 : 1) : (max >= 1024 ** 3 ? 1 / 1024 ** 3 : 1 / 1024 ** 2);
  const unit = cpu ? (max < 1 ? "m" : " 코어") : (max >= 1024 ** 3 ? " GiB" : " MiB");
  return `${(value * scale).toLocaleString(undefined, { maximumFractionDigits: 2 })}${unit}`;
}

/** 기간이 하루면 날짜도 넣고 그 밖에는 시각만 짧게 표시한다. */
function timeLabel(seconds: number, hours: number): string {
  const date = new Date(seconds * 1000);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (hours !== 24) return time;
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${time}`;
}

/** 시계열과 요청·제한을 같은 축 위에 그리고 범례와 눈금을 붙인다. */
function Chart({ title, series, refs, hours, cpu }: {
  title: string; series: PrometheusSeries[]; refs: Reference[]; hours: number; cpu: boolean;
}) {
  const points = series.flatMap((s) => s.values);
  if (!points.length) {
    return (
      <section>
        <h4>{title}</h4>
        <div className="empty small">{t.PROM_EMPTY}</div>
      </section>
    );
  }
  const end = Math.max(...points.map(([x]) => x));
  const start = end - hours * 3600;
  const max = Math.max(1e-12, ...points.map(([, value]) => value), ...refs.map((r) => r.value));
  const x = (value: number) => Math.max(0, Math.min(600, (value - start) / (end - start) * 600));
  const y = (value: number) => 150 - Math.max(0, value) / max * 150;
  return (
    <section className="k8s-usage-chart">
      <h4>{title}</h4>
      <div className="k8s-usage-plot">
        <div className="k8s-usage-y-axis dim">
          {[max, max / 2, 0].map((value, i) => <span key={i}>{axisValue(value, max, cpu)}</span>)}
        </div>
        <svg viewBox="0 0 600 150" preserveAspectRatio="none" role="img" aria-label={title}>
          {[0, 75, 150].map((position) => (
            <line key={position} className="k8s-usage-grid" x1="0" x2="600" y1={position} y2={position} />
          ))}
          {refs.map((ref) => {
            const index = series.findIndex((s) => s.name === ref.name);
            const color = index < 0 ? "var(--dim)" : COLORS[index % COLORS.length];
            return (
              <line
                key={`${ref.name}-${ref.limit}`}
                x1="0" x2="600" y1={y(ref.value)} y2={y(ref.value)}
                stroke={color} strokeDasharray={ref.limit ? "6 3" : "2 3"}
                vectorEffect="non-scaling-stroke"
              >
                <title>{`${ref.name} ${ref.limit ? t.PROM_LIMIT : t.PROM_REQUEST}: ${axisValue(ref.value, max, cpu)}`}</title>
              </line>
            );
          })}
          {series.map((item, i) => (
            <polyline
              key={item.name}
              points={item.values.map(([time, value]) => `${x(time)},${y(value)}`).join(" ")}
              fill="none" stroke={COLORS[i % COLORS.length]} strokeWidth="2" vectorEffect="non-scaling-stroke"
            >
              <title>{item.name}</title>
            </polyline>
          ))}
        </svg>
        <div className="k8s-usage-x-axis dim">
          <span>{timeLabel(start, hours)}</span>
          <span>{timeLabel(end, hours)}</span>
        </div>
      </div>
      <div className="k8s-usage-legend">
        {series.map((item, i) => (
          <span key={item.name}>
            <i className="k8s-usage-swatch" style={{ background: COLORS[i % COLORS.length] }} />
            {item.name}
          </span>
        ))}
      </div>
      {refs.length > 0 && (
        <div className="dim">
          {refs.map((ref) =>
            `${ref.name} ${ref.limit ? t.PROM_LIMIT : t.PROM_REQUEST}: ${axisValue(ref.value, max, cpu)}`,
          ).join(" · ")}
        </div>
      )}
    </section>
  );
}

/** Pod·워크로드 상세에서 Prometheus 서비스와 기간을 골라 사용량을 본다. */
export function UsageGraphs({ target, context, objectRef, view, live, ssoProfile }: {
  target: K8sTarget; context: string; objectRef: ObjectRef; view: K8sObjectView; live: boolean; ssoProfile: string;
}) {
  const { settings, update } = useSettings();
  const clusterKey = JSON.stringify([target.profile, target.region, target.cluster]);
  const saved = settings?.k8sPrometheus?.[clusterKey];
  const [hours, setHours] = useState(1);
  const [manual, setManual] = useState(false);
  const [namespace, setNamespace] = useState("");
  const [name, setName] = useState("");
  const [port, setPort] = useState("9090");
  const candidates = usePrometheusCandidates(target, context, ssoProfile, live);
  const server = saved ?? (candidates.data?.length === 1 ? candidates.data[0] : undefined);
  const graphs = usePrometheusGraphs(target, context, server, objectRef, hours, ssoProfile, live);
  const pod = objectRef.kind.kind === "Pod" && objectRef.kind.group === "";
  const validPort = Number.isInteger(Number(port)) && Number(port) >= 1 && Number(port) <= 65535;

  /** 선택을 대상별 설정에 기억한다. */
  function choose(endpoint: PrometheusEndpoint) {
    update({ k8sPrometheus: { ...settings?.k8sPrometheus, [clusterKey]: endpoint } });
    setManual(false);
  }

  return (
    <div className="k8s-usage">
      <p className="dim">{t.PROM_AMP}</p>
      {candidates.isError && (
        <ErrorState error={candidates.error} profile={ssoProfile} compact
          onRetry={() => void candidates.refetch()} onLoggedIn={() => void candidates.refetch()} />
      )}
      {candidates.isLoading && <div className="empty">{t.LOADING}</div>}
      {candidates.data?.length === 0 && !saved && <p>{t.PROM_NONE}</p>}
      {(candidates.data || saved) && (
        <label>
          {t.PROM_SERVER}{" "}
          <select
            value={server ? endpointKey(server) : ""}
            onChange={(event) => {
              const found = candidates.data?.find((candidate) => endpointKey(candidate) === event.target.value);
              if (found) choose(found);
            }}
          >
            <option value="">{t.PROM_SELECT}</option>
            {saved && !candidates.data?.some((candidate) => endpointKey(candidate) === endpointKey(saved)) && (
              <option value={endpointKey(saved)}>{endpointKey(saved)}</option>
            )}
            {candidates.data?.map((candidate) => (
              <option key={endpointKey(candidate)} value={endpointKey(candidate)}>{endpointKey(candidate)}</option>
            ))}
          </select>
        </label>
      )}
      <button className="btn tone-secondary" onClick={() => setManual(!manual)}>{t.PROM_MANUAL}</button>
      {manual && (
        <div className="k8s-usage-manual">
          <label>{t.PROM_NAMESPACE}<input value={namespace} onChange={(event) => setNamespace(event.target.value)} /></label>
          <label>{t.PROM_NAME}<input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>
            {t.PROM_PORT}
            <input type="number" min="1" max="65535" value={port} onChange={(event) => setPort(event.target.value)} />
          </label>
          <button
            className="btn tone-primary" disabled={!namespace || !name || !validPort}
            onClick={() => choose({ namespace, name, port: Number(port) })}
          >
            {t.PROM_SELECT}
          </button>
        </div>
      )}
      {server && (
        <label>
          {t.PROM_PERIOD}{" "}
          <select value={hours} onChange={(event) => setHours(Number(event.target.value))}>
            <option value={1}>1h</option>
            <option value={6}>6h</option>
            <option value={24}>24h</option>
          </select>
        </label>
      )}
      {graphs.isError && (
        <ErrorState error={graphs.error} profile={ssoProfile} compact
          onRetry={() => void graphs.refetch()} onLoggedIn={() => void graphs.refetch()} />
      )}
      {server && graphs.isLoading && <div className="empty">{t.LOADING}</div>}
      {graphs.data && (
        <>
          <Chart title={t.PROM_CPU} series={graphs.data.cpu} refs={references(view.containers, pod, true)} hours={hours} cpu />
          <Chart title={t.PROM_MEMORY} series={graphs.data.memory} refs={references(view.containers, pod, false)} hours={hours} cpu={false} />
        </>
      )}
    </div>
  );
}
