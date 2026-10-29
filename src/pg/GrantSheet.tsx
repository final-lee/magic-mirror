import { useEffect, useId, useRef, useState } from "react";
import { useModal } from "../iam/useModal";
import { useDebounced } from "../lib/useDebounced";
import { OBJECT_KIND_LABEL, objectName } from "./labels";
import { grantTargetOf } from "./objectTarget";
import { PgError } from "./PgError";
import { PrivilegeChecks } from "./PrivilegeChecks";
import { usePgObjects } from "./queries";
import { putChange } from "./putChange";
import { PUBLIC_LABEL } from "./sentences";
import type { PgObjectRef, PgTarget } from "./types";
import type { GridDraft } from "./useChangeMode";
import { OBJECT_PRIVILEGES, SEARCH_DELAY_MS } from "./WhoCan";

interface Props {
  target: PgTarget;
  database: string;
  /** 객체를 찾는 스키마. 이 스키마의 객체만 고를 수 있다 */
  schema: string;
  /** 칸의 역할: 받는 역할의 처음 값 */
  role: string;
  draft: GridDraft;
  onClose: () => void;
}

const PUBLIC = "PUBLIC";
/** 권한을 줄 수 있는 객체: 이 스키마의 테이블, 시퀀스, 함수 */
const inSchema = (schema: string) => (o: PgObjectRef) => o.schema === schema && o.kind !== "database" && o.kind !== "schema";
const objectKey = (o: PgObjectRef) => JSON.stringify([o.kind, o.schema, o.name, o.signature]);

/**
 * 칸 상세에서 객체 하나에 권한을 주는 창. 객체는 이 스키마 안에서 이름의 일부로 찾고(pg_objects의 `스키마.` 검색), 받는 역할은 칸의 역할이거나 모든 역할(PUBLIC)이다.
 * [담기]는 변경을 장바구니에 담을 뿐이고 적용은 장바구니에서 한다.
 */
export function GrantSheet({ target, database, schema, role, draft, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [object, setObject] = useState<PgObjectRef | null>(null);
  const [grantee, setGrantee] = useState(role);
  const [privileges, setPrivileges] = useState<string[]>([]);
  const text = useDebounced(query.trim(), SEARCH_DELAY_MS);
  const q = usePgObjects(target, database, `${schema}.${text}`);
  const found = (q.data ?? []).filter(inSchema(schema));
  const { sheetRef, trapTab } = useModal(onClose);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => searchRef.current?.focus(), []);
  const titleId = useId();
  const granteeId = useId();

  const choose = (next: PgObjectRef) => {
    setObject(next);
    // 고른 권한을 새 객체도 가지고 있는 것만 남긴다
    setPrivileges((current) => current.filter((p) => OBJECT_PRIVILEGES[next.kind].includes(p)));
  };

  const grantTarget = object ? grantTargetOf(object) : null;
  const ready = !!grantTarget && privileges.length > 0;
  const submit = () => {
    if (!grantTarget || privileges.length === 0) return;
    putChange(draft, { kind: "grant", database, grantee, add: true, items: [{ target: grantTarget, privileges }] });
    onClose();
  };

  return (
    <div className="modal">
      <div className="sheet pg-form" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={sheetRef} onKeyDown={trapTab}>
        <h3 id={titleId}>객체에 권한 주기</h3>
        <p>
          {database} 데이터베이스의 {schema} 스키마에서 객체를 찾아요
        </p>
        <input
          ref={searchRef}
          type="search"
          className="iam-filter pg-form-search"
          aria-label="객체 검색"
          placeholder={`${schema}. 뒤에 이름의 일부를 입력하세요`}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {!q.data && (q.isError ? <PgError error={q.error} target={target} /> : <div className="empty small">찾는 중…</div>)}
        {q.data && found.length === 0 && <div className="empty small">조건에 맞는 객체가 없어요</div>}
        {found.length > 0 && (
          <ul className="pg-form-list" aria-label="찾은 객체">
            {found.map((o) => (
              <li key={objectKey(o)}>
                <button type="button" className={`pg-form-opt${object && objectKey(object) === objectKey(o) ? " on" : ""}`} aria-pressed={!!object && objectKey(object) === objectKey(o)} onClick={() => choose(o)}>
                  <span className="mono">{objectName(o)}</span> <span className="dim">{OBJECT_KIND_LABEL[o.kind]}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {object && (
          <>
            <p className="pg-form-picked">
              고른 객체: <b className="mono">{objectName(object)}</b>
            </p>
            <label className="pg-form-field" htmlFor={granteeId}>
              받는 역할
            </label>
            <select id={granteeId} value={grantee} onChange={(e) => setGrantee(e.target.value)}>
              <option value={role}>{role}</option>
              <option value={PUBLIC}>{PUBLIC_LABEL}</option>
            </select>
            <PrivilegeChecks label="권한" options={OBJECT_PRIVILEGES[object.kind]} value={privileges} onChange={setPrivileges} />
          </>
        )}
        <div className="foot">
          <button className="btn plain" onClick={onClose}>
            취소
          </button>
          <button className="btn primary" disabled={!ready} onClick={submit}>
            담기
          </button>
        </div>
      </div>
    </div>
  );
}
