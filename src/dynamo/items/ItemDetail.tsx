import { useState } from "react";
import { desktop } from "../../api/desktop";
import type { DynamoTable } from "../types";
import type { Attribute, Item } from "./types";
import { itemSize, orderedNames, plainItem, summary } from "./value";
import * as t from "./text";

type Mode = "tree" | "ddb" | "plain";

const MODES: { mode: Mode; label: string }[] = [
  { mode: "tree", label: "트리" },
  { mode: "ddb", label: "DynamoDB JSON" },
  { mode: "plain", label: "일반 JSON" },
];

function CopyButton({ value }: { value: Attribute }) {
  return <button className="btn small tone-secondary" onClick={event => { event.preventDefault(); void desktop.copy(JSON.stringify(value)); }}>{t.COPY}</button>;
}

function AttributeRow({ name, value }: { name: string; value: Attribute }) {
  const tag = Object.keys(value)[0];
  return <>
    <span className="ddb-attr-name">{name}</span>
    <span className="iam-chip">{tag}</span>
    <span className="ddb-attr-value">{summary(value)}</span>
    <CopyButton value={value} />
  </>;
}

function Tree({ name, value }: { name: string; value: Attribute }) {
  const [tag, content] = Object.entries(value)[0] ?? [];
  const children: [string, Attribute][] = tag === "M" ? Object.entries(content as Item) :
    tag === "L" ? (content as Attribute[]).map((item, index) => [String(index), item]) : [];
  if (children.length) {
    return <details className="ddb-attr-group">
      <summary className="ddb-attr-row"><AttributeRow name={name} value={value} /></summary>
      <div className="ddb-items-tree">{children.map(([key, child]) => <Tree key={key} name={key} value={child} />)}</div>
    </details>;
  }
  return <div className="ddb-attr-row"><AttributeRow name={name} value={value} /></div>;
}

function ModeToggle({ mode, onMode }: { mode: Mode; onMode: (mode: Mode) => void }) {
  return <div className="ddb-items-actions" role="group" aria-label="보기 방식">
    {MODES.map(option => <button key={option.mode} className="btn small tone-secondary" aria-pressed={mode === option.mode} onClick={() => onMode(option.mode)}>{option.label}</button>)}
  </div>;
}

export function ItemDetail({ item, table, onClose, onEdit, onDuplicate, onDelete }: {
  item: Item;
  table: DynamoTable;
  onClose: () => void;
  onEdit?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
}) {
  const [mode, setMode] = useState<Mode>("tree");
  const size = itemSize(item);
  const ttl = table.ttl?.attribute;
  const seconds = ttl && item[ttl]?.N ? Number(item[ttl].N) : null;
  const keyNames = [table.keys.pk.name, table.keys.sk?.name].filter((name): name is string => !!name);
  const keys = Object.fromEntries(keyNames.filter(name => !!item[name]).map(name => [name, item[name]]));
  const ordered: Item = Object.fromEntries(orderedNames(item, keyNames).map(name => [name, item[name]]));
  const copied = JSON.stringify(mode === "plain" ? plainItem(ordered) : ordered, null, 2);
  return <div className="ddb-items-overlay" role="dialog" aria-modal="true" aria-label="아이템 상세">
    <div className="ddb-items-dialog">
      <header><h3>아이템 상세</h3><button className="btn small tone-ghost" onClick={onClose}>{t.CLOSE}</button></header>
      <p>추정 크기 {size.toLocaleString()} B / 400 KB ({(size / 409600 * 100).toFixed(1)}%)</p>
      {seconds !== null && Number.isFinite(seconds) && <p>TTL: {new Date(seconds * 1000).toLocaleString()} {seconds * 1000 < Date.now() ? "(만료됐지만 아직 지워지지 않았어요)" : `(약 ${Math.ceil((seconds * 1000 - Date.now()) / 3600000)}시간 남음)`}</p>}
      {(onEdit || onDuplicate || onDelete) && <div className="ddb-items-actions" role="group" aria-label="아이템 작업">
        {onEdit && <button className="btn small tone-secondary" onClick={onEdit}>편집</button>}
        {onDuplicate && <button className="btn small tone-create" onClick={onDuplicate}>복제</button>}
        {onDelete && <button className="btn small tone-danger" onClick={onDelete}>삭제</button>}
      </div>}
      <div className="ddb-detail-toolbar">
        <ModeToggle mode={mode} onMode={setMode} />
        <div className="ddb-items-actions" role="group" aria-label="복사">
          <button className="btn small tone-secondary" onClick={() => void desktop.copy(JSON.stringify(keys, null, 2))}>키 복사</button>
          <button className="btn small tone-secondary" onClick={() => void desktop.copy(copied)}>아이템 복사</button>
        </div>
      </div>
      {mode === "tree" ? <div className="ddb-attr-list">{Object.entries(ordered).map(([name, value]) => <Tree key={name} name={name} value={value} />)}</div> : <pre>{copied}</pre>}
    </div>
  </div>;
}
