import { useState } from "react";
import { CodeEditor } from "../../components/CodeEditor";
import type { DynamoChange } from "../change/types";
import type { DynamoTable } from "../types";
import { itemPlainEditable, parseItem } from "./editor";
import type { Item } from "./types";
import { plainItem } from "./value";

export function ItemEditor({ table, item, creating, duplicate, save, close }: {
  table: DynamoTable;
  item: Item;
  creating: boolean;
  duplicate: boolean;
  save: (change: DynamoChange) => void;
  close: () => void;
}) {
  const [text, setText] = useState(JSON.stringify(item, null, 2));
  const [plain, setPlain] = useState(false);
  const [error, setError] = useState("");
  const names = [table.keys.pk.name, table.keys.sk?.name].filter((name): name is string => !!name);
  function toggle() {
    try {
      const current = parseItem(text, plain);
      if (!plain && !itemPlainEditable(current)) throw new Error("집합, 바이너리 또는 안전하게 표현할 수 없는 숫자가 있어 일반 JSON으로 편집할 수 없어요.");
      setText(JSON.stringify(plain ? current : plainItem(current), null, 2));
      setPlain(!plain);
      setError("");
    } catch (failure) { setError(String(failure)); }
  }
  function submit() {
    try {
      const updated = parseItem(text, plain);
      if (creating) {
        save({ kind: "putItem", item: updated, condition: null });
      } else {
        const key = Object.fromEntries(names.map(name => [name, item[name]]));
        const moved = names.some(name => JSON.stringify(item[name]) !== JSON.stringify(updated[name]));
        save(moved ? { kind: "moveItem", original: item, updated } : { kind: "updateItem", key, original: item, updated });
      }
      setError("");
    } catch (failure) { setError(String(failure)); }
  }
  let canSwitch = plain;
  try { canSwitch ||= itemPlainEditable(parseItem(text, false)); } catch { /* 입력이 유효해지면 전환할 수 있어요. */ }
  return <div className="ddb-items-overlay" role="dialog" aria-modal="true" aria-label={creating ? "새 아이템" : "아이템 편집"}>
    <div className="ddb-items-dialog">
      <header><h3>{creating ? "새 아이템" : "아이템 편집"}</h3></header>
      {duplicate && <p>기존 아이템과 다른 키를 입력해 주세요.</p>}
      <div className="ddb-items-actions" role="group" aria-label="편집 형식">
        <button className="btn small tone-secondary" aria-pressed={!plain} onClick={plain ? toggle : undefined}>DynamoDB JSON</button>
        <button className="btn small tone-secondary" aria-pressed={plain} disabled={!canSwitch} onClick={plain ? undefined : toggle}>일반 JSON</button>
      </div>
      <CodeEditor key={plain ? "plain" : "dynamo"} value={text} onChange={setText} label="아이템 JSON" language="json" minHeight="320px" />
      {error && <p className="err" role="alert">{error}</p>}
      <div className="foot">
        <button className="btn plain tone-ghost-danger" onClick={close}>편집 버리기</button>
        <button className="btn plain tone-primary" onClick={submit}>저장</button>
      </div>
    </div>
  </div>;
}
