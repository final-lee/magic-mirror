import type { DynamoTable, KeyAttr } from "../types";
import type { Item } from "../items/types";
import { itemSize } from "../items/value";

export interface DesignEntity {
  name: string;
  count: number;
  pkShape: string;
  skShape: string;
  attributes: { name: string; count: number; types: string[] }[];
  examples: Item[];
}

export interface AccessPattern {
  name: string;
  index?: string;
  count: number;
  sparse: boolean;
  overloaded: boolean;
  entities: string[];
  pk?: string;
  skPrefix?: string;
  description: string;
}

export interface Diagnostic {
  id: "ttlMillis" | "ttlMissing" | "ttlNotNumber" | "ttlExpiredPresent" | "largeItem" | "hotKey" | "mixedType" | "versionAttr";
  level: "info" | "warn" | "fail";
  detail: string;
  count: number;
}

export interface DesignReport {
  sampleCount: number;
  entities: DesignEntity[];
  patterns: AccessPattern[];
  diagnostics: Diagnostic[];
}

interface EntityGroup {
  items: Item[];
  pkShape: string;
  skShape: string;
}

type EntityGroups = Map<string, EntityGroup>;

function keyValue(item: Item, name?: string): string {
  if (!name) return "";
  const value = item[name];
  if (value?.S !== undefined) return String(value.S);
  if (value?.N !== undefined) return String(value.N);
  return "";
}

