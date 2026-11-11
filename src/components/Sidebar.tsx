import { useEffect, useState, type ReactNode } from "react";
import { useResources } from "../api/queries";
import type { Favorite, ResourceType, ServiceInfo } from "../api/types";
import { ARGOCD_TITLE } from "../argocd/text";
import { ARGOWF_TITLE } from "../argowf/text";
import { COST_NAV, COST_TITLE } from "../cost/text";
import { ACCOUNT_OPEN } from "../sns/accessText";
import { ordered, savedAfterMove, useReorder, type Reorder } from "../lib/useReorder";
import tailscaleMark from "../assets/tailscale.svg";
import { ServiceBadge } from "./ServiceBadge";

interface Props {
  services: ServiceInfo[];
  profile: string | null;
  region: string;
  selection: Favorite | null;
  favorites: Favorite[];
  onSelect: (sel: Favorite) => void;
  onToggleFavorite: (sel: Favorite) => void;
  /** 끌어 바꾼 서비스 순서(서비스 ID). 비어 있으면 `services` 순서 */
  serviceOrder?: string[];
  /** 서비스 ID → 그 서비스 아래 줄의 끌어 바꾼 순서(리소스 종류 ID와 `@` 바로가기) */
  typeOrder?: Record<string, string[]>;
  onServiceOrderChange: (ids: string[]) => void;
  onTypeOrderChange: (service: string, keys: string[]) => void;
  /** 즐겨찾기를 끌어 바꾼 순서로 돌려준다 */
  onFavoritesChange: (favorites: Favorite[]) => void;
  /** IAM 작업 공간 탭을 연다. 주면 IAM 서비스 아래 첫 항목으로 "IAM 관리"가 보인다. */
  onOpenIam?: () => void;
  /** 📣 SNS 계정 개요 탭을 연다. 주면 SNS 서비스 아래 첫 항목으로 "📣 SNS 개요"가 보인다. */
  onOpenSnsAccount?: () => void;
  /** 💰 비용 탭을 연다. 주면 서비스 묶음 위에 "💰 비용" 줄이 보인다. */
  onOpenCost?: () => void;
  /** Tailscale을 리소스 탭의 오른쪽 칸에 연다. 주면 💰 비용 아래에 "Tailscale" 줄이 보인다. */
  onOpenTailscale?: () => void;
  /** 오른쪽 칸이 지금 Tailscale이면 그 줄을 고른 줄로 보인다 */
  tailscaleActive?: boolean;
  /** 🐙 ArgoCD 탭을 연다. 주면 EKS 서비스 아래 리소스 종류 뒤에 "🐙 ArgoCD"가 보인다. */
  onOpenArgocd?: () => void;
  onOpenArgoWorkflows?: () => void;
}

/** 서비스 아래 한 줄. key는 리소스 종류 ID, 바로가기는 `@`로 시작한다. */
interface Entry {
  key: string;
  node: ReactNode;
}

const favKey = (f: Favorite) => `${f.service}/${f.type}`;

/**
 * 첫 열: 즐겨찾기, 비용, 서비스와 그 아래 리소스 종류. 즐겨찾기·서비스·서비스 아래 줄은 각각 끌어서 순서를 바꾼다.
 * 기본 순서는 단위가 큰 것부터다. 백엔드가 클러스터처럼 큰 단위의 종류를 먼저 주고, 바로가기는 IAM 관리만 앞에 둔다.
 */
