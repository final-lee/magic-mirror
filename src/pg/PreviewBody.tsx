import { memo, useId, type ReactNode } from "react";
import { ReversibleNote, WarningList } from "../iam/previewParts";
import { OBJECT_KIND_LABEL } from "./labels";
import { defaultPrivilegeSentence, noGrantSentence } from "./sentences";
import type { PgBatchItem, PgChange, PgDefaultAclRow, PgDefaultDelta, PgImpact, PgPreview, PgPrivDelta, PgRoleDelta, PgWarning } from "./types";

/** 변경 하나의 미리보기와 묶음의 미리보기가 함께 가진 부분. 본문은 이것만 안다. */
export type PreviewParts = Pick<PgPreview, "warnings" | "sql" | "impacts" | "impactsOmitted" | "roles" | "defaults" | "reversible">;

interface Props {
  preview: PreviewParts;
  /** 묶음이면 변경 목록(적용 순서). 경고 다음, 실행할 SQL 앞에 놓는다 */
  items?: PgBatchItem[];
  /** 경고가 담아 둔 변경(대개 기본 권한)을 장바구니에 담는다. 주지 않으면 [기본 권한도 담기]를 그리지 않는다 */
  onAddDefaults?: (changes: PgChange[]) => void;
}

/**
 * 미리보기 본문: 경고, (묶음이면) 변경 목록, 실행할 SQL, 영향, 되돌릴 수 있는지.
 * 영향 목록이 길 수 있어서, 확인 문구를 한 글자씩 입력할 때마다 다시 그리지 않도록 미리보기가 바뀔 때만 그린다.
 */
export const PreviewBody = memo(function PreviewBody({ preview, items, onAddDefaults }: Props) {
  const action = onAddDefaults ? (w: PgWarning) => (w.add.length > 0 ? <AddDefaults changes={w.add} onAdd={onAddDefaults} /> : null) : undefined;
  return (
    <>
      <WarningList warnings={preview.warnings} action={action} />
      {items && items.length > 0 && <ItemList items={items} action={action} />}
      <SqlList sql={preview.sql} />
      <Effects preview={preview} />
      <ReversibleNote reversible={preview.reversible} />
    </>
  );
});

/** 경고 옆의 [기본 권한도 담기]: 그 경고가 담아 둔 변경을 장바구니에 담는다. 이미 담긴 것은 담는 쪽이 건너뛴다. */
function AddDefaults({ changes, onAdd }: { changes: PgChange[]; onAdd: (changes: PgChange[]) => void }) {
  return (
    <button className="btn small cp-add" onClick={() => onAdd(changes)}>
      기본 권한도 담기
    </button>
  );
}

/** 묶음의 변경 목록: 적용 순서대로 번호를 붙이고, 변경마다 요약과 그 변경의 경고를 보인다 */
function ItemList({ items, action }: { items: PgBatchItem[]; action?: (w: PgWarning) => ReactNode }) {
  return (
    <>
      <h4>
        변경 <span className="dim">{items.length}</span>
      </h4>
      {/* role="list": Safari는 목록 모양을 없앤(list-style: none) 목록의 목록 의미를 읽어 주지 않는다 */}
      <ol className="cp-items" role="list" aria-label="변경 목록">
        {items.map((item, i) => (
          <li key={i} className="cp-item">
            <div className="cp-item-head">
              <span className="cp-item-no dim">{i + 1}</span>
              <span className="cp-item-sum">{item.summary}</span>
            </div>
            <WarningList warnings={item.warnings} action={action} />
          </li>
        ))}
      </ol>
    </>
  );
}

/** 실행할 SQL 문장을 순서대로, 번호를 붙여 그대로 보인다. 비밀번호 자리는 백엔드가 이미 '••••••••'로 가려 보낸다. */
function SqlList({ sql }: { sql: string[] }) {
  if (sql.length === 0) return null;
  return (
    <>
      <h4>실행할 SQL</h4>
      <ol className="cp-sql" role="list" aria-label="실행할 SQL">
        {sql.map((statement, i) => (
          <li key={i}>
            <span className="cp-sql-no dim" aria-hidden="true">
              {i + 1}
            </span>
            <code className="mono cp-val">{statement}</code>
          </li>
        ))}
      </ol>
    </>
  );
}

