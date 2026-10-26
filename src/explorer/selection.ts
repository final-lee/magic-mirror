import type { S3Entry } from "../api/types";
import type { FileRef, LocalEntry, S3Location } from "./types";

export interface SelectionState {
  selected: string[];
  anchor: string | null;
}

export function nextSelection(
  state: SelectionState,
  clicked: string,
  order: string[],
  mods: { meta: boolean; shift: boolean },
): SelectionState {
  if (mods.shift && state.anchor && order.includes(state.anchor)) {
    const a = order.indexOf(state.anchor);
    const b = order.indexOf(clicked);
    const [from, to] = a <= b ? [a, b] : [b, a];
    return { selected: order.slice(from, to + 1), anchor: state.anchor };
  }
  if (mods.meta) {
    const has = state.selected.includes(clicked);
    return { selected: has ? state.selected.filter((x) => x !== clicked) : [...state.selected, clicked], anchor: clicked };
  }
  return { selected: [clicked], anchor: clicked };
}

interface CompareInput {
  local: LocalEntry[];
  s3: S3Entry[];
  s3Location: S3Location | null;
  focused: "local" | "s3";
}

export function compareTargets({ local, s3, s3Location, focused }: CompareInput): [FileRef, FileRef] | null {
  const toLocal = (e: LocalEntry): FileRef => ({ source: "local", path: e.path });
  const toS3 = (e: S3Entry): FileRef | null =>
    s3Location ? { source: "s3", bucket: s3Location.bucket, region: s3Location.region, key: e.key } : null;
  const filesOnly = local.every((e) => !e.isDir) && s3.every((e) => !e.isFolder);
  if (!filesOnly) return null;
  if (local.length === 1 && s3.length === 1) {
    const right = toS3(s3[0]);
    return right ? [toLocal(local[0]), right] : null;
  }
  if (focused === "local" && local.length === 2) return [toLocal(local[0]), toLocal(local[1])];
  if (focused === "s3" && s3.length === 2) {
    const a = toS3(s3[0]);
    const b = toS3(s3[1]);
    return a && b ? [a, b] : null;
  }
  return null;
}