function prefix(value: string): string {
  return /^([A-Z_]+)[#|:/]/.exec(value)?.[1] ?? "";
}

function keyShape(value: string): string {
  if (!value) return "";
  return value.split(/([#|:/])/).map((part, index) => {
    if (index === 0 && prefix(value)) return part;
    if (/^[#|:/]$/.test(part)) return part;
    if (/^\d{4}-\d\d-\d\d/.test(part)) return "<date>";
    if (/^\d+$/.test(part)) return "<number>";
    if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(part)) return "<uuid>";
    if (/^[0-9A-HJKMNP-TV-Z]{26}$/.test(part)) return "<ulid>";
    return "<id>";
  }).join("");
}

function inferEntities(table: DynamoTable, items: Item[]): EntityGroups {
  const groups: EntityGroups = new Map();
  for (const item of items) {
    const pk = keyValue(item, table.keys.pk.name);
    const sk = keyValue(item, table.keys.sk?.name);
    const label = ["type", "entityType", "_type", "__typename", "_et"]
      .map(name => keyValue(item, name)).find(Boolean);
    const pair = [prefix(pk), prefix(sk)].filter(Boolean).join(" / ");
    const name = label || pair || "엔티티 1종(접두사 없음)";
    const group = groups.get(name) ?? {
      items: [], pkShape: keyShape(pk), skShape: keyShape(sk),
    };
    group.items.push(item);
    groups.set(name, group);
  }
  return groups;
}

function entityAttributes(items: Item[]): DesignEntity["attributes"] {
  const attributes = new Map<string, { count: number; types: Set<string> }>();
  for (const item of items) {
    for (const [name, value] of Object.entries(item)) {
      const attribute = attributes.get(name) ?? { count: 0, types: new Set<string>() };
      attribute.count++;
      attribute.types.add(Object.keys(value)[0]);
      attributes.set(name, attribute);
    }
  }
  return [...attributes].map(([name, attribute]) => ({
    name, count: attribute.count, types: [...attribute.types],
  }));
}

function summarizeEntities(groups: EntityGroups): DesignEntity[] {
  return [...groups].map(([name, group]) => ({
    name,
    count: group.items.length,
    pkShape: group.pkShape,
    skShape: group.skShape,
    attributes: entityAttributes(group.items),
    examples: group.items.slice(0, 3),
  }));
}

function accessPatterns(table: DynamoTable, items: Item[], groups: EntityGroups): AccessPattern[] {
  const indexes: { name: string; pk: KeyAttr; sk?: KeyAttr | null; index?: string }[] = [
    { name: table.name, ...table.keys },
    ...table.indexes.map(index => ({ ...index, index: index.name })),
  ];
  return indexes.flatMap(index => {
    const present = new Set(items.filter(item => item[index.pk.name] && (!index.sk || item[index.sk.name])));
    const matching = [...groups].filter(([, group]) => group.items.some(item => present.has(item)));
    const names = matching.map(([name]) => name);
    const common = {
      name: index.name, index: index.index, count: present.size,
      sparse: present.size < items.length, overloaded: names.length > 1, entities: names,
    };
    if (!matching.length) {
      return [{ ...common, description: `${index.name}: ${index.pk.name}${index.sk ? `로 ${index.sk.name} 범위 조회` : " 조회"}` }];
    }
    return matching.map(([entity, group]) => {
      const example = group.items.find(item => present.has(item))!;
      const pk = keyValue(example, index.pk.name);
      const sk = keyValue(example, index.sk?.name);
      const skPart = prefix(sk);
      const skPrefix = skPart ? skPart + sk[skPart.length] : undefined;
      return {
        ...common, pk, skPrefix,
        description: `${index.name}: ${index.pk.name}=${pk}${skPrefix ? `, ${index.sk?.name} begins_with ${skPrefix}` : index.sk ? `, ${index.sk.name} 범위` : ""} (${entity})`,
      };
    });
  });
}

function diagnose(table: DynamoTable, items: Item[], entities: DesignEntity[], now: number): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const add = (id: Diagnostic["id"], level: Diagnostic["level"], count: number, detail: string) => {
    if (count) diagnostics.push({ id, level, count, detail });
  };
  const ttl = table.ttl?.status === "ENABLED" ? table.ttl.attribute : null;
  if (ttl) {
    const numeric = items.filter(item => item[ttl]?.N !== undefined);
    add("ttlMillis", "warn", numeric.filter(item => Number(item[ttl].N) > 1e11).length, "TTL은 초 단위 Unix 시간이어야 지워져요.");
    add("ttlMissing", "info", items.filter(item => !item[ttl]).length, "TTL 속성이 없는 아이템이에요.");
    add("ttlNotNumber", "warn", items.filter(item => item[ttl] && !("N" in item[ttl])).length, "숫자가 아닌 TTL은 지워지지 않아요.");
    add("ttlExpiredPresent", "info", numeric.filter(item => Number(item[ttl].N) < now / 1000).length, "만료됐지만 아직 남아 있어요. 삭제에는 보통 며칠 걸려요.");
  }
  const sizes = items.map(itemSize);
  const large = sizes.filter(size => size >= 100 * 1024).length;
  const critical = sizes.some(size => size >= 350 * 1024);
  add("largeItem", critical ? "fail" : "warn", large, "추정 크기가 100 KB 이상이에요 (한도 400 KB).");
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = JSON.stringify(item[table.keys.pk.name]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  add("hotKey", "info", [...counts.values()].filter(count => count / items.length >= 0.2).length, "샘플의 20% 이상이 같은 파티션 키예요. Scan 샘플은 분포를 대략 따릅니다.");
  for (const entity of entities) {
    for (const attribute of entity.attributes) {
      if (attribute.types.length > 1) add("mixedType", "warn", attribute.count, `${entity.name}: ${attribute.name}의 타입이 ${attribute.types.join(", ")}로 섞여 있어요.`);
      if (["version", "revision", "_version", "ver"].includes(attribute.name) && attribute.types.includes("N")) add("versionAttr", "info", attribute.count, `${entity.name}: ${attribute.name}은 버전 속성으로 보입니다.`);
    }
  }
  return diagnostics;
}

export function analyze(table: DynamoTable, items: Item[], now = Date.now()): DesignReport {
  const groups = inferEntities(table, items);
  const entities = summarizeEntities(groups);
  return {
    sampleCount: items.length,
    entities,
    patterns: accessPatterns(table, items, groups),
    diagnostics: diagnose(table, items, entities, now),
  };
}
