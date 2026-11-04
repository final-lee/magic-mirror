import { useRef } from "react";
import { errorMessage } from "../api/errors";
import { ListFind, useListFind } from "../components/ListFind";
import { fuzzyKeep } from "../lib/fuzzy";
import { useTokenGate } from "./catalogHooks";
import { useEventSources, useSensors } from "./catalogQueries";
import { ARGO_EVENTS_MISSING } from "./text";
import type { ArgoWfConn, EventSourceRow, SensorRow, WfRow, WfTarget } from "./types";

interface FlowRow {
  key: string;
  source: string;
  event: string;
  dependency: string | null;
  trigger: string | null;
  workflows: WfRow[];
}

/** EventSource → 이벤트 → Sensor 의존성 → 트리거 → 그 트리거가 만든 Workflow. Sensor가 쓰지 않는 EventSource도 한 줄씩 */
function flowRows(sources: EventSourceRow[], sensors: SensorRow[], workflows: WfRow[]): FlowRow[] {
  const used = sensors.flatMap((sensor) =>
    sensor.dependencies.flatMap((dep) => {
      const source = sources.find((s) => s.namespace === sensor.namespace && s.name === dep.eventSourceName);
      return (sensor.triggers.length ? sensor.triggers : [null]).map((trigger) => ({
        key: `${sensor.namespace}/${sensor.name}/${dep.name}/${trigger?.name ?? ""}`,
        source: source?.name ?? dep.eventSourceName,
        event: dep.eventName,
        dependency: `${sensor.name}: ${dep.name}`,
        trigger: trigger?.name ?? null,
        workflows: workflows.filter(
          (w) =>
            w.namespace === sensor.namespace &&
            w.labels["events.argoproj.io/sensor"] === sensor.name &&
            (!trigger || w.labels["events.argoproj.io/trigger"] === trigger.name),
        ),
      }));
    }),
  );
  const unused = sources
    .filter(
      (source) => !sensors.some((sensor) => sensor.namespace === source.namespace && sensor.dependencies.some((dep) => dep.eventSourceName === source.name)),
    )
    .flatMap((source) =>
      (source.eventNames.length ? source.eventNames : ["—"]).map((event) => ({
        key: `${source.namespace}/${source.name}/${event}`,
        source: source.name,
        event,
        dependency: null,
        trigger: null,
        workflows: [],
      })),
    );
  return [...used, ...unused];
}

export function EventFlow({
  conn,
  live,
  namespace,
  workflows,
  onOpenWorkflow,
  onTokenError,
}: {
  conn: ArgoWfConn;
  live: boolean;
  namespace: string | null;
  workflows: WfRow[];
  onOpenWorkflow(t: WfTarget): void;
  onTokenError(m: string): void;
}) {
  const sources = useEventSources(conn, namespace, live);
  const sensors = useSensors(conn, namespace, live);
  useTokenGate([sources.error, sensors.error], onTokenError);
  const raw = sources.error ?? sensors.error;
  const error = raw ? (errorMessage(raw).includes(ARGO_EVENTS_MISSING) ? ARGO_EVENTS_MISSING : errorMessage(raw)) : null;
  const rows = flowRows(sources.data ?? [], sensors.data ?? [], workflows);
  const listRef = useRef<HTMLDivElement>(null);
  const find = useListFind(listRef);
  const visible = fuzzyKeep(rows, find.query, (row) => [row.source, row.event, row.dependency, row.trigger, ...row.workflows.map((w) => w.name)]);
  return (
    <div className="awc">
      <div className="awc-bar">
        <h2 className="awc-title">Event Flow</h2>
        <span className="dim">EventSource → 이벤트 → Sensor → 트리거 → Workflow</span>
      </div>
      <div className="awc-scroll" ref={listRef}>
        <ListFind find={find} count={visible.length} />
        {error ? (
          <div className="empty" role="alert">
            {error}
          </div>
        ) : sources.isPending || sensors.isPending ? (
          <div className="empty">불러오는 중…</div>
        ) : rows.length === 0 ? (
          <div className="empty">EventSource와 Sensor가 없어요</div>
        ) : visible.length === 0 ? (
          <div className="empty">맞는 항목이 없어요</div>
        ) : (
          <table className="k8s-table awc-table awc-flow">
            <thead>
              <tr>
                <th>Event Source</th>
                <th>이벤트</th>
                <th>Sensor 의존성</th>
                <th>트리거</th>
                <th>Workflows</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.key}>
                  <td className="mono">{r.source}</td>
                  <td>{r.event}</td>
                  <td>{r.dependency ?? <span className="dim">—</span>}</td>
                  <td>{r.trigger ?? <span className="dim">—</span>}</td>
                  <td>
                    {r.workflows.length === 0 && <span className="dim">—</span>}
                    {r.workflows.map((w) => (
                      <button
                        key={w.uid}
                        className="link mono awc-flow-wf"
                        onClick={() => onOpenWorkflow(w.archived ? { kind: "archived", uid: w.uid } : { kind: "live", namespace: w.namespace, name: w.name })}
                      >
                        {w.name}
                      </button>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