/** 영향: 역할별로 얻고 잃는 권한, 역할 자체의 변화(만들기·삭제·속성·그룹), 기본 권한의 전과 후. 아무것도 없으면 그렇다고 말한다. */
function Effects({ preview }: { preview: PreviewParts }) {
  const { impacts, impactsOmitted, roles, defaults } = preview;
  const nothing = impacts.length === 0 && impactsOmitted === 0 && roles.length === 0 && defaults.length === 0;
  return (
    <div className="cp-effects">
      <h4>영향</h4>
      {nothing ? (
        <p className="cp-none">권한 변화 없음</p>
      ) : (
        <>
          {(impacts.length > 0 || impactsOmitted > 0) && (
            <ul className="cp-impacts" aria-label="영향받는 역할">
              {impacts.map((impact) => (
                <ImpactItem key={impact.role} impact={impact} />
              ))}
              {impactsOmitted > 0 && <li className="dim">{`그 밖에 ${impactsOmitted}개 역할`}</li>}
            </ul>
          )}
          {roles.length > 0 && <RoleDeltas roles={roles} />}
          {defaults.length > 0 && <DefaultDeltas defaults={defaults} />}
        </>
      )}
    </div>
  );
}

const DELTA = {
  gained: { className: "cp-gain", label: "얻는 권한", sign: "＋" },
  lost: { className: "cp-lose", label: "잃는 권한", sign: "－" },
} as const;

function ImpactItem({ impact }: { impact: PgImpact }) {
  return (
    <li data-testid={`impact-${impact.role}`}>
      <div className="cp-who">
        <b>{impact.role}</b>
      </div>
      {impact.gained.length > 0 && <Deltas kind="gained" deltas={impact.gained} />}
      {impact.lost.length > 0 && <Deltas kind="lost" deltas={impact.lost} />}
    </li>
  );
}

/**
 * 한 방향의 증감 줄: `스키마(없으면 데이터베이스) · 객체 종류 N개 권한`과 그 뒤에 이름 몇 개(백엔드가 5개까지 보낸다).
 * 보낸 이름보다 객체가 많으면 몇 개가 더 있는지 적는다.
 */
function Deltas({ kind, deltas }: { kind: keyof typeof DELTA; deltas: PgPrivDelta[] }) {
  const { className, label, sign } = DELTA[kind];
  const caption = useId();
  return (
    <>
      <div id={caption} className="cp-cap">
        {label}
      </div>
      <ul className={className} aria-labelledby={caption}>
        {deltas.map((d, i) => (
          <li key={i}>
            <span className="cp-sign" aria-hidden="true">
              {sign}
            </span>
            <span>{`${d.schema ?? d.database} · ${OBJECT_KIND_LABEL[d.objectKind]} ${d.count}개 ${d.privilege}`}</span>
            {d.sample.length > 0 && <span className="mono dim"> {d.sample.join(", ")}</span>}
            {d.sample.length > 0 && d.count > d.sample.length && <span className="dim">{` 외 ${d.count - d.sample.length}개`}</span>}
          </li>
        ))}
      </ul>
    </>
  );
}

function RoleDeltas({ roles }: { roles: PgRoleDelta[] }) {
  return (
    <ul className="cp-roles" aria-label="역할 변화">
      {roles.map((r) => (
        <li key={r.role} data-testid={`role-${r.role}`}>
          <div className="cp-who">
            <b>{r.role}</b>
            {r.created && <span className="iam-chip allowed">새로 만들어요</span>}
            {r.dropped && <span className="iam-chip denied">삭제돼요</span>}
          </div>
          {r.attributes.map((a, i) => (
            <div key={i}>{`${a.name}: ${a.before} → ${a.after}`}</div>
          ))}
          {r.groupsAdded.length > 0 && <div>{`들어가는 그룹: ${r.groupsAdded.join(", ")}`}</div>}
          {r.groupsRemoved.length > 0 && <div>{`빠지는 그룹: ${r.groupsRemoved.join(", ")}`}</div>}
        </li>
      ))}
    </ul>
  );
}

/** 기본 권한 기록 하나의 전과 후. 문장은 기본 권한 화면과 같은 규칙으로 푼다(sentences.ts). */
function DefaultDeltas({ defaults }: { defaults: PgDefaultDelta[] }) {
  return (
    <ul className="cp-defaults" aria-label="기본 권한 변화">
      {defaults.map((d, i) => (
        <li key={i} data-testid="default-delta">
          <div className="cp-cap">바뀌기 전</div>
          <DefaultSide row={d.before} />
          <div className="cp-cap">바뀐 뒤</div>
          <DefaultSide row={d.after} />
        </li>
      ))}
    </ul>
  );
}

/** 기록이 없는 쪽(처음 만들거나 모두 거둬서 기록이 사라진 쪽)은 설정이 없다고 적는다 */
function DefaultSide({ row }: { row: PgDefaultAclRow | null }) {
  if (!row) return <p className="cp-none dim">설정 없음</p>;
  return (
    <ul className="cp-sentences">
      {row.grants.length === 0 ? <li>{noGrantSentence(row)}</li> : row.grants.map((grant) => <li key={grant.grantee}>{defaultPrivilegeSentence(row, grant)}</li>)}
    </ul>
  );
}
