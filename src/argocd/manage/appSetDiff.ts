import type { AppSetApp, GeneratedApp } from "./types";

export type AppChangeKind = "added" | "removed" | "changed" | "same";

export interface AppChange {
  /** namespace/name */
  key: string;
  name: string;
  namespace: string;
  kind: AppChangeKind;
  /** 지금 앱의 spec(없으면 null) */
  before: string | null;
  /** 미리 본 앱의 spec(없으면 null) */
  after: string | null;
  generated: GeneratedApp | null;
}

const ORDER: Record<AppChangeKind, number> = { added: 0, removed: 1, changed: 2, same: 3 };

/**
 * 미리 본(generate) 앱과 지금 만들어 둔 앱을 이름으로 맞춰 추가·삭제·변경·그대로로 가른다.
 * 둘 다 spec YAML이라 글이 같으면 그대로다. 추가·삭제·변경이 먼저 오고 이름 순이다.
 */
export function classifyGenerated(generated: GeneratedApp[], current: AppSetApp[]): AppChange[] {
  const keyOf = (a: { namespace: string; name: string }) => `${a.namespace}/${a.name}`;
  const live = new Map(current.map((a) => [keyOf(a), a]));
  const seen = new Set<string>();
  const changes: AppChange[] = [];
  for (const g of generated) {
    const key = keyOf(g);
    seen.add(key);
    const now = live.get(key);
    const kind: AppChangeKind = !now ? "added" : now.yaml === g.yaml ? "same" : "changed";
    changes.push({ key, name: g.name, namespace: g.namespace, kind, before: now?.yaml ?? null, after: g.yaml, generated: g });
  }
  for (const a of current) {
    const key = keyOf(a);
    if (!seen.has(key)) changes.push({ key, name: a.name, namespace: a.namespace, kind: "removed", before: a.yaml, after: null, generated: null });
  }
  return changes.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.key.localeCompare(b.key));
}

export const countChanges = (changes: AppChange[]): Record<AppChangeKind, number> =>
  changes.reduce<Record<AppChangeKind, number>>((n, c) => ({ ...n, [c.kind]: n[c.kind] + 1 }), { added: 0, removed: 0, changed: 0, same: 0 });
