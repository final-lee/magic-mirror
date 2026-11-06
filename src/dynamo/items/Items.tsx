import { useEffect, useMemo, useState } from "react";
import { desktop } from "../../api/desktop";
import { errorMessage } from "../../api/errors";
import { fuzzyKeep } from "../../lib/fuzzy";
import type { DetailContext } from "../TableDetail";
import { useDynamoChange } from "../change/ChangeFlow";
import type { DynamoChange } from "../change/types";
import type { DynamoTable } from "../types";
import { itemsApi } from "./api";
import { ItemDetail } from "./ItemDetail";
import { ItemEditor } from "./ItemEditor";
import { tableStoreKey, updateItems, useItems } from "./store";
import * as t from "./text";
import type { Attribute, Condition, Item, ItemPage, ReadRequest } from "./types";
import { summary } from "./value";

interface FilterRow { attribute: string; op: string; type: string; value: string }
interface QueryFormState {
  kind: ReadKind; setKind: React.Dispatch<React.SetStateAction<ReadKind>>;
  index: string; setIndex: React.Dispatch<React.SetStateAction<string>>;
  pk: string; setPk: React.Dispatch<React.SetStateAction<string>>;
  skOp: string; setSkOp: React.Dispatch<React.SetStateAction<string>>;
  skValue: string; setSkValue: React.Dispatch<React.SetStateAction<string>>;
  filters: FilterRow[]; setFilters: React.Dispatch<React.SetStateAction<FilterRow[]>>;
  projection: string; setProjection: React.Dispatch<React.SetStateAction<string>>;
  forward: boolean; setForward: React.Dispatch<React.SetStateAction<boolean>>;
  consistent: boolean; setConsistent: React.Dispatch<React.SetStateAction<boolean>>;
  limit: string; setLimit: React.Dispatch<React.SetStateAction<string>>;
  statement: string; setStatement: React.Dispatch<React.SetStateAction<string>>;
  selectedIndex: DynamoTable["indexes"][number] | undefined;
  keys: DynamoTable["keys"];
  build: () => ReadRequest;
}

type ReadKind = ReadRequest["kind"];
const ops = ["=", "<>", "<", "<=", ">", ">=", "between", "begins_with", "contains", "exists", "not_exists", "in"];

function conditions(rows: FilterRow[]): Condition[] {
  return rows.map(row => ({
    attribute: row.attribute,
    op: row.op,
    values: ["exists", "not_exists"].includes(row.op) ? [] :
      (row.op === "between" || row.op === "in" ? row.value.split(",") : [row.value])
        .map(value => ({ [row.type]: value.trim() })),
  }));
}

function useQueryForm(table: DynamoTable): QueryFormState {
  const [kind, setKind] = useState<ReadKind>("scan");
  const [index, setIndex] = useState("");
  const [pk, setPk] = useState("");
  const [skOp, setSkOp] = useState("");
  const [skValue, setSkValue] = useState("");
  const [filters, setFilters] = useState<FilterRow[]>([]);
  const [projection, setProjection] = useState("");
  const [forward, setForward] = useState(true);
  const [consistent, setConsistent] = useState(false);
  const [limit, setLimit] = useState("");
  const [statement, setStatement] = useState(`SELECT * FROM "${table.name}"`);
  const selectedIndex = table.indexes.find(item => item.name === index);
  const keys = selectedIndex ?? table.keys;

  function build(): ReadRequest {
    const common = {
      index: index || null, isGsi: selectedIndex?.kind === "gsi", filters: conditions(filters),
      projection: projection.split(",").map(value => value.trim()).filter(Boolean),
      consistent, limit: limit ? Number(limit) : null, startKey: null,
    };
    if (kind === "scan") return { kind, ...common };
    if (kind === "partiql") return { kind, statement, consistent, nextToken: null };
    const attribute = (type: string, value: string): Attribute => ({ [type]: value });
    return {
      kind, ...common, keySchema: { pk: keys.pk, sk: keys.sk }, pk: attribute(keys.pk.type, pk),
      sk: skOp ? { op: skOp, values: (skOp === "between" ? skValue.split(",") : [skValue])
        .map(value => attribute(keys.sk?.type ?? "S", value.trim())) } : null,
      forward,
    };
  }
  return { kind, setKind, index, setIndex, pk, setPk, skOp, setSkOp, skValue, setSkValue,
    filters, setFilters, projection, setProjection, forward, setForward, consistent, setConsistent,
    limit, setLimit, statement, setStatement, selectedIndex, keys, build };
}

