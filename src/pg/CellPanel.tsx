import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { OBJECT_KIND_LABEL, TRUNCATED_TEXT, objectName, unusableText } from "./labels";
import { OWNER_HELD_TEXT } from "./canChange";
import { draftKey } from "./draft";
import { GrantSheet } from "./GrantSheet";
import { grantTargetOf } from "./objectTarget";
import { PgError } from "./PgError";
import { putChange } from "./putChange";
import { usePgCell } from "./queries";
import { PUBLIC_LABEL, sourceText } from "./sentences";
import type { PgCellDetail, PgCellObject, PgChange, PgGrantTarget, PgSchemaCell, PgSource, PgTarget } from "./types";
import type { GridDraft } from "./useChangeMode";

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
  /** 바꾸기 모드의 장바구니. 있으면 권한마다 [빼기]가 붙고 [객체에 권한 주기]가 보인다 */
  draft?: GridDraft;
  /** 이 칸. 바꾸기 모드에서 머리의 사용·만들기 칩을 그린다 */
  cell?: PgSchemaCell;
  onClose: () => void;
}

const PUBLIC = "PUBLIC";

/** 바꾸기 모드에서 패널이 쓰는 것 */
interface Edit {
  draft: GridDraft;
  database: string;
  role: string;
}

/** 그 권한을 지금 받는 길: 직접, 모든 역할(PUBLIC)로. 이 두 길만 여기서 뺄 수 있다 */
const viaDirect = (sources: PgSource[]) => sources.some((s) => s.kind === "direct");
const viaPublic = (sources: PgSource[]) => sources.some((s) => s.kind === "public");

/** 권한 하나를 grantee에게서 빼는 변경(객체 하나, 권한 하나) */
const revokeOf = (database: string, grantee: string, target: PgGrantTarget, privilege: string): PgChange => ({
  kind: "grant",
  database,
  grantee,
  add: false,
  items: [{ target, privileges: [privilege] }],
});

/** 담아 둔 뺄 변경이 있는 칸의 [빼기]는 눌린 모양이고, 다시 누르면 거둔다 */
function RevokeButton({ edit, change, label, disabled, title }: { edit: Edit; change: PgChange | null; label: string; disabled?: boolean; title?: string }) {
  const key = change ? draftKey(change) : null;
  const queued = key === null ? undefined : edit.draft.items.find((d) => d.key === key);
  const pressed = !!queued && queued.change.kind === "grant" && !queued.change.add;
  return (
    <button
      type="button"
      className={`link pg-revoke${pressed ? " on" : ""}`}
      aria-pressed={disabled ? undefined : pressed}
      disabled={disabled || !change}
      title={title}
      onClick={() => {
        if (!change || key === null) return;
        if (pressed) edit.draft.remove(key);
        else putChange(edit.draft, change);
      }}
    >
      {label}
    </button>
  );
}

/**
 * 권한 표의 칸 하나(역할 × 스키마)의 상세. 표 오른쪽에 붙는 옆 패널이다(모달이 아니다).
 * 그 스키마의 객체를 테이블, 시퀀스, 함수 탭으로 나누어 객체마다 가진 권한을 칩으로 보이고, 칩의 title이 출처를 설명한다.
 * 열리거나 다른 칸으로 바뀌면 초점을 패널로 가져오고, Esc와 [닫기]는 onClose를 부른다(초점을 칸으로 돌리는 일은 부르는 쪽이 한다).
 */
export function CellPanel({ target, database, role, schema, unusable, bypassRls, draft, cell, onClose }: Props) {
  const q = usePgCell(target, database, role, schema);
  const [tab, setTab] = useState<Tab>("tables");
  const [granting, setGranting] = useState(false);
  const edit: Edit | null = draft ? { draft, database, role } : null;
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
      {edit && cell && <SchemaChips edit={edit} schema={schema} cell={cell} />}
      {unusable && (
        <div className="pg-panel-warn" role="note">
          <span aria-hidden="true">⚠</span> {unusableText(unusable)}
        </div>
      )}
      {q.isError && q.data && <PgError compact error={q.error} target={target} />}
      {q.data ? (
        <Objects detail={q.data} role={role} bypassRls={bypassRls} tab={tab} onTab={setTab} edit={edit} onGrant={() => setGranting(true)} />
      ) : q.isError ? (
        <PgError error={q.error} target={target} />
      ) : (
        <div className="empty small">불러오는 중…</div>
      )}
      {granting && draft && <GrantSheet target={target} database={database} schema={schema} role={role} draft={draft} onClose={() => setGranting(false)} />}
    </div>
  );
}

