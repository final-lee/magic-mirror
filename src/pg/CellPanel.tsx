import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { OBJECT_KIND_LABEL, objectName, unusableText } from "./labels";
import { PgError } from "./PgError";
import { usePgCell } from "./queries";
import { sourceText } from "./sentences";
import type { PgCellDetail, PgCellObject, PgTarget } from "./types";

type Tab = "tables" | "sequences" | "functions";

const TABS: { id: Tab; label: string }[] = [
  { id: "tables", label: "테이블" },
  { id: "sequences", label: "시퀀스" },
  { id: "functions", label: "함수" },
];

/** 뷰, 구체화 뷰, 파티션 테이블, 외부 테이블도 테이블 권한을 갖는 테이블 쪽이다 */
const tabOf = (o: PgCellObject): Tab => (o.object.kind === "sequence" ? "sequences" : o.object.kind === "function" ? "functions" : "tables");

interface Props {
  target: PgTarget;
  database: string;
  role: string;
  schema: string;
  /** 그 칸의 unusable 사유("CONNECT 없음" 또는 "USAGE 없음"). 쓸 수 없는 칸이 아니면 null */
  unusable: string | null;
  /** 이 역할이 BYPASSRLS를 가졌는지. 가졌으면 행 수준 보안이 켜진 테이블에도 적용되지 않는다 */
  bypassRls: boolean;
  onClose: () => void;
}

/**
 * 권한 표의 칸 하나(역할 × 스키마)의 상세. 표 오른쪽에 붙는 옆 패널이다(모달이 아니다).
 * 그 스키마의 객체를 테이블, 시퀀스, 함수 탭으로 나누어 객체마다 가진 권한을 칩으로 보이고, 칩의 title이 출처를 설명한다.
 * 열리거나 다른 칸으로 바뀌면 초점을 패널로 가져오고, Esc와 [닫기]는 onClose를 부른다(초점을 칸으로 돌리는 일은 부르는 쪽이 한다).
 */
export function CellPanel({ target, database, role, schema, unusable, bypassRls, onClose }: Props) {
  const q = usePgCell(target, database, role, schema);
  const [tab, setTab] = useState<Tab>("tables");
  const box = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // 같은 칸을 다시 읽을 때가 아니라, 칸이 바뀔 때만 초점을 가져온다
  useEffect(() => box.current?.focus(), [role, schema]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") onClose();
  };

  return (
    <div className="pg-panel" role="complementary" aria-labelledby={titleId} tabIndex={-1} ref={box} onKeyDown={onKeyDown}>
      <header className="pg-panel-head">
        <h3 id={titleId}>
          {role} · {schema}
        </h3>
        <button type="button" className="icon" aria-label="닫기" title="닫기 (Esc)" onClick={onClose}>
          ✕
        </button>
      </header>
      {unusable && (
        <div className="pg-panel-warn" role="note">
          <span aria-hidden="true">⚠</span> {unusableText(unusable)}
        </div>
      )}
      {q.isError && q.data && <PgError compact error={q.error} target={target} />}
      {q.data ? (
        <Objects detail={q.data} role={role} bypassRls={bypassRls} tab={tab} onTab={setTab} />
      ) : q.isError ? (
        <PgError error={q.error} target={target} />
      ) : (
        <div className="empty small">불러오는 중…</div>
      )}
    </div>
  );
}

function Objects({ detail, role, bypassRls, tab, onTab }: { detail: PgCellDetail; role: string; bypassRls: boolean; tab: Tab; onTab: (tab: Tab) => void }) {
  const objects = detail.objects.filter((o) => tabOf(o) === tab);
  const label = TABS.find((t) => t.id === tab)!.label;
  return (
    <>
      {detail.truncated && (
        <div className="notice" role="note">
          객체가 많아 일부만 읽었어요
        </div>
      )}
      <div className="iam-tabs" role="tablist" aria-label="객체 종류">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={t.id === tab} className={`iam-tab${t.id === tab ? " on" : ""}`} onClick={() => onTab(t.id)}>
            {t.label} <span className="iam-tab-n">{detail.objects.filter((o) => tabOf(o) === t.id).length}</span>
          </button>
        ))}
      </div>
      <div className="pg-panel-body" role="tabpanel" aria-label={label}>
        {detail.objects.length === 0 ? (
          <div className="empty small">받은 객체 권한이 없어요</div>
        ) : objects.length === 0 ? (
          <div className="empty small">{label} 권한이 없어요</div>
        ) : (
          <ul className="pg-objects" aria-label={`${label} 권한`}>
            {objects.map((o) => (
              <li key={`${o.object.kind}:${objectName(o.object)}`}>
                <div className="pg-obj-head">
                  <span className="mono pg-obj-name">{objectName(o.object)}</span>
                  {tab === "tables" && o.object.kind !== "table" && <span className="dim pg-obj-kind">{OBJECT_KIND_LABEL[o.object.kind]}</span>}
                  {o.rls && <span className={`iam-chip${bypassRls ? "" : " conditional"}`}>{bypassRls ? "행 수준 보안 켜짐 · BYPASSRLS라 적용되지 않아요" : "행 수준 보안 켜짐"}</span>}
                </div>
                <div className="pg-privs">
                  {o.privileges.map((p) => (
                    <span key={p.privilege} className="iam-chip pg-priv" data-testid="privilege" title={p.sources.map((s) => sourceText(s, role)).join(", ") || undefined}>
                      {p.privilege}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