function QueryBuilder({ table, form }: { table: DynamoTable; form: QueryFormState }) {

  const { kind, keys } = form;
  function updateFilter(index: number, patch: Partial<FilterRow>) {
    form.setFilters(rows => rows.map((row, position) => position === index ? { ...row, ...patch } : row));
  }
  return <>
    <div className="ddb-items-actions">
      <label>읽기 방식 <select value={kind} onChange={event => form.setKind(event.target.value as ReadKind)}>
        <option value="scan">Scan</option><option value="query">Query</option><option value="partiql">PartiQL</option>
      </select></label>
      {kind !== "partiql" && <label>대상 <select value={form.index} onChange={event => { form.setIndex(event.target.value); form.setConsistent(false); }}>
        <option value="">기본 테이블</option>{table.indexes.map(index => <option key={index.name} value={index.name}>{index.name}</option>)}
      </select></label>}
    </div>
    {kind === "scan" && <p className="dim">{t.SCAN_WARNING}</p>}
    {kind === "partiql" && <><p className="dim">{t.PARTIQL_WARNING}</p><textarea rows={3} value={form.statement} onChange={event => form.setStatement(event.target.value)} /></>}
    {kind === "query" && <div className="ddb-items-actions">
      <label>{keys.pk.name} ({keys.pk.type}) <input value={form.pk} onChange={event => form.setPk(event.target.value)} /></label>
      {keys.sk && <><label>{keys.sk.name} <select value={form.skOp} onChange={event => form.setSkOp(event.target.value)}>
        <option value="">조건 없음</option>{["=", "<", "<=", ">", ">=", "between", "begins_with"].map(op => <option key={op}>{op}</option>)}
      </select></label>{form.skOp && <input aria-label="정렬 키 값" value={form.skValue} onChange={event => form.setSkValue(event.target.value)} placeholder="값 (between은 쉼표로 구분)" />}</>}
      <label><input type="checkbox" checked={form.forward} onChange={event => form.setForward(event.target.checked)} /> 오름차순</label>
    </div>}
    {kind !== "partiql" && <>
      <details><summary>필터와 프로젝션</summary>
        {form.filters.map((row, index) => <div className="ddb-items-actions" key={index}>
          <input aria-label="필터 속성" placeholder="속성" value={row.attribute} onChange={event => updateFilter(index, { attribute: event.target.value })} />
          <select aria-label="필터 연산" value={row.op} onChange={event => updateFilter(index, { op: event.target.value })}>{ops.map(op => <option key={op}>{op}</option>)}</select>
          <select aria-label="필터 타입" value={row.type} onChange={event => updateFilter(index, { type: event.target.value })}>{["S", "N", "B"].map(type => <option key={type}>{type}</option>)}</select>
          <input aria-label="필터 값" value={row.value} placeholder="값 (여러 값은 쉼표)" onChange={event => updateFilter(index, { value: event.target.value })} />
          <button className="btn small tone-secondary" onClick={() => form.setFilters(rows => rows.filter((_, position) => position !== index))}>조건 빼기</button>
        </div>)}
        <button className="btn small tone-secondary" onClick={() => form.setFilters(rows => [...rows, { attribute: "", op: "=", type: "S", value: "" }])}>조건 추가</button>
        <label>프로젝션 (쉼표 구분) <input value={form.projection} onChange={event => form.setProjection(event.target.value)} /></label>
      </details>
      <label>페이지 개수 <input type="number" min="1" value={form.limit} onChange={event => form.setLimit(event.target.value)} /></label>
    </>}
  </>;
}