export function Sidebar({
  services, profile, region, selection, favorites, onSelect, onToggleFavorite,
  serviceOrder, typeOrder, onServiceOrderChange, onTypeOrderChange, onFavoritesChange,
  onOpenIam, onOpenSnsAccount, onOpenCost, onOpenTailscale, tailscaleActive = false, onOpenArgocd, onOpenArgoWorkflows,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(selection ? [selection.service] : []));

  // ⌘K처럼 사이드바 밖에서 고른 종류도 보이게 그 서비스를 편다
  const selectedService = selection?.service;
  useEffect(() => {
    if (selectedService) setExpanded((prev) => (prev.has(selectedService) ? prev : new Set(prev).add(selectedService)));
  }, [selectedService]);

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

  const favRows = favorites.flatMap((fav) => {
    const svc = services.find((s) => s.id === fav.service);
    const type = svc?.types.find((t) => t.id === fav.type);
    return svc && type ? [{ fav, svc, type }] : [];
  });
  // 꺼 둔 서비스의 즐겨찾기는 보이지 않아도 자리를 지킨다
  const favDrag = useReorder(favRows.length, (from, to) => {
    const keys = savedAfterMove(favorites.map(favKey), favRows.map((r) => favKey(r.fav)), from, to);
    onFavoritesChange(keys.map((k) => favorites.find((f) => favKey(f) === k)!));
  });

  const shown = ordered(services, (s) => s.id, serviceOrder);
  const serviceDrag = useReorder(shown.length, (from, to) =>
    onServiceOrderChange(savedAfterMove(serviceOrder, shown.map((s) => s.id), from, to)),
  );

  const rowProps = { profile, region, onSelect: select, onToggleFavorite };

  const shortcut = (key: string, className: string, label: string, open: () => void): Entry => ({
    key,
    node: (
      <div className={`typ ${className}`} role="button" onClick={() => open()}>
        <span>{label}</span>
      </div>
    ),
  });
  const entriesOf = (svc: ServiceInfo): Entry[] => {
    const types = svc.types.map((t) => ({
      key: t.id,
      node: <TypeRow label={t.name} service={svc} type={t} fetch selected={isSelected(svc, t)} {...rowProps} />,
    }));
    if (svc.id === "iam" && onOpenIam) return [shortcut("@iam", "iam-open", "🔐 IAM 관리", onOpenIam), ...types];
    if (svc.id === "sns" && onOpenSnsAccount) return [shortcut("@sns", "sns-open", ACCOUNT_OPEN, onOpenSnsAccount), ...types];
    if (svc.id === "eks") {
      // 클러스터·노드 그룹이 먼저고, 클러스터 위에서 도는 도구는 그 뒤에 둔다
      const tools: Entry[] = [];
      if (onOpenArgocd) tools.push(shortcut("@argocd", "argocd-open", ARGOCD_TITLE, onOpenArgocd));
      if (onOpenArgoWorkflows) tools.push(shortcut("@argowf", "argocd-open", ARGOWF_TITLE, onOpenArgoWorkflows));
      return [...types, ...tools];
    }
    return types;
  };

  return (
    <nav className="side" aria-label="서비스">
      {favRows.length > 0 && (
        <>
          <div className="grp">즐겨찾기</div>
          {favDrag.preview.map((i) => {
            const { svc, type } = favRows[i];
            return (
              <DragItem key={`fav-${svc.id}-${type.id}`} reorder={favDrag} index={i}>
                <TypeRow label={`${svc.name} › ${type.name}`} service={svc} type={type} fetch={false} selected={false} fav {...rowProps} />
              </DragItem>
            );
          })}
        </>
      )}
      {onOpenCost && (
        <div className="typ cost-open" role="button" aria-label={COST_TITLE} onClick={() => onOpenCost()}>
          <span className="cost-open-label">
            <ServiceBadge service={{ id: "cost", name: COST_NAV }} />
            {COST_NAV}
          </span>
        </div>
      )}
      {onOpenTailscale && (
        <div
          className={`typ cost-open${tailscaleActive ? " on" : ""}`}
          role="button"
          aria-label="Tailscale"
          aria-current={tailscaleActive || undefined}
          onClick={onOpenTailscale}
        >
          <span className="cost-open-label"><img className="badge badge-icon" src={tailscaleMark} alt="" />Tailscale</span>
        </div>
      )}
      <div className="grp">서비스</div>
      {serviceDrag.preview.map((i) => {
        const svc = shown[i];
        return (
          <ServiceGroup
            key={svc.id}
            svc={svc}
            open={expanded.has(svc.id)}
            onToggle={() => toggle(svc.id)}
            reorder={serviceDrag}
            index={i}
            entries={entriesOf(svc)}
            saved={typeOrder?.[svc.id]}
            onOrderChange={(keys) => onTypeOrderChange(svc.id, keys)}
          />
        );
      })}
    </nav>
  );
}

/** 끌어 옮길 수 있는 한 줄. 끌기를 마친 직후의 click은 안쪽 줄에 닿지 않는다. */
function DragItem({ reorder, index, children }: { reorder: Reorder; index: number; children: ReactNode }) {
  return (
    <div
      className={`side-item${reorder.dragged === index ? " dragging" : ""}`}
      {...reorder.itemProps(index)}
      onClickCapture={(e) => {
        if (reorder.consumeClick()) e.stopPropagation();
      }}
    >
      {children}
    </div>
  );
}

interface GroupProps {
  svc: ServiceInfo;
  open: boolean;
  onToggle: () => void;
  /** 서비스 목록의 끌기. 서비스 이름 줄을 잡아야 서비스가 움직인다. */
  reorder: Reorder;
  index: number;
  entries: Entry[];
  saved: string[] | undefined;
  onOrderChange: (keys: string[]) => void;
}

function ServiceGroup({ svc, open, onToggle, reorder, index, entries, saved, onOrderChange }: GroupProps) {
  const list = ordered(entries, (e) => e.key, saved);
  const rows = useReorder(list.length, (from, to) => onOrderChange(savedAfterMove(saved, list.map((e) => e.key), from, to)));
  const { ref, onMouseDown } = reorder.itemProps(index);
  return (
    <div ref={ref} className={`side-item${reorder.dragged === index ? " dragging" : ""}`}>
      <div
        className="svc"
        role="button"
        onMouseDown={onMouseDown}
        onClick={() => {
          if (!reorder.consumeClick()) onToggle();
        }}
      >
        <span className="tw">{open ? "▼" : "▶"}</span>
        <ServiceBadge service={svc} />
        {svc.name}
      </div>
      {open &&
        rows.preview.map((i) => (
          <DragItem key={list[i].key} reorder={rows} index={i}>
            {list[i].node}
          </DragItem>
        ))}
    </div>
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
