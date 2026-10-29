import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useModal } from "../iam/useModal";
import { useDebounced } from "../lib/useDebounced";
import { MEMBERSHIP_SYSTEM_GROUPS, changeBlockReason } from "./canChange";
import { collate, dayToIso } from "./labels";
import { PgError } from "./PgError";
import { usePgDatabase, usePgPreset } from "./queries";
import { nameTakenText, roleNameProblem } from "./roleName";
import type { PgChange, PgOverview, PgPresetChoice, PgPresetKind, PgTarget } from "./types";

/** 프리셋을 고른 뒤 제안을 부르기까지 기다리는 시간. 스키마를 연달아 고르는 동안에는 부르지 않는다 */
export const PRESET_DELAY_MS = 300;

const PRESETS: { id: PgPresetKind | null; label: string; description: string | null }[] = [
  { id: null, label: "없음", description: null },
  { id: "readOnly", label: "읽기 전용", description: "고른 스키마의 테이블과 시퀀스를 읽어요" },
  { id: "readWrite", label: "읽기·쓰기", description: "읽기에 더해 테이블에 쓰고 시퀀스를 써요" },
  { id: "owner", label: "소유자(마이그레이션)", description: "고른 스키마에 객체를 만들 수 있어요" },
  { id: "admin", label: "관리자", description: "rds_superuser 구성원이 돼요" },
];

/** 기본 권한을 줄 역할을 고르는 프리셋 */
const hasCreators = (preset: PgPresetKind | null) => preset === "readOnly" || preset === "readWrite";

interface Props {
  target: PgTarget;
  overview: PgOverview;
  /** 탭이 고른 데이터베이스. 프리셋의 데이터베이스 처음 값이다 */
  database: string;
  /** [미리보기]: 변경을 미리보기 흐름으로 넘긴다. 적용에 성공하면 호출한 쪽이 이 창을 닫는다 */
  onPreview: (change: PgChange) => void;
  onClose: () => void;
}

type Existing = "existing" | "new";

/**
 * 역할 만들기 창: 이름, 종류(사용자 또는 그룹), 속할 그룹, 연결 수 제한, 만료일과 프리셋(스키마별로 권한을 한 번에 주는 묶음).
 * 프리셋의 데이터베이스와 스키마를 고르면 잠시 뒤 pg_preset으로 제안을 받는다: 같은 권한을 가진 그룹, 새 그룹의 이름, 기본 권한을 줄 역할.
 * [미리보기]는 createRole 변경을 만들어 미리보기 창으로 넘긴다. 사용자를 만들면 적용 뒤에 그 창이 새 비밀번호를 한 번 보여 준다.
 */
