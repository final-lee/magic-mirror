import { useMemo, useState } from "react";
import { errorMessage } from "../../api/errors";
import type { DetailContext } from "../TableDetail";
import type { DynamoTable } from "../types";
import { itemsApi } from "../items/api";
import { ItemDetail } from "../items/ItemDetail";
import { openQuery, tableStoreKey, updateItems, useItems } from "../items/store";
import type { Item } from "../items/types";
import { analyze, type DesignReport } from "./design";
import * as t from "./text";

function Entities({ report, table, select }: { report: DesignReport; table: DynamoTable; select: (item: Item) => void }) {
  return <><h3>{t.ENTITIES}</h3>{report.entities.map(entity => <section key={entity.name}>
    <h4>{entity.name} · {entity.count}개 ({(entity.count / report.sampleCount * 100).toFixed(1)}%)</h4>
    <p>PK {entity.pkShape || "—"} {entity.skShape && `· SK ${entity.skShape}`}</p>
    <p>{entity.attributes.map(attribute => `${attribute.name} ${Math.round(attribute.count / entity.count * 100)}% (${attribute.types.join("/")})`).join(" · ")}</p>
    <div>{entity.examples.map((item, index) => <button key={index} className="btn small tone-secondary" onClick={() => select(item)}>예시 키 {index + 1}: {JSON.stringify(item[table.keys.pk.name])}</button>)}</div>
  </section>)}</>;
}

function Patterns({ report, storeKey, openItems }: { report: DesignReport; storeKey: string; openItems: () => void }) {
  return <><h3>{t.PATTERNS}</h3>{report.patterns.map((pattern, index) => <div key={`${pattern.name}-${index}`}>
    <button className="btn small tone-nav" onClick={() => {
      openQuery(storeKey, { index: pattern.index, pk: pattern.pk, skPrefix: pattern.skPrefix });
      openItems();
    }}>{pattern.description}</button> {pattern.count}/{report.sampleCount} {pattern.sparse && "· 희소"} {pattern.overloaded && "· 여러 엔티티"} {pattern.entities.join(", ")}
  </div>)}</>;
}

function Diagnostics({ report }: { report: DesignReport }) {
  return <><h3>{t.DIAGNOSTICS}</h3>{report.diagnostics.length === 0 ? <p className="dim">진단할 항목이 없어요.</p> :
    <ul>{report.diagnostics.map((diagnostic, index) => <li key={index}><strong>{diagnostic.level} · {diagnostic.id}</strong> {diagnostic.detail} ({diagnostic.count})</li>)}</ul>}
  </>;
}

export function Design({ profile, region, table, openItems }: DetailContext) {
  const key = tableStoreKey(profile, region, table.name);
  const store = useItems(key);
  const report = useMemo(() => analyze(table, store.items), [table, store.items]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Item | null>(null);
  async function sample() {
    setBusy(true);
    setError("");
    try {
      const page = await itemsApi.read(profile, region, table.name, {
        kind: "scan", index: null, isGsi: false, filters: [], projection: [], consistent: false,
        limit: null, startKey: store.scanStarted ? store.scanKey : null,
      });
      const keys = [table.keys.pk.name, table.keys.sk?.name].filter((name): name is string => !!name);
      const merged = new Map([...store.items, ...page.items].map(item => [JSON.stringify(keys.map(name => item[name])), item]));
      updateItems(key, { items: [...merged.values()], scanKey: page.lastKey, scanStarted: true });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  const finished = store.scanStarted && !store.scanKey;
  return <div className="ddb-design">
    <p>{report.sampleCount.toLocaleString()}개 아이템 · {t.DISCLAIMER}</p>
    <button className="btn small tone-refresh" disabled={busy || finished} title={finished ? "마지막 페이지까지 읽었어요" : undefined} onClick={() => void sample()}>{t.SAMPLE}</button>
    {error && <p className="err">{error}</p>}
    <Entities report={report} table={table} select={setSelected} />
    <Patterns report={report} storeKey={key} openItems={openItems} />
    <Diagnostics report={report} />
    {selected && <ItemDetail item={selected} table={table} onClose={() => setSelected(null)} />}
  </div>;
}
