export type Attribute = Record<string, unknown>;
export type Item = Record<string, Attribute>;
export interface Condition { attribute: string; op: string; values: Attribute[] }
export type ReadRequest =
 | { kind: "query"; index: string | null; pk: Attribute; sk: { op: string; values: Attribute[] } | null; filters: Condition[]; projection: string[]; forward: boolean; consistent: boolean; limit: number | null; startKey: Item | null }
 | { kind: "scan"; index: string | null; filters: Condition[]; projection: string[]; consistent: boolean; limit: number | null; startKey: Item | null }
 | { kind: "partiql"; statement: string; consistent: boolean; nextToken: string | null };
export interface ItemPage { items: Item[]; lastKey: Item | null; nextToken: string | null; count: number; scannedCount: number; consumed: number; request: { api: string; params: unknown; cli: string } }
export interface QueryPrefill { index?: string; pk?: string; skPrefix?: string }
