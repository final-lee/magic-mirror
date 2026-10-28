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