function PagingBar({ form, page, busy, run, next }: { form: QueryFormState; page: ItemPage | null; busy: boolean; run: () => void; next: () => void }) {
  return <div className="ddb-items-actions">
    <label><input type="checkbox" checked={form.consistent} disabled={form.selectedIndex?.kind === "gsi"} onChange={event => form.setConsistent(event.target.checked)} /> 강한 일관성</label>
    <button className="btn small tone-refresh" disabled={busy} onClick={run}>{form.kind === "scan" && !page ? t.FIRST_SCAN : t.SEND}</button>
    <button className="btn small tone-secondary" disabled={busy || !page || !(page.lastKey || page.nextToken)} onClick={next}>{t.NEXT_PAGE}</button>
  </div>;
}

function ExportControls({ table, items, onError }: { table: string; items: Item[]; onError: (error: string) => void }) {
  const [format, setFormat] = useState("ddbJsonl");
  async function save() {
    try {
      const path = await itemsApi.exportPath(`${table}.${format === "csv" ? "csv" : "jsonl"}`);
      if (path) await itemsApi.export(path, items, format);
    } catch (error) { onError(errorMessage(error)); }
  }
  return <><select aria-label="내보내기 형식" value={format} onChange={event => setFormat(event.target.value)}>
    <option value="ddbJsonl">DynamoDB JSONL</option><option value="jsonl">일반 JSONL</option><option value="csv">CSV</option>
  </select><button className="btn small tone-secondary" disabled={!items.length} onClick={() => void save()}>{t.EXPORT}</button></>;
}

function ResultsTable({ table, items, columns, onError, onEdit, onDuplicate, onDelete }: {
  table: DynamoTable;
  items: Item[];
  columns: string[];
  onError: (error: string) => void;
  onEdit: (item: Item) => void;
  onDuplicate: (item: Item) => void;
  onDelete: (items: Item[]) => void;
}) {
  const [filter, setFilter] = useState("");
  const [hidden, setHidden] = useState<string[]>([]);
  const [selected, setSelected] = useState<Item | null>(null);
  const [checked, setChecked] = useState<Item[]>([]);
  useEffect(() => {
    setChecked(current => current.filter(item => items.includes(item)));
  }, [items]);
  const shown = items.filter(item => !filter || fuzzyKeep([item], filter, row => [JSON.stringify(row)]).length > 0);
  const visible = columns.filter(column => !hidden.includes(column));
  return <>
    <div className="ddb-items-actions"><input value={filter} onChange={event => setFilter(event.target.value)} placeholder="아이템 찾기" />
      <details><summary>열 고르기</summary>{columns.map(column => <label key={column}><input type="checkbox" checked={!hidden.includes(column)} onChange={() => setHidden(current => current.includes(column) ? current.filter(name => name !== column) : [...current, column])} />{column} </label>)}</details>
      <ExportControls table={table.name} items={items} onError={onError} />
      <button className="btn small tone-danger" disabled={!checked.length || checked.length > 1000} onClick={() => { onDelete(checked); setChecked([]); }}>삭제 {checked.length}개</button>
      {checked.length > 1000 && <span className="err">최대 1,000개까지 삭제할 수 있어요.</span>}
    </div>
    {shown.length === 0 ? <p className="dim">{t.NO_ITEMS}</p> : <div className="ddb-items-table-wrap"><table className="ddb-table">
      <thead><tr><th>선택</th>{visible.map(column => <th key={column}>{column}</th>)}</tr></thead>
      <tbody>{shown.map((item, index) => <tr key={index} tabIndex={0} onClick={() => setSelected(item)} onKeyDown={event => { if (event.key === "Enter") setSelected(item); }}>
        <td onClick={event => event.stopPropagation()}><input type="checkbox" aria-label={`아이템 ${index + 1} 선택`} checked={checked.includes(item)} onChange={event => setChecked(current => event.target.checked ? [...current, item] : current.filter(row => row !== item))} /></td>
        {visible.map(column => <td key={column}>{item[column] && <><span className="iam-chip">{Object.keys(item[column])[0]}</span> {summary(item[column])}</>}</td>)}
      </tr>)}</tbody>
    </table></div>}
    {selected && <ItemDetail item={selected} table={table} onClose={() => setSelected(null)}
      onEdit={() => { onEdit(selected); setSelected(null); }}
      onDuplicate={() => { onDuplicate(selected); setSelected(null); }}
      onDelete={() => { onDelete([selected]); setSelected(null); }} />}
  </>;
}