export function CreateRoleDialog({ target, overview, database, onPreview, onClose }: Props) {
  const { sheetRef, trapTab } = useModal(onClose);
  const id = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => nameRef.current?.focus(), []);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"user" | "group">("user");
  const [groups, setGroups] = useState<string[]>([]);
  const [unlimited, setUnlimited] = useState(true);
  const [limit, setLimit] = useState("");
  const [noExpiry, setNoExpiry] = useState(true);
  const [day, setDay] = useState("");
  const [preset, setPreset] = useState<PgPresetKind | null>(null);
  const connectable = overview.databases.filter((d) => d.allowConn);
  const [db, setDb] = useState(connectable.some((d) => d.name === database) ? database : (connectable[0]?.name ?? database));
  const [schemas, setSchemas] = useState<string[]>([]);
  // 제안을 받은 뒤 사용자가 바꾼 것. 바꾸지 않은 것은 제안의 처음 값을 따른다
  const [groupChoice, setGroupChoice] = useState<Existing | null>(null);
  const [existingGroup, setExistingGroup] = useState<string | null>(null);
  const [newGroup, setNewGroup] = useState<string | null>(null);
  const [creatorsOff, setCreatorsOff] = useState<string[]>([]);

  const blockReason = changeBlockReason(overview.target, overview);
  const isUser = kind === "user";
  const needsSchemas = preset !== null && preset !== "admin";

  const database$ = usePgDatabase(target, needsSchemas ? db : null);
  const schemaNames = useMemo(() => database$.data?.schemas.map((s) => s.name) ?? [], [database$.data]);

  // 제안은 데이터베이스·프리셋·스키마의 마지막 변경 뒤 PRESET_DELAY_MS가 지나야 받는다. 기다리는 동안에는 이전 제안을 쓰지 않는다
  // 고른 스키마는 이름순으로 한 번만 가다듬어, 제안을 부르는 키·인자와 보내는 변경이 같은 목록을 쓴다
  const selected = useMemo(() => [...schemas].sort(collate), [schemas]);
  const wanted = needsSchemas && selected.length > 0 ? JSON.stringify([db, preset, selected]) : null;
  const settled = useDebounced(wanted, PRESET_DELAY_MS);
  const asked = useMemo(() => (settled ? (JSON.parse(settled) as [string, PgPresetKind, string[]]) : null), [settled]);
  const suggestion$ = usePgPreset(target, asked?.[0] ?? null, asked?.[1] ?? null, asked?.[2] ?? []);
  const waiting = wanted !== null && wanted !== settled;
  const suggestion = wanted !== null && !waiting ? suggestion$.data : undefined;

  const groupList = overview.roles
    .filter((r) => r.kind === "group" && (r.system ? MEMBERSHIP_SYSTEM_GROUPS.includes(r.name) : true))
    .sort((a, b) => collate(a.name, b.name));

  const matching = suggestion?.matching ?? [];
  // 새 제안에 같은 권한을 가진 그룹이 없으면 "그룹에 넣어요"는 고를 수 없으니 새 그룹 쪽이 선택된다(체크된 라디오가 늘 하나 있다)
  const choice: Existing = matching.length === 0 ? "new" : (groupChoice ?? "existing");
  const chosenGroup = existingGroup && matching.includes(existingGroup) ? existingGroup : matching[0];
  const groupName = newGroup ?? suggestion?.proposedName ?? "";
  const usesNewGroup = isUser && suggestion !== undefined && choice === "new";
  const usesExisting = isUser && suggestion !== undefined && choice === "existing" && matching.length > 0;
  const showCreators = hasCreators(preset) && suggestion !== undefined && !usesExisting;
  const blocked = suggestion?.blockedCreators ?? [];
  const creators = (suggestion?.creators ?? []).filter((c) => !creatorsOff.includes(c));

  // 이름은 있는 그대로 쓴다(앞뒤 공백도 이름의 일부다). 아직 비어 있는 칸은 탓하지 않는다
  const nameProblem = name === "" ? null : roleNameProblem(name, overview.roles);
  const groupProblem = usesNewGroup ? (groupName === name && name !== "" ? nameTakenText(name) : roleNameProblem(groupName, overview.roles)) : null;
  const limitValue = unlimited ? -1 : /^\d+$/.test(limit.trim()) ? Number(limit.trim()) : null;
  const expiryValue = noExpiry ? null : /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined;

  const presetReady = preset === null || preset === "admin" || (selected.length > 0 && suggestion !== undefined && (!usesNewGroup || (groupName !== "" && groupProblem === null)));
  const ready = name !== "" && nameProblem === null && limitValue !== null && expiryValue !== undefined && presetReady;

  function build(): PgChange | null {
    if (!ready || limitValue === null || expiryValue === undefined) return null;
    let choiceOut: PgPresetChoice | null = null;
    if (preset === "admin") {
      choiceOut = { preset, database: null, schemas: [], creators: [], group: null, createGroup: false };
    } else if (preset !== null) {
      choiceOut = {
        preset,
        database: db,
        schemas: selected,
        creators: showCreators ? creators : [],
        group: usesExisting ? (chosenGroup ?? null) : usesNewGroup ? groupName : null,
        createGroup: usesNewGroup,
      };
    }
    return {
      kind: "createRole",
      name,
      login: isUser,
      groups: groupList.map((g) => g.name).filter((g) => groups.includes(g)),
      connectionLimit: limitValue,
      validUntil: expiryValue === null ? null : dayToIso(expiryValue),
      preset: choiceOut,
    };
  }

  const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  const pickDatabase = (next: string) => {
    setDb(next);
    setSchemas([]);
  };

  return (
    <div className="modal">
      <div className="sheet wide pg-form pg-create" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} ref={sheetRef} onKeyDown={trapTab}>
        <h3 id={`${id}-title`}>역할 만들기</h3>
        <div className="pg-create-body">
          <label className="pg-form-field" htmlFor={`${id}-name`}>
            이름
          </label>
          <input id={`${id}-name`} ref={nameRef} value={name} autoComplete="off" autoCapitalize="off" spellCheck={false} onChange={(e) => setName(e.target.value)} />
          {nameProblem && (
            <span className="err" role="alert">
              {nameProblem}
            </span>
          )}

          <fieldset className="pg-form-checks pg-create-kind">
            <legend>종류</legend>
            <label className="pg-form-check">
              <input type="radio" name={`${id}-kind`} checked={isUser} onChange={() => setKind("user")} /> 사용자
            </label>
            <label className="pg-form-check">
              <input type="radio" name={`${id}-kind`} checked={!isUser} onChange={() => setKind("group")} /> 그룹
            </label>
          </fieldset>

          <fieldset className="pg-form-checks pg-group-checks">
            <legend>속할 그룹</legend>
            {groupList.length === 0 && <span className="dim">고를 수 있는 그룹이 없어요</span>}
            {groupList.map((g) => (
              <label key={g.name} className="pg-form-check">
                <input type="checkbox" checked={groups.includes(g.name)} onChange={() => setGroups(toggle(groups, g.name))} /> {g.name}
              </label>
            ))}
          </fieldset>

          <div className="pg-attr-row">
            <label htmlFor={`${id}-limit`}>연결 수 제한</label>
            <input id={`${id}-limit`} type="number" min={0} step={1} value={limit} disabled={unlimited} onChange={(e) => setLimit(e.target.value)} />
            <label className="pg-form-check">
              <input type="checkbox" checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)} /> 제한 없음
            </label>
          </div>
          <div className="pg-attr-row">
            <label htmlFor={`${id}-until`}>만료일</label>
            <input id={`${id}-until`} type="date" value={day} disabled={noExpiry} onChange={(e) => setDay(e.target.value)} />
            <label className="pg-form-check">
              <input type="checkbox" checked={noExpiry} onChange={(e) => setNoExpiry(e.target.checked)} /> 없음
            </label>
          </div>

          <fieldset className="pg-create-presets">
            <legend>프리셋</legend>
            {PRESETS.map((p) => (
              <label key={p.id ?? "none"} className="pg-create-preset">
                <input
                  type="radio"
                  name={`${id}-preset`}
                  checked={preset === p.id}
                  aria-describedby={p.description ? `${id}-${p.id}` : undefined}
                  onChange={() => {
                    // 스키마를 고르는 프리셋끼리 바꿀 때는 고른 스키마를 지킨다
                    if (!(needsSchemas && p.id !== null && p.id !== "admin")) setSchemas([]);
                    setPreset(p.id);
                  }}
                />
                <span>
                  <b>{p.label}</b>
                  {p.description && (
                    <span id={`${id}-${p.id}`} className="dim">
                      {" "}
                      {p.description}
                    </span>
                  )}
                </span>
              </label>
            ))}
          </fieldset>

          {needsSchemas && (
            <>
              <label className="pg-form-field" htmlFor={`${id}-db`}>
                데이터베이스
              </label>
              <select id={`${id}-db`} value={db} onChange={(e) => pickDatabase(e.target.value)}>
                {connectable.map((d) => (
                  <option key={d.name} value={d.name}>
                    {d.name}
                  </option>
                ))}
              </select>
              <fieldset className="pg-form-checks pg-group-checks">
                <legend>스키마</legend>
                {!database$.data && (database$.isError ? <PgError error={database$.error} target={target} /> : <span className="dim">스키마를 불러오는 중…</span>)}
                {database$.data && schemaNames.length === 0 && <span className="dim">고를 수 있는 스키마가 없어요</span>}
                {schemaNames.map((s) => (
                  <label key={s} className="pg-form-check">
                    <input type="checkbox" checked={schemas.includes(s)} onChange={() => setSchemas(toggle(schemas, s))} /> {s}
                  </label>
                ))}
              </fieldset>
              {selected.length > 0 && !suggestion && (suggestion$.isError && !waiting ? <PgError error={suggestion$.error} target={target} /> : <p className="dim">제안을 불러오는 중…</p>)}
              {suggestion && !isUser && matching.length > 0 && <p className="pg-note">{`같은 권한을 가진 그룹이 이미 있어요: ${matching.join(", ")}`}</p>}
              {suggestion && isUser && (
                <fieldset className="pg-create-groups">
                  <legend>권한을 받을 그룹</legend>
                  {matching.length > 0 && (
                    <div className="pg-create-opt">
                      <label className="pg-form-check">
                        <input type="radio" name={`${id}-grp`} checked={choice === "existing"} onChange={() => setGroupChoice("existing")} /> 같은 권한을 가진 그룹에 넣어요
                      </label>
                      <select aria-label="같은 권한을 가진 그룹" value={chosenGroup} disabled={choice !== "existing"} onChange={(e) => setExistingGroup(e.target.value)}>
                        {matching.map((g) => (
                          <option key={g} value={g}>
                            {g}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="pg-create-opt">
                    <label className="pg-form-check">
                      <input type="radio" name={`${id}-grp`} checked={choice === "new"} onChange={() => setGroupChoice("new")} /> 새 그룹을 만들어요
                    </label>
                    <input aria-label="새 그룹 이름" value={groupName} disabled={choice !== "new"} autoComplete="off" spellCheck={false} onChange={(e) => setNewGroup(e.target.value)} />
                  </div>
                  {groupProblem && (
                    <span className="err" role="alert">
                      {groupProblem}
                    </span>
                  )}
                </fieldset>
              )}
              {showCreators && (
                <fieldset className="pg-form-checks pg-group-checks">
                  <legend>기본 권한을 줄 역할</legend>
                  <p className="dim">앞으로 이 역할들이 만드는 테이블과 시퀀스에도 같은 권한을 줘요</p>
                  {(suggestion?.creators ?? []).map((c) => (
                    <label key={c} className="pg-form-check">
                      <input type="checkbox" checked={!creatorsOff.includes(c)} onChange={() => setCreatorsOff(toggle(creatorsOff, c))} /> {c}
                    </label>
                  ))}
                  {blocked.map((b) => (
                    <label key={b.role} className="pg-form-check">
                      <input type="checkbox" checked={false} disabled readOnly /> {b.role} <span className="dim">{b.reason}</span>
                    </label>
                  ))}
                </fieldset>
              )}
            </>
          )}
        </div>
        <div className="foot">
          <button className="btn plain" onClick={onClose}>
            취소
          </button>
          <button
            className="btn primary"
            disabled={!ready || blockReason !== null}
            title={blockReason ?? undefined}
            aria-description={blockReason ?? undefined}
            onClick={() => {
              const change = build();
              if (change) onPreview(change);
            }}
          >
            미리보기
          </button>
        </div>
      </div>
    </div>
  );
}
