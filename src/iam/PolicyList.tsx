import { BadgeList } from "./Badges";
import { formatDay } from "./format";
import { ListTable, type ListColumn } from "./ListTable";
import type { PolicySummary } from "./types";

export const SCOPE_LABEL = { aws: "AWS 관리형", local: "고객 관리형" } as const;

const COLUMNS: ListColumn<PolicySummary>[] = [
  { key: "name", label: "이름", sort: (p) => p.name, render: (p) => <span className="iam-name">{p.name}</span> },
  { key: "scope", label: "범위", sort: (p) => SCOPE_LABEL[p.scope], render: (p) => SCOPE_LABEL[p.scope] },
  { key: "attachments", label: "붙은 곳", numeric: true, sort: (p) => p.attachmentCount, render: (p) => p.attachmentCount },
  // 범위 칸이 이미 AWS 관리형인지 알려 주므로 같은 배지는 되풀이하지 않는다.
  { key: "badges", label: "상태", render: (p) => <BadgeList badges={p.badges} hide={["awsManaged"]} /> },
  {
    key: "updated",
    label: "수정일",
    sort: (p) => (p.updatedAt ? Date.parse(p.updatedAt) || null : null),
    render: (p) => formatDay(p.updatedAt) || <span className="dim">—</span>,
  },
];

export function filterPolicies(items: PolicySummary[], filter: string): PolicySummary[] {
  const f = filter.trim().toLowerCase();
  if (!f) return items;
  return items.filter((p) => p.name.toLowerCase().includes(f) || p.arn.toLowerCase().includes(f));
}

interface Props {
  items: PolicySummary[];
  filter: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
}

export function PolicyList({ items, filter, selectedId, onSelect, onOpen }: Props) {
  return (
    <ListTable
      label="정책 목록"
      rows={filterPolicies(items, filter)}
      columns={COLUMNS}
      rowKey={(p) => p.id}
      selectedId={selectedId}
      onSelect={onSelect}
      onOpen={onOpen}
      empty={items.length === 0 ? "정책이 없어요" : "조건에 맞는 정책이 없어요"}
    />
  );
}
