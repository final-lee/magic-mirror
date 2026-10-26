import type { MatrixCell } from "./route";
import { PermissionMatrix } from "./PermissionMatrix";
import type { PrincipalView } from "./types";

/** 권한 탭: 설명(notes) → 서비스 × 접근 수준 표 → 카탈로그에 없는 작업 */
export function PermissionsPane({ view, cell, onSelect }: { view: PrincipalView; cell: MatrixCell | null; onSelect: (c: MatrixCell) => void }) {
  return (
    <>
      {view.notes.map((n) => (
        <div className="iam-hint" key={n}>
          <span aria-hidden="true">ⓘ</span> <span>{n}</span>
        </div>
      ))}
      <PermissionMatrix
        services={view.services}
        adminLike={view.adminLike}
        selected={cell ? { prefix: cell.prefix, level: cell.level } : null}
        onSelect={onSelect}
      />
      {view.unknownActions.length > 0 && (
        <section className="iam-unknown">
          <div className="sect">카탈로그에 없는 작업 {view.unknownActions.length}개</div>
          <p className="dim">접근 수준을 알 수 없어 위 표에는 넣지 않았어요.</p>
          <div>
            {view.unknownActions.map((a) => (
              <span className="tag mono" key={a}>
                {a}
              </span>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
