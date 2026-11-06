import type { DynamoChange, ItemResult, Target } from "../change/types";
import type { Item } from "./types";
import { tableStoreKey, updateItems, currentItems } from "./store";

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function applyItemResults(target: Target, change: DynamoChange, results: ItemResult[]) {
  const key = tableStoreKey(target.profile, target.region, target.table);
  let items = currentItems(key);
  const successful = results.filter(result => result.ok);
  const remove = (old: Item) => { items = items.filter(item => stable(item) !== stable(old)); };
  if (change.kind === "deleteItems") {
    successful.forEach(result => remove(result.item));
  } else if (change.kind === "updateItem" || change.kind === "moveItem") {
    if (successful.length) {
      remove(change.original);
      items = [...items, change.updated];
    }
  } else if (change.kind === "putItem") {
    if (successful.length) items = [...items, change.item];
  } else if (change.kind === "restoreItems") {
    items = [...items, ...successful.map(result => result.item)];
  }
  updateItems(key, { items });
}
