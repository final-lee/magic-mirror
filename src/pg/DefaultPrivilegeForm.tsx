import { useId, useState } from "react";
import { useModal } from "../iam/useModal";
import { PrivilegeChecks } from "./PrivilegeChecks";
import { putChange } from "./putChange";
import { ALL_SCHEMAS, DEFAULT_OBJECT_LABEL, DEFAULT_OBJECT_ORDER, PUBLIC_LABEL } from "./sentences";
import type { PgDefaultObjectType } from "./types";
import type { GridDraft } from "./useChangeMode";

/** 객체 종류마다 기본 권한으로 줄 수 있는 권한 */
export const DEFAULT_PRIVILEGES: Record<PgDefaultObjectType, string[]> = {
  tables: ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"],
  sequences: ["USAGE", "SELECT", "UPDATE"],
  functions: ["EXECUTE"],
  types: ["USAGE"],
  schemas: ["USAGE", "CREATE"],
};

const PUBLIC = "PUBLIC";
/** 모든 스키마를 가리키는 select의 값(스키마 이름은 빈 문자열일 수 없다) */
const EVERY_SCHEMA = "";

interface Props {
  database: string;
  /** 만드는 역할로 고를 수 있는 역할(시스템 역할이 아닌 것) */
  creators: string[];
  /** 받는 역할로 고를 수 있는 역할 */
  grantees: string[];
  schemas: string[];
  draft: GridDraft;
  onClose: () => void;
}

/**
 * 기본 권한 하나를 장바구니에 담는 창: 만드는 역할, 스키마(또는 모든 스키마), 객체 종류, 받는 역할, 그 종류의 권한.
 * 객체 종류가 스키마이면 스키마는 모든 스키마로 고정된다(스키마의 기본 권한은 모든 스키마에만 줄 수 있다).
 */
export function DefaultPrivilegeForm({ database, creators, grantees, schemas, draft, onClose }: Props) {
  const [creator, setCreator] = useState(creators[0] ?? "");
  const [schema, setSchema] = useState(EVERY_SCHEMA);
  const [objectType, setObjectType] = useState<PgDefaultObjectType>("tables");
  const [grantee, setGrantee] = useState(grantees[0] ?? PUBLIC);
  const [privileges, setPrivileges] = useState<string[]>([]);
  const { sheetRef, trapTab } = useModal(onClose);
  const ids = [useId(), useId(), useId(), useId(), useId()];
  const fixed = objectType === "schemas";

  const chooseType = (next: PgDefaultObjectType) => {
    setObjectType(next);
    if (next === "schemas") setSchema(EVERY_SCHEMA);
    setPrivileges((current) => current.filter((p) => DEFAULT_PRIVILEGES[next].includes(p)));
  };
  const ready = creator !== "" && privileges.length > 0;
  const submit = () => {
    if (!ready) return;
    putChange(draft, { kind: "defaultPrivilege", database, creator, schema: fixed || schema === EVERY_SCHEMA ? null : schema, objectType, grantee, privileges, add: true });
    onClose();
  };

  return (
    <div className="modal">
      <div className="sheet pg-form" role="dialog" aria-modal="true" aria-labelledby={ids[0]} ref={sheetRef} onKeyDown={trapTab}>
        <h3 id={ids[0]}>기본 권한 추가</h3>
        <p>{database} 데이터베이스에서 앞으로 만들 객체가 받을 권한이에요</p>
        <label className="pg-form-field" htmlFor={ids[1]}>
          만드는 역할
        </label>
        <select id={ids[1]} value={creator} onChange={(e) => setCreator(e.target.value)}>
          {creators.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <label className="pg-form-field" htmlFor={ids[2]}>
          스키마
        </label>
        <select id={ids[2]} value={schema} disabled={fixed} onChange={(e) => setSchema(e.target.value)}>
          <option value={EVERY_SCHEMA}>{ALL_SCHEMAS}</option>
          {schemas.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <label className="pg-form-field" htmlFor={ids[3]}>
          객체 종류
        </label>
        <select id={ids[3]} value={objectType} onChange={(e) => chooseType(e.target.value as PgDefaultObjectType)}>
          {DEFAULT_OBJECT_ORDER.map((type) => (
            <option key={type} value={type}>
              {DEFAULT_OBJECT_LABEL[type]}
            </option>
          ))}
        </select>
        <label className="pg-form-field" htmlFor={ids[4]}>
          받는 역할
        </label>
        <select id={ids[4]} value={grantee} onChange={(e) => setGrantee(e.target.value)}>
          {grantees.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
          <option value={PUBLIC}>{PUBLIC_LABEL}</option>
        </select>
        <PrivilegeChecks label="권한" options={DEFAULT_PRIVILEGES[objectType]} value={privileges} onChange={setPrivileges} />
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
