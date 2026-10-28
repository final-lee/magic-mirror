import type { PgRoleSummary } from "./types";

/** 역할을 거르는 칩(사용자, 그룹)과 시스템 역할 토글의 상태 */
export interface RoleKindsValue {
  users: boolean;
  groups: boolean;
  system: boolean;
}

export const DEFAULT_KINDS: RoleKindsValue = { users: true, groups: true, system: false };

/** 칩과 토글이 이 역할을 보이게 하는지. 시스템 역할도 사용자·그룹 칩을 따른다. */
export const roleShown = (role: Pick<PgRoleSummary, "kind" | "system">, kinds: RoleKindsValue) =>
  (role.kind === "user" ? kinds.users : kinds.groups) && (kinds.system || !role.system);

/**
 * 칩과 시스템 역할 토글을 지나고, 툴바 필터(이름에만 적용, 대소문자와 앞뒤 공백은 무시)에도 맞는 역할.
 * 역할 목록과 권한 표가 같은 규칙으로 행을 거르도록 함께 쓴다.
 */
export function filterRoles<R extends Pick<PgRoleSummary, "name" | "kind" | "system">>(roles: R[], kinds: RoleKindsValue, filter: string): R[] {
  const f = filter.trim().toLowerCase();
  return roles.filter((r) => roleShown(r, kinds) && r.name.toLowerCase().includes(f));
}

interface Props {
  value: RoleKindsValue;
  onChange: (next: RoleKindsValue) => void;
}

/** 역할 목록, 권한 표, 누가 할 수 있나가 함께 쓰는 종류 칩과 [시스템 역할 보기] */
export function RoleKinds({ value, onChange }: Props) {
  const chips = [
    { key: "users", label: "사용자" },
    { key: "groups", label: "그룹" },
  ] as const;
  return (
    <div className="pg-kinds">
      <div className="pg-chips" role="group" aria-label="종류">
        {chips.map(({ key, label }) => (
          <label key={key} className={`pg-chip${value[key] ? " on" : ""}`}>
            <input type="checkbox" checked={value[key]} onChange={() => onChange({ ...value, [key]: !value[key] })} /> {label}
          </label>
        ))}
      </div>
      <label className="pg-toggle">
        <input type="checkbox" checked={value.system} onChange={() => onChange({ ...value, system: !value.system })} /> 시스템 역할 보기
      </label>
    </div>
  );
}
