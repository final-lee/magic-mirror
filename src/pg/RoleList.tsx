import { useRef } from "react";
import { ListFind, useListFind } from "../components/ListFind";
import { ListTable, type ListColumn } from "../iam/ListTable";
import { BadgeList } from "./Badges";
import { ROLE_KIND_LABEL, utcDay } from "./labels";
import { RoleKinds, filterRoles, type RoleKindsValue } from "./RoleKinds";
import type { PgRoleSummary } from "./types";

const expiryOf = (r: PgRoleSummary) => {
  const t = r.attributes.validUntil ? Date.parse(r.attributes.validUntil) : NaN;
  return Number.isNaN(t) ? null : t;
};

const COLUMNS: ListColumn<PgRoleSummary>[] = [
  {
    key: "name",
    label: "이름",
    sort: (r) => r.name,
    render: (r) => (
      <span className="pg-name">
        <span className="iam-name">{r.name}</span>
        <BadgeList badges={r.badges} />
      </span>
    ),
  },
  { key: "kind", label: "종류", sort: (r) => ROLE_KIND_LABEL[r.kind], render: (r) => ROLE_KIND_LABEL[r.kind] },
  { key: "groups", label: "소속 그룹", numeric: true, sort: (r) => r.memberOf.length, render: (r) => r.memberOf.length },
  { key: "members", label: "구성원", numeric: true, sort: (r) => r.memberCount, render: (r) => r.memberCount },
  { key: "sessions", label: "세션", numeric: true, sort: (r) => r.sessionCount, render: (r) => r.sessionCount },
  {
    key: "expiry",
    label: "만료일",
    sort: expiryOf,
    render: (r) => (expiryOf(r) === null ? <span className="dim">없음</span> : utcDay(r.attributes.validUntil!)),
  },
];

interface Props {
  roles: PgRoleSummary[];
  /** 칩과 시스템 역할 토글의 상태. 상세를 보고 돌아와도 남도록 탭이 들고 있다 */
  kinds: RoleKindsValue;
  onKinds: (next: RoleKindsValue) => void;
  selectedId: string | null;
  onSelect: (name: string) => void;
  /** 선택을 푼다(고른 행을 다시 누르거나 빈 곳) */
  onClear: () => void;
  onOpen: (name: string) => void;
  /** [역할 만들기]. 주지 않으면 버튼이 없다 */
  onCreate?: () => void;
  /** 바꿀 수 없는 이유(changeBlockReason). 있으면 [역할 만들기]가 꺼지고 이 글이 제목이다 */
  blockReason?: string | null;
}

export function RoleList({ roles, kinds, onKinds, selectedId, onSelect, onClear, onOpen, onCreate, blockReason = null }: Props) {
  const box = useRef<HTMLElement>(null);
  const find = useListFind(box);
  // ⌘F의 찾기는 이름에만 적용한다(대소문자 무시). 권한 표와 같은 규칙이다.
  const rows = filterRoles(roles, kinds, find.query);
  return (
    <section className="center" ref={box}>
      <div className="pg-bar">
        <RoleKinds value={kinds} onChange={onKinds} />
        {onCreate && (
          <span className="pg-bar-end">
            <button type="button" className="btn small tone-create" disabled={blockReason !== null} title={blockReason ?? undefined} aria-description={blockReason ?? undefined} onClick={onCreate}>
              역할 만들기…
            </button>
          </span>
        )}
      </div>
      <ListFind find={find} />
      <ListTable
        label="역할 목록"
        rows={rows}
        columns={COLUMNS}
        rowKey={(r) => r.name}
        selectedId={selectedId}
        onSelect={onSelect}
        onClear={onClear}
        onOpen={onOpen}
        empty={roles.length === 0 ? "역할이 없어요" : "조건에 맞는 역할이 없어요"}
      />
    </section>
  );
}