function Objects({ detail, role, bypassRls, tab, onTab, edit, onGrant }: { detail: PgCellDetail; role: string; bypassRls: boolean; tab: Tab; onTab: (tab: Tab) => void; edit: Edit | null; onGrant: () => void }) {
  const objects = detail.objects.filter((o) => tabOf(o) === tab);
  const label = TABS.find((t) => t.id === tab)!.label;
  return (
    <>
      {detail.truncated && (
        <div className="notice" role="note">
          {TRUNCATED_TEXT}
        </div>
      )}
      <div className="iam-tabs" role="tablist" aria-label="객체 종류">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={t.id === tab} className={`iam-tab${t.id === tab ? " on" : ""}`} onClick={() => onTab(t.id)}>
            {t.label} <span className="iam-tab-n">{detail.objects.filter((o) => tabOf(o) === t.id).length}</span>
          </button>
        ))}
      </div>
      {edit && (
        <div className="pg-panel-act">
          <button type="button" className="btn small" onClick={onGrant}>
            객체에 권한 주기
          </button>
        </div>
      )}
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
                  {o.privileges.map((p) => {
                    const why = p.sources.map((s) => sourceText(s, role)).join(", ") || undefined;
                    const chip = (
                      <span className="iam-chip pg-priv" data-testid="privilege" title={why}>
                        {p.privilege}
                      </span>
                    );
                    if (!edit) return <Fragment key={p.privilege}>{chip}</Fragment>;
                    return (
                      <span key={p.privilege} className="pg-priv-edit" data-testid="privilege-edit">
                        {chip}
                        <ObjectRevokes edit={edit} object={o} privilege={p.privilege} sources={p.sources} why={why} />
                      </span>
                    );
                  })}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/**
 * 가진 권한 하나의 [빼기]:
 * - 직접 받은 것은 [빼기]가 그 역할에서 빼는 변경(객체 하나)을 담는다
 * - 모든 역할(PUBLIC)로 받은 것은 [PUBLIC에서 빼기]가 PUBLIC에서 빼는 같은 변경을 담는다(그 역할에서 빼는 것이 아니다)
 * - 소유자라서, 그룹에서, 미리 정의된 역할에서 받은 것은 여기서 뺄 수 없어서 꺼진 [빼기]만 보인다
 */
function ObjectRevokes({ edit, object, privilege, sources, why }: { edit: Edit; object: PgCellObject; privilege: string; sources: PgSource[]; why: string | undefined }) {
  const target = grantTargetOf(object.object);
  const direct = viaDirect(sources);
  const everyone = viaPublic(sources);
  const change = (grantee: string) => (target ? revokeOf(edit.database, grantee, target, privilege) : null);
  return (
    <>
      {direct && <RevokeButton edit={edit} change={change(edit.role)} label="빼기" title={`${edit.role} 역할에서 ${privilege} 권한을 빼요`} />}
      {everyone && <RevokeButton edit={edit} change={change(PUBLIC)} label="PUBLIC에서 빼기" title={`${PUBLIC_LABEL}에서 ${privilege} 권한을 빼요`} />}
      {!direct && !everyone && (
        <RevokeButton edit={edit} change={null} label="빼기" disabled title={sources.length > 0 && sources.every((s) => s.kind === "owner" && s.via.length === 0) ? OWNER_HELD_TEXT : why} />
      )}
    </>
  );
}

/** 바꾸기 모드의 머리: 이 스키마의 사용·만들기를 칩으로 보이고, 직접 받은 것은 [빼기]를 붙인다 */
function SchemaChips({ edit, schema, cell }: { edit: Edit; schema: string; cell: PgSchemaCell }) {
  const held = [
    { label: "사용", privilege: "USAGE", has: cell.usage, direct: cell.direct.usage, owned: cell.owned.usage },
    { label: "만들기", privilege: "CREATE", has: cell.create, direct: cell.direct.create, owned: cell.owned.create },
  ];
  const target: PgGrantTarget = { kind: "schema", name: schema };
  return (
    <div className="pg-schema-privs" role="group" aria-label="스키마 권한">
      {held.map(({ label, privilege, has, direct, owned }) => {
        const via = [direct ? "직접 받음" : null, owned ? "소유자" : null, !direct && !owned ? "물려받음" : null].filter(Boolean).join(", ");
        return (
          <span key={privilege} className={`pg-priv-edit${has ? "" : " off"}`} data-testid="schema-privilege">
            <span className={`iam-chip${has ? "" : " conditional"}`} title={has ? via : undefined}>
              {label} {has ? via : "없음"}
            </span>
            {has && direct && <RevokeButton edit={edit} change={revokeOf(edit.database, edit.role, target, privilege)} label="빼기" title={`${edit.role} 역할에서 스키마 ${schema}의 ${privilege} 권한을 빼요`} />}
            {has && !direct && <RevokeButton edit={edit} change={null} label="빼기" disabled title={owned ? OWNER_HELD_TEXT : via} />}
          </span>
        );
      })}
    </div>
  );
}
