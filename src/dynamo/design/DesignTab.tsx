import { useMemo, useState } from "react";
import { errorMessage } from "../../api/errors";
import { Findings } from "../Findings";
import type { DetailContext } from "../TableDetail";
import type { DynamoTable } from "../types";
import { itemsApi } from "../items/api";
import { ItemDetail } from "../items/ItemDetail";
import { openQuery, tableStoreKey, updateItems, useItems } from "../items/store";
import type { Item } from "../items/types";
import { summary } from "../items/value";
import { analyze, type AccessPattern, type DesignEntity, type DesignReport } from "./design";
import * as t from "./text";

/** 예시 키: `PK · SK`의 값만 이어 붙인다 */
function exampleLabel(item: Item, table: DynamoTable): string {
  return [table.keys.pk.name, table.keys.sk?.name]
    .filter((name): name is string => !!name && !!item[name])
    .map(name => summary(item[name]))
    .join(" · ");
}

function AttributeTable({ entity }: { entity: DesignEntity }) {
  return <table className="ddb-table ddb-entity-attributes">
    <thead><tr><th>{t.COL_ATTRIBUTE}</th><th className="ddb-num">{t.COL_RATE}</th><th>{t.COL_TYPE}</th></tr></thead>
    <tbody>{entity.attributes.map(attribute => <tr key={attribute.name}>
      <td>{attribute.name}</td>
      <td className="ddb-num">{t.attributeRate(attribute.count, entity.count)}</td>
      <td>{attribute.types.map(type => <span key={type} className="iam-chip">{type}</span>)}</td>
    </tr>)}</tbody>
  </table>;
}

function Entities({ report, table, select }: { report: DesignReport; table: DynamoTable; select: (item: Item) => void }) {
  return <><h3>{t.ENTITIES}</h3>{report.entities.map(entity => <section key={entity.name} className="ddb-entity">
    <h4>{t.entityHeading(entity.name, entity.count, report.sampleCount)}</h4>
    <p className="ddb-shapes">
      <code>{table.keys.pk.name} {entity.pkShape || "—"}</code>
      {entity.skShape && table.keys.sk && <code>{table.keys.sk.name} {entity.skShape}</code>}
    </p>
    <AttributeTable entity={entity} />
    <div className="ddb-items-actions"><span className="dim">{t.EXAMPLES}</span>
      {entity.examples.map((item, index) => <button key={index} className="btn small tone-secondary" onClick={() => select(item)}>{exampleLabel(item, table)}</button>)}
    </div>
  </section>)}</>;
}

/** 눌렀을 때 아이템 탭에 채워 줄 예시 값을 마우스를 올리면 보여 준다 */
function sampleTitle(pattern: AccessPattern): string {
  const sort = pattern.skEquals ?? pattern.skPrefix;
  return `${t.PATTERN_TITLE} · ${[pattern.pk, sort].filter(Boolean).join(" · ")}`;
}

function PatternRow({ pattern, total, open }: { pattern: AccessPattern; total: number; open: () => void }) {
  return <tr>
    <td>{pattern.name}</td>
    <td><button className="btn small tone-nav ddb-pattern" title={sampleTitle(pattern)} onClick={open}>{pattern.shape}</button></td>
    <td>{pattern.entity}</td>
    <td className="ddb-num">{t.patternCount(pattern.entityCount, total)}</td>
    <td>
      {pattern.pk !== undefined && <span className="iam-chip">{pattern.single ? t.SINGLE_GET : t.MULTI_QUERY}</span>}
      {pattern.sparse && <span className="iam-chip">{t.SPARSE}</span>}
      {pattern.overloaded && <span className="iam-chip">{t.OVERLOADED}</span>}
    </td>
  </tr>;
}

function Patterns({ report, storeKey, openItems }: { report: DesignReport; storeKey: string; openItems: () => void }) {
  return <><h3>{t.PATTERNS}</h3>
    <table className="ddb-table">
      <thead><tr><th>{t.COL_TARGET}</th><th>{t.COL_PATTERN}</th><th>{t.COL_ENTITY}</th><th className="ddb-num">{t.COL_ITEMS}</th><th>{t.COL_NOTE}</th></tr></thead>
      <tbody>{report.patterns.map((pattern, index) => <PatternRow key={`${pattern.name}-${index}`} pattern={pattern} total={report.sampleCount} open={() => {
        openQuery(storeKey, { index: pattern.index, pk: pattern.pk, skPrefix: pattern.skPrefix, skEquals: pattern.skEquals });
        openItems();
      }} />)}</tbody>
    </table>
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
    <div className="ddb-items-actions">
      <span>{t.sampleCount(report.sampleCount)} · {t.DISCLAIMER}</span>
      <button className="btn small tone-refresh" disabled={busy || finished} title={finished ? t.SAMPLE_DONE : undefined} onClick={() => void sample()}>{t.SAMPLE}</button>
    </div>
    {error && <p className="err">{error}</p>}
    <Entities report={report} table={table} select={setSelected} />
    <Patterns report={report} storeKey={key} openItems={openItems} />
    <h3>{t.DIAGNOSTICS}</h3>
    <Findings findings={report.diagnostics} />
    {selected && <ItemDetail item={selected} table={table} onClose={() => setSelected(null)} />}
  </div>;
}
