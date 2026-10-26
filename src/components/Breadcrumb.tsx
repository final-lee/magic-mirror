import type { ServiceInfo } from "../api/types";
import { ServiceBadge } from "./ServiceBadge";

export interface Segment {
  label: string;
  onClick?: () => void;
}

export function Breadcrumb({ service, segments, count }: { service: ServiceInfo; segments: Segment[]; count?: number }) {
  return (
    <div className="crumb">
      <ServiceBadge service={service} />
      <span>{service.name}</span>
      {segments.map((s, i) => (
        <span key={i}>
          {" › "}
          {s.onClick ? (
            <button className="link crumb-link" onClick={s.onClick}>
              {s.label}
            </button>
          ) : (
            <b>{s.label}</b>
          )}
        </span>
      ))}
      {count !== undefined && <span className="crumb-count">{count}개</span>}
    </div>
  );
}
