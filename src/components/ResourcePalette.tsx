import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { errorMessage } from "../api/errors";
import { GLOBAL, useResourceIndex } from "../api/queries";
import type { IndexedResource, ResourceType, ServiceInfo } from "../api/types";
import { useModal } from "../iam/useModal";
import { fuzzyRank, tokenize } from "../lib/fuzzy";
import { Highlight } from "./Highlight";
import { resourceSearchFields } from "./ResourceTable";
import { ServiceBadge } from "./ServiceBadge";

export interface PalettePick {
  /** 전역 서비스면 "global" */
  region: string;
  service: string;
  type: string;
  id: string;
}

interface Props {
  profile: string;
  /** 사이드바에 보이는(설정에서 켠) 서비스. 끈 서비스의 캐시는 찾지 않는다 */
  services: ServiceInfo[];
  /** 이보다 오래 전에 읽은 목록은 오래됐다고 표시한다 */
  ttlMs: number;
  onPick: (pick: PalettePick) => void;
  onClose: () => void;
  /** 테스트용 지금 시각 */
  now?: number;
}

interface Entry {
  key: string;
  service: ServiceInfo;
  type: ResourceType;
  region: string;
  item: IndexedResource;
  fetchedAt: number;
  fields: string[];
}

/** 한 번에 보여 주는 결과 수. 잘 맞는 것부터 자른다 */
export const PALETTE_LIMIT = 100;
export const PALETTE_TITLE = "리소스 찾기";

function ageText(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}시간 전`;
  return `${Math.floor(minutes / 1440)}일 전`;
}

/**
 * ⌘K: 이 프로필로 읽어 둔 모든 리소스 목록(리전·종류 전부)에서 퍼지로 찾는다. AWS는 부르지 않는다.
 * 목록은 백엔드가 읽을 때마다 남기는 검색용 사본이라 앱을 다시 켜도 남아 있다(7일). 고르면 그 리전·종류로 가서 그 행을 고른다.
 */
export function ResourcePalette({ profile, services, ttlMs, onPick, onClose, now }: Props) {
  const index = useResourceIndex(profile);
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const { sheetRef, trapTab } = useModal(onClose);
  useEffect(() => searchRef.current?.focus(), []);

  const entries = useMemo(() => {
    const out: Entry[] = [];
    for (const list of index.data ?? []) {
      const service = services.find((s) => s.id === list.service);
      const type = service?.types.find((t) => t.id === list.typeId);
      if (!service || !type) continue;
      const where = list.region === GLOBAL ? "" : list.region;
      for (const item of list.items) {
        out.push({
          key: `${list.region}|${service.id}|${type.id}|${item.id}`,
          service,
          type,
          region: list.region,
          item,
          fetchedAt: list.fetchedAt,
          fields: [...resourceSearchFields(item, type.columns), service.name, type.name, where],
        });
      }
    }
    return out;
  }, [index.data, services]);
  const lists = useMemo(() => new Set(entries.map((e) => `${e.region}|${e.service.id}|${e.type.id}`)).size, [entries]);

  const tokens = useMemo(() => tokenize(deferred), [deferred]);
  const ranked = useMemo(() => (tokens.length === 0 ? [] : fuzzyRank(entries, deferred, (e) => e.fields)), [entries, deferred, tokens]);
  const shown = ranked.slice(0, PALETTE_LIMIT).map((r) => r.item);
  const activeIndex = Math.max(0, shown.findIndex((e) => e.key === activeKey));
  const active = shown[activeIndex];
  const at = now ?? Date.now();

  useEffect(() => {
    if (active) document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, activeIndex, listId]);

  const pick = (e: Entry) => onPick({ region: e.region, service: e.service.id, type: e.type.id, id: e.item.id });

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = shown[Math.min(shown.length - 1, Math.max(0, activeIndex + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) setActiveKey(next.key);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active) pick(active);
    }
  };

  let status: string | null = null;
  if (index.isError) status = errorMessage(index.error);
  else if (index.isPending) status = "불러오는 중…";
  else if (entries.length === 0) status = "아직 읽어 둔 목록이 없어요. 왼쪽에서 리소스 종류를 열면 여기서 찾을 수 있어요";
  else if (tokens.length === 0) status = `읽어 둔 목록 ${lists}개, 리소스 ${entries.length.toLocaleString()}개에서 찾아요. 글자 일부만 순서대로 쳐도 되고, 공백으로 나누면 모두 맞는 것만 보여요`;
  else if (shown.length === 0) status = "맞는 리소스가 없어요";

  return (
    <div className="modal">
      <div className="sheet wide pk palette" role="dialog" aria-modal="true" aria-label={PALETTE_TITLE} ref={sheetRef} onKeyDown={trapTab}>
        <input
          ref={searchRef}
          type="search"
          className="iam-filter pk-search"
          aria-label={PALETTE_TITLE}
          aria-controls={listId}
          aria-activedescendant={active ? `${listId}-${activeIndex}` : undefined}
          placeholder="이름, ID, 태그, 종류, 리전으로 찾기"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveKey(null);
          }}
          onKeyDown={onKeyDown}
        />
        {status && <div className={`empty small${index.isError ? " err" : ""}`}>{status}</div>}
        {shown.length > 0 && (
          <ul className="pk-list" id={listId} role="listbox" aria-label={`${PALETTE_TITLE} 결과`}>
            {shown.map((e, i) => {
              const age = at - e.fetchedAt;
              return (
                // 마우스를 눌러도 검색 상자가 초점을 잃지 않게 mousedown은 막고, 고르는 일은 click에서 한다
                <li
                  key={e.key}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === activeIndex}
                  className={`pk-opt${i === activeIndex ? " on" : ""}`}
                  onMouseDown={(ev) => ev.preventDefault()}
                  onMouseMove={() => setActiveKey(e.key)}
                  onClick={() => pick(e)}
                >
                  <div className="pk-top">
                    <ServiceBadge service={e.service} />
                    <span className="pk-name">
                      <Highlight text={e.item.name} tokens={tokens} />
                    </span>
                    {e.item.id !== e.item.name && (
                      <span className="mono dim">
                        <Highlight text={e.item.id} tokens={tokens} />
                      </span>
                    )}
                    <span className="pal-where dim">
                      {e.service.name} › {e.type.name} · {e.region === GLOBAL ? "전역" : e.region}
                    </span>
                    <span className={`pal-age${age >= ttlMs ? " stale" : ""}`} title={new Date(e.fetchedAt).toLocaleString("ko-KR")}>
                      {ageText(age)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {ranked.length > PALETTE_LIMIT && <p className="pk-note">잘 맞는 {PALETTE_LIMIT}개만 보여요. 글자를 더 쳐서 좁혀 보세요</p>}
        <p className="pk-note">↑↓로 고르고 Enter로 열어요. 오래된 목록(노란 시각)은 열면 다시 읽어요.</p>
      </div>
    </div>
  );
}
