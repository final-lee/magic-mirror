import { age } from "../../k8s/format";
import { H_COUNT, H_KIND, H_MESSAGE, H_REASON, H_TIME } from "../../k8s/text";
import type { ResourceEvent } from "../types";
import { EVENTS_LABEL, RES_NO_EVENTS } from "./text";

/** 리소스의 Kubernetes 이벤트(최근 것부터 온 순서 그대로). Warning은 눈에 띄게 한다. */
export function EventsTable({ events, now }: { events: ResourceEvent[]; now: number }) {
  if (events.length === 0) return <p className="dim">{RES_NO_EVENTS}</p>;
  return (
    <table className="k8s-table" aria-label={EVENTS_LABEL}>
      <thead>
        <tr>
          <th>{H_TIME}</th>
          <th>{H_KIND}</th>
          <th>{H_REASON}</th>
          <th>{H_MESSAGE}</th>
          <th>{H_COUNT}</th>
        </tr>
      </thead>
      <tbody>
        {events.map((e, i) => (
          <tr key={i} className={e.type === "Warning" ? "k8s-warn" : undefined}>
            <td title={e.lastSeen ?? ""}>{age(e.lastSeen, now)}</td>
            <td>{e.type}</td>
            <td>{e.reason}</td>
            <td className="k8s-wrap">{e.message}</td>
            <td>{e.count}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