export function Items({ profile, region, table }: DetailContext) {
  const key = tableStoreKey(profile, region, table.name);
  const store = useItems(key);
  const form = useQueryForm(table);
  const [page, setPage] = useState<ItemPage | null>(null);
  const [lastReq, setLastReq] = useState<ReadRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const flow = useDynamoChange({ profile, region, table: table.name });
  const [editor, setEditor] = useState<{ item: Item; creating: boolean; duplicate: boolean } | null>(null);
  const [consumed, setConsumed] = useState(0);
  useEffect(() => {
    if (store.prefill) {
      form.setKind("query"); form.setIndex(store.prefill.index ?? ""); form.setPk(store.prefill.pk ?? "");
      form.setSkOp(store.prefill.skPrefix ? "begins_with" : ""); form.setSkValue(store.prefill.skPrefix ?? "");
    }
  }, [store.serial]);
  const columns = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of store.items) for (const name of Object.keys(item)) counts.set(name, (counts.get(name) ?? 0) + 1);
    const first = [table.keys.pk.name, table.keys.sk?.name, form.selectedIndex?.pk.name, form.selectedIndex?.sk?.name].filter((name): name is string => !!name);
    return [...new Set([...first, ...[...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name)])];
  }, [store.items, table, form.selectedIndex]);
  async function run(request: ReadRequest, append = false) {
    setBusy(true); setError("");
    try {
      const result = await itemsApi.read(profile, region, table.name, request);
      setPage(result); setLastReq(request); setConsumed(total => append ? total + result.consumed : result.consumed);
      updateItems(key, { items: append ? [...store.items, ...result.items] : result.items,
        history: append ? store.history : [request, ...store.history].slice(0, 20),
        ...(!append ? { scanKey: null, scanStarted: false } : {}) });
    } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  function next() {
    if (!lastReq || !page) return;
    const request = lastReq.kind === "partiql" ? { ...lastReq, nextToken: page.nextToken } : { ...lastReq, startKey: page.lastKey };
    void run(request, true);
  }
  function create() {
    const attrs = [table.keys.pk, table.keys.sk].filter((attr): attr is NonNullable<typeof attr> => !!attr);
    const item = Object.fromEntries(attrs.map(attr => [attr.name, { [attr.type]: attr.type === "N" ? "0" : "" }]));
    setEditor({ item, creating: true, duplicate: false });
  }
  function begin(change: DynamoChange) {
    setEditor(null);
    void flow.begin(change);
  }
  return <div className="ddb-items">
    <QueryBuilder table={table} form={form} />
    <button className="btn tone-create" onClick={create}>새 아이템</button>
    {flow.error && <p className="err" role="alert">{flow.error}</p>}
    <PagingBar form={form} page={page} busy={busy} run={() => void run(form.build())} next={next} />
    {error && <p className="err" role="alert">{error}</p>}
    {store.history.length > 0 && <details><summary>최근 질의 ({store.history.length})</summary>{store.history.map((request, index) => <button key={index} className="btn small tone-secondary" onClick={() => void run(request)}>{request.kind} {index + 1}</button>)}</details>}
    {page && <><p>Count {page.count} · ScannedCount {page.scannedCount} · 소비 {page.consumed.toFixed(2)} RCU · 누적 {consumed.toFixed(2)} RCU</p>
      <details><summary>{t.REQUEST}</summary><pre>{JSON.stringify(page.request.params, null, 2)}</pre><pre>{page.request.cli}</pre><button className="btn small tone-secondary" onClick={() => void desktop.copy(page.request.cli)}>CLI 복사</button></details></>}
    <ResultsTable table={table} items={store.items} columns={columns} onError={setError}
      onEdit={item => setEditor({ item, creating: false, duplicate: false })}
      onDuplicate={item => setEditor({ item, creating: true, duplicate: true })}
      onDelete={items => begin({ kind: "deleteItems", items })} />
    {editor && <ItemEditor table={table} {...editor} save={begin} close={() => setEditor(null)} />}
    {flow.dialog}
  </div>;
}
