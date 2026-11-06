import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Highlight } from "../components/Highlight";
import { ListFind, useListFind } from "../components/ListFind";
import { fuzzyKeep, tokenize } from "../lib/fuzzy";
import { formatTtl, formatTtlShort } from "./format";
import { KeyDetail } from "./KeyDetail";
import { buildKeyTree, flattenTree, type TreeRow } from "./keyTree";
import { KvError } from "./KvError";
import { useKvScan } from "./queries";
import { keyId } from "./route";
import * as t from "./text";
import type { KvKeyName, KvKeyRow, KvOverview, KvTarget, KvType } from "./types";

const DEFAULT_PATTERN = "*";
const DEFAULT_DELIMITER = ":";
const INDENT_PX = 16;

const rowId = ({ node }: TreeRow) => (node.kind === "folder" ? `f:${node.path}` : node.id);

export function TypeBadge({ type }: { type: KvType }) {
  return <span className={`kv-type kv-type-${type}`}>{type}</span>;
}

/** SCAN은 같은 키를 두 번 줄 수 있다. 이름이 같은 키는 처음 것만 둔다(순서는 읽은 순서). */
function distinct(rows: readonly KvKeyRow[]): KvKeyRow[] {
  const seen = new Map<string, KvKeyRow>();
  for (const r of rows) if (!seen.has(keyId(r.name))) seen.set(keyId(r.name), r);
  return [...seen.values()];
}

interface Props {
  target: KvTarget;
  overview: KvOverview;
  /** 값 상세가 열려 있는 키 */
  openKey: KvKeyName | null;
  onOpenKey: (name: KvKeyName | null) => void;
  /** 이 탭이 보이는 탭일 때만 ⌘F를 받는다 */
  active: boolean;
}

/**
 * 키 화면: 패턴(SCAN MATCH)·타입 칩으로 읽고, 구분자로 묶은 폴더 트리로 보인다. 읽은 키 안에서는 ⌘F(퍼지)로 거른다.
 * 키를 고르면 오른쪽에 값 상세가 목록의 70%를 덮는다. 읽는 것은 1,000개씩이고 [더 읽기]로 잇는다.
 */
