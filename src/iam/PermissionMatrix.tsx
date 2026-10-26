import { useState } from "react";
import { LEVELS, LEVEL_LABEL } from "./labels";
import type { MatrixCell } from "./route";
import type { AccessLevel, LevelCell, ServicePermissions } from "./types";

interface Props {
  services: ServicePermissions[];
  adminLike: boolean;
  selected: { prefix: string; level: AccessLevel } | null;
  onSelect: (cell: MatrixCell) => void;
}

/** 칸의 색 농도: 전부 허용 / 일부 허용 / 조건부만 / 거부만 / 없음 */
function tone(c: LevelCell): string {
  if (c.allowed > 0) return c.allowed === c.total ? "full" : "part";
  if (c.conditional > 0) return "cond";
  if (c.denied > 0) return "deny";
  return "none";
}

function cellLabel(svc: ServicePermissions, level: AccessLevel, c: LevelCell): string {
  const parts = [`허용 ${c.allowed}/${c.total}`];
  if (c.conditional > 0) parts.push(`조건부 ${c.conditional}`);
  // denied에는 권한 경계로 막힌 작업도 들어 있다(드릴다운은 둘을 나눠 보여준다)
  if (c.denied > 0) parts.push(`거부·경계 ${c.denied}`);
  return `${svc.name} ${LEVEL_LABEL[level]} ${parts.join(", ")}`;
}

function Cell({ svc, level, selected, onSelect }: { svc: ServicePermissions; level: AccessLevel; selected: boolean; onSelect: Props["onSelect"] }) {
  const c = svc.levels[level];
  const granted = c.allowed + c.conditional + c.denied > 0;
  if (!granted) {
    // 이 수준의 작업이 아예 없으면 대시, 있는데 하나도 허용되지 않았으면 0/전체
    return <td className="mx-td">{c.total === 0 ? <span className="dim">–</span> : <span className="mx-zero">{`0/${c.total}`}</span>}</td>;
  }
  return (
    <td className="mx-td">
      <button
        className={`mx-cell ${tone(c)}${selected ? " on" : ""}`}
        aria-pressed={selected}
        aria-label={cellLabel(svc, level, c)}
        onClick={() => onSelect({ prefix: svc.prefix, name: svc.name, level })}
      >
        <span className="mx-n">
          {c.allowed}
          <small>/{c.total}</small>
        </span>
        {c.conditional > 0 && (
          <span className="mx-mark cond" title={`조건부 ${c.conditional}`}>
            ◐ {c.conditional}
          </span>
        )}
        {c.denied > 0 && (
          <span className="mx-mark deny" title={`거부·경계 ${c.denied}`}>
            ⊘ {c.denied}
          </span>
        )}
      </button>
    </td>
  );
}

/** 서비스 × 접근 수준 표. 칸의 숫자는 허용된 작업 수 / 그 수준의 전체 작업 수이고, 칸을 누르면 실제 작업 목록을 연다. */
export function PermissionMatrix({ services, adminLike, selected, onSelect }: Props) {
  const [filter, setFilter] = useState("");
  const f = filter.trim().toLowerCase();
  const rows = f ? services.filter((s) => s.name.toLowerCase().includes(f) || s.prefix.toLowerCase().includes(f)) : services;

  return (
    <div className="mx">
      {adminLike && (
        <div className="iam-banner danger" role="status">
          <span aria-hidden="true">⚠</span> <b>모든 서비스의 모든 작업이 허용돼요</b>
        </div>
      )}
      {services.length === 0 ? (
        !adminLike && <div className="empty small">허용된 권한이 없어요</div>
      ) : (
        <>
          <div className="mx-bar">
            <input
              type="search"
              className="iam-filter"
              placeholder="서비스 이름으로 필터"
              aria-label="서비스 필터"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setFilter("");
              }}
            />
            <span className="dim">서비스 {services.length}개</span>
          </div>
          {rows.length === 0 ? (
            <div className="empty small">조건에 맞는 서비스가 없어요</div>
          ) : (
            <table aria-label="서비스별 권한">
              <thead>
                <tr>
                  <th scope="col">서비스</th>
                  {LEVELS.map((l) => (
                    <th key={l} scope="col" className="mx-th">
                      {LEVEL_LABEL[l]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((svc) => (
                  <tr key={svc.prefix}>
                    <th scope="row">
                      {svc.name} <small className="mx-prefix mono">{svc.prefix}</small>
                      {svc.danger && (
                        <span className="mx-danger" role="img" aria-label="위험한 작업 포함" title="권한 상승 등 위험한 작업이 포함돼요">
                          ⚠
                        </span>
                      )}
                    </th>
                    {LEVELS.map((l) => (
                      <Cell key={l} svc={svc} level={l} selected={selected?.prefix === svc.prefix && selected.level === l} onSelect={onSelect} />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
