import { BadgeList } from "./Badges";
import { formatAgo, formatDay } from "./format";
import { ListTable, type ListColumn } from "./ListTable";
import type { PrincipalKind, PrincipalSummary } from "./types";

const timeOf = (iso: string | null) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : t;
};

const NAME: ListColumn<PrincipalSummary> = {
  key: "name",
  label: "이름",
  sort: (p) => p.name,
  render: (p) => (
    <>
      <span className="iam-name">{p.name}</span>
      {p.path !== "/" && <span className="iam-path mono">{p.path}</span>}
    </>
  ),
};
const BADGES: ListColumn<PrincipalSummary> = { key: "badges", label: "상태", render: (p) => <BadgeList badges={p.badges} /> };
const LAST_USED: ListColumn<PrincipalSummary> = {
  key: "lastUsed",
  label: "마지막 사용",
  sort: (p) => timeOf(p.lastUsed),
  render: (p) =>
    p.lastUsed ? (
      <>
        <span>{formatDay(p.lastUsed)}</span> <span className="dim">{formatAgo(p.lastUsed)}</span>
      </>
    ) : (
      <span className="dim">기록 없음</span>
    ),
};
const MEMBERS: ListColumn<PrincipalSummary> = {
  key: "members",
  label: "구성원",
  numeric: true,
  sort: (p) => p.memberCount,
  render: (p) => p.memberCount ?? "—",
};
const POLICIES: ListColumn<PrincipalSummary> = {
  key: "policies",
  label: "정책",
  numeric: true,
  sort: (p) => p.policyCount,
  render: (p) => p.policyCount,
};

const COLUMNS: Record<PrincipalKind, ListColumn<PrincipalSummary>[]> = {
  user: [NAME, BADGES, LAST_USED, POLICIES],
  group: [NAME, BADGES, MEMBERS, POLICIES],
  role: [NAME, BADGES, LAST_USED, POLICIES],
};

const TEXT: Record<PrincipalKind, { label: string; empty: string; noMatch: string }> = {
  user: { label: "사용자 목록", empty: "사용자가 없어요", noMatch: "조건에 맞는 사용자가 없어요" },
  group: { label: "그룹 목록", empty: "그룹이 없어요", noMatch: "조건에 맞는 그룹이 없어요" },
  role: { label: "역할 목록", empty: "역할이 없어요", noMatch: "조건에 맞는 역할이 없어요" },
};

/** 이름이나 ARN에 필터 문자열이 들어 있는 항목(대소문자 무시) */
export function filterPrincipals(items: PrincipalSummary[], filter: string): PrincipalSummary[] {
  const f = filter.trim().toLowerCase();
  if (!f) return items;
  return items.filter((p) => p.name.toLowerCase().includes(f) || p.arn.toLowerCase().includes(f));
}

interface Props {
  kind: PrincipalKind;
  items: PrincipalSummary[];
  filter: string;
  selectedId: string | null;
  onSelect: (arn: string) => void;
  onOpen: (arn: string) => void;
}

export function PrincipalList({ kind, items, filter, selectedId, onSelect, onOpen }: Props) {
  const text = TEXT[kind];
  return (
    <ListTable
      label={text.label}
      rows={filterPrincipals(items, filter)}
      columns={COLUMNS[kind]}
      rowKey={(p) => p.arn}
      selectedId={selectedId}
      onSelect={onSelect}
      onOpen={onOpen}
      empty={items.length === 0 ? text.empty : text.noMatch}
    />
  );
}