export function KeyBrowser({ target, overview, openKey, onOpenKey, active }: Props) {
  const box = useRef<HTMLElement>(null);
  const find = useListFind(box, { enabled: active });
  const [patternInput, setPatternInput] = useState(DEFAULT_PATTERN);
  const [pattern, setPattern] = useState(DEFAULT_PATTERN);
  const [typeFilter, setTypeFilter] = useState<KvType | null>(null);
  const [delimiter, setDelimiter] = useState(DEFAULT_DELIMITER);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  const scan = useKvScan(target, pattern, typeFilter, true);

  const keys = useMemo(() => distinct((scan.data?.pages ?? []).flatMap((p) => p.keys)), [scan.data]);
  const tokens = useMemo(() => tokenize(find.query), [find.query]);
  const kept = useMemo(() => fuzzyKeep(keys, find.query, (r) => [r.name.text]), [keys, find.query]);
  const tree = useMemo(() => buildKeyTree(kept, delimiter), [kept, delimiter]);
  // 찾는 중에는 맞은 키가 어느 폴더 안에 있든 보이도록 모두 펼친다
  const rows = useMemo(() => flattenTree(tree, tokens.length > 0 ? "all" : expanded), [tree, tokens.length, expanded]);

  const toggle = (path: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  const activate = (row: TreeRow) => {
    setCursor(rowId(row));
    if (row.node.kind === "folder") toggle(row.node.path);
    else onOpenKey(row.node.row.name);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const at = rows.findIndex((r) => rowId(r) === cursor);
    const current = at >= 0 ? rows[at] : null;
    const move = (to: number) => {
      e.preventDefault();
      const next = rows[Math.max(0, Math.min(rows.length - 1, to))];
      if (next) setCursor(rowId(next));
    };
    if (e.key === "ArrowDown") move(at + 1);
    else if (e.key === "ArrowUp") move(at < 0 ? 0 : at - 1);
    else if (e.key === "Enter" && current) {
      e.preventDefault();
      activate(current);
    } else if (e.key === "ArrowRight" && current?.node.kind === "folder" && !expanded.has(current.node.path)) {
      e.preventDefault();
      toggle(current.node.path);
    } else if (e.key === "ArrowLeft" && current?.node.kind === "folder" && expanded.has(current.node.path)) {
      e.preventDefault();
      toggle(current.node.path);
    }
  };

  const pending = scan.isPending;
  const total = overview.dbsize;
  const more = !!scan.hasNextPage;

  return (
    <section className="center detail-host kv-keys" ref={box} aria-label="키">
      <div className="kv-bar">
        <form
          className="kv-pattern"
          onSubmit={(e) => {
            e.preventDefault();
            setPattern(patternInput.trim() || DEFAULT_PATTERN);
          }}
        >
          <label className="kv-pattern-field">
            <small className="dim">{t.PATTERN_LABEL}</small>
            <input className="field-input mono" aria-label={t.PATTERN_LABEL} value={patternInput} onChange={(e) => setPatternInput(e.target.value)} spellCheck={false} autoComplete="off" />
          </label>
          <button type="submit" className="btn small tone-refresh">
            {t.PATTERN_READ}
          </button>
        </form>
        <div className="kv-chips" role="group" aria-label={t.TYPE_GROUP}>
          <button type="button" className={`kv-chip${typeFilter === null ? " on" : ""}`} aria-pressed={typeFilter === null} onClick={() => setTypeFilter(null)}>
            {t.TYPE_ALL}
          </button>
          {t.KEY_TYPES.map((type) => (
            <button key={type} type="button" className={`kv-chip${typeFilter === type ? " on" : ""}`} aria-pressed={typeFilter === type} onClick={() => setTypeFilter(typeFilter === type ? null : type)}>
              {type}
            </button>
          ))}
        </div>
        <label className="kv-delim">
          <small className="dim">{t.DELIMITER_LABEL}</small>
          <input className="field-input mono" aria-label={t.DELIMITER_LABEL} value={delimiter} onChange={(e) => setDelimiter(e.target.value)} spellCheck={false} autoComplete="off" />
        </label>
      </div>
      <div className="kv-status">
        <span>{t.KEYS_READ(keys.length, total)}</span>
        {scan.data && (more ? (
          <button type="button" className="btn small tone-secondary" disabled={scan.isFetchingNextPage} onClick={() => void scan.fetchNextPage()}>
            {scan.isFetchingNextPage ? t.READING : t.MORE}
          </button>
        ) : (
          <span className="dim">{t.READ_ALL}</span>
        ))}
      </div>
      <ListFind find={find} placeholder={t.FIND_PLACEHOLDER} count={kept.length} />
      {scan.isError && !scan.data ? (
        <KvError error={scan.error} target={target} />
      ) : pending ? (
        <div className="empty">{t.LOADING}</div>
      ) : (
        <>
          {scan.isError && <KvError compact error={scan.error} target={target} />}
          {rows.length === 0 ? (
            <div className="empty">{keys.length === 0 ? t.KEYS_EMPTY : t.KEYS_NO_MATCH}</div>
          ) : (
            <div className="tbl kv-tree" role="tree" aria-label={t.KEY_TREE} tabIndex={0} onKeyDown={onKeyDown}>
              {rows.map((row) => {
                const id = rowId(row);
                const { node, depth } = row;
                const open = node.kind === "folder" && (tokens.length > 0 || expanded.has(node.path));
                const opened = node.kind === "key" && openKey !== null && keyId(openKey) === node.id;
                return (
                  <div
                    key={id}
                    role="treeitem"
                    aria-level={depth + 1}
                    aria-expanded={node.kind === "folder" ? open : undefined}
                    aria-selected={opened || id === cursor}
                    className={`kv-row${opened ? " on" : ""}${id === cursor ? " cursor" : ""}`}
                    onClick={() => activate(row)}
                  >
                    <span className="kv-indent" style={{ width: depth * INDENT_PX }} aria-hidden="true" />
                    {node.kind === "folder" ? (
                      <>
                        <span className="kv-caret" aria-hidden="true">
                          {open ? "▾" : "▸"}
                        </span>
                        <span className="kv-label">
                          <Highlight text={node.label || t.EMPTY_LABEL} tokens={tokens} />
                        </span>
                        <span className="kv-count dim">{t.FOLDER_COUNT(node.count)}</span>
                      </>
                    ) : (
                      <>
                        <span className="kv-caret" aria-hidden="true" />
                        <span className="kv-label mono">
                          <Highlight text={node.label || t.EMPTY_LABEL} tokens={tokens} />
                        </span>
                        {node.row.name.base64 !== null && <span className="iam-chip">{t.BINARY_NAME}</span>}
                        <span className="kv-row-end">
                          <TypeBadge type={node.row.type} />
                          <span className="kv-ttl dim" title={formatTtl(node.row.ttlMs, scan.dataUpdatedAt)}>
                            {node.row.ttlMs === null ? t.DASH : formatTtlShort(node.row.ttlMs)}
                          </span>
                        </span>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
      {openKey && <KeyDetail key={keyId(openKey)} target={target} name={openKey} unsupported={overview.unsupported} onClose={() => onOpenKey(null)} />}
    </section>
  );
}
