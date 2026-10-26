import { useState } from "react";
import { useResources } from "../api/queries";
import type { Favorite, ResourceType, ServiceInfo } from "../api/types";
import { ServiceBadge } from "./ServiceBadge";

interface Props {
  services: ServiceInfo[];
  profile: string | null;
  region: string;
  selection: Favorite | null;
  favorites: Favorite[];
  onSelect: (sel: Favorite) => void;
  onToggleFavorite: (sel: Favorite) => void;
}

export function Sidebar({ services, profile, region, selection, favorites, onSelect, onToggleFavorite }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(selection ? [selection.service] : []));

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const select = (sel: Favorite) => {
    setExpanded((prev) => new Set(prev).add(sel.service));
    onSelect(sel);
  };

  const isSelected = (svc: ServiceInfo, t: ResourceType) =>
    selection?.service === svc.id && selection?.type === t.id;

  const favRows = favorites.flatMap((f) => {
    const svc = services.find((s) => s.id === f.service);
    const type = svc?.types.find((t) => t.id === f.type);
    return svc && type ? [{ svc, type }] : [];
  });

  const rowProps = { profile, region, onSelect: select, onToggleFavorite };

  return (
    <nav className="side" aria-label="서비스">
      {favRows.length > 0 && (
        <>
          <div className="grp">즐겨찾기</div>
          {favRows.map(({ svc, type }) => (
            <TypeRow
              key={`fav-${svc.id}-${type.id}`}
              label={`${svc.name} › ${type.name}`}
              service={svc}
              type={type}
              fetch={false}
              selected={false}
              fav
              {...rowProps}
            />
          ))}
        </>
      )}
      <div className="grp">서비스</div>
      {services.map((svc) => (
        <div key={svc.id}>
          <div className="svc" role="button" onClick={() => toggle(svc.id)}>
            <span className="tw">{expanded.has(svc.id) ? "▼" : "▶"}</span>
            <ServiceBadge service={svc} />
            {svc.name}
          </div>
          {expanded.has(svc.id) &&
            svc.types.map((t) => (
              <TypeRow key={t.id} label={t.name} service={svc} type={t} fetch selected={isSelected(svc, t)} {...rowProps} />
            ))}
        </div>
      ))}
    </nav>
  );
}

interface RowProps {
  label: string;
  service: ServiceInfo;
  type: ResourceType;
  fetch: boolean;
  selected: boolean;
  fav?: boolean;
  profile: string | null;
  region: string;
  onSelect: (sel: Favorite) => void;
  onToggleFavorite: (sel: Favorite) => void;
}

function TypeRow({ label, service, type, fetch, selected, fav, profile, region, onSelect, onToggleFavorite }: RowProps) {
  const q = useResources(profile, region, service, type.id, fetch);
  const count = q.data
    ? `${q.data.items.length}${q.data.truncated ? "+" : ""}`
    : q.isError
      ? "—"
      : q.isFetching
        ? "…"
        : "";
  const sel = { service: service.id, type: type.id };
  return (
    <div
      className={`typ${fav ? " fav" : ""}${selected ? " on" : ""}`}
      role="button"
      aria-current={selected || undefined}
      title="우클릭: 즐겨찾기 추가/제거"
      onClick={() => onSelect(sel)}
      onContextMenu={(e) => {
        e.preventDefault();
        onToggleFavorite(sel);
      }}
    >
      <span>{label}</span>
      <span className="count">{count}</span>
    </div>
  );
}
