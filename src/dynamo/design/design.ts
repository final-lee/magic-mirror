import type { DynamoTable, KeyAttr } from "../types";
import type { Item } from "../items/types";
import { itemSize } from "../items/value";
import * as t from "./text";

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
  /** 이 줄이 가리키는 엔티티와 그 엔티티의 아이템 수 */
  entity?: string;
  entityCount: number;
  pk?: string;
  skPrefix?: string;
  /** 정렬 키가 늘 같은 값이면 그 값. 키가 하나뿐인 읽기(GetItem)와 같다 */
  skEquals?: string;
  /** 키 모양으로 쓴 조건: `PK = USER#<id>, SK begins_with ORDER#` */
  shape: string;
  /** 기본 테이블에서 키 전체가 정해지는 읽기. 아이템 하나를 읽는다 */
  single: boolean;
}

export interface Diagnostic {
  id: "ttlMillis" | "ttlMissing" | "ttlNotNumber" | "ttlExpiredPresent" | "largeItem" | "hotKey" | "mixedType" | "versionAttr";
  level: "info" | "warn" | "fail";
  summary: string;
  detail: string | null;
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
  pks: string[];
  sks: string[];
}

type EntityGroups = Map<string, EntityGroup>;

const SEPARATOR = /([#|:/])/;
const IS_SEPARATOR = /^[#|:/]$/;

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

/**
 * 키 값 하나의 모양. `#`·`|`·`:`·`/`으로 나눈 조각마다 날짜·숫자·UUID·ULID는 이름표(`<date>` 등)로,
 * 대문자 상수(`USER`, `PROFILE`, `META`)는 그대로 두고, 나머지는 `<id>`로 바꾼다.
 */
export function keyShape(value: string): string {
  if (!value) return "";
  return value.split(SEPARATOR).map((part, index) => {
    if (index === 0 && prefix(value)) return part;
    if (IS_SEPARATOR.test(part)) return part;
    if (/^\d{4}-\d\d-\d\d/.test(part)) return "<date>";
    if (/^\d+$/.test(part)) return "<number>";
    if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(part)) return "<uuid>";
    if (/^[0-9A-HJKMNP-TV-Z]{26}$/.test(part)) return "<ulid>";
    if (/^[A-Z][A-Z_]+$/.test(part)) return part;
    return "<id>";
  }).join("");
}

/**
 * 같은 엔티티의 키 값들이 하나의 모양으로 모이는지 본다. 모든 값에서 같은 조각은 그대로 두고 값마다 다른 조각만 `<id>`로 바꾼다.
 * 조각 수가 서로 다르면 가장 많은 모양을 따른다.
 */
export function sharedKeyShape(values: string[]): string {
  const shapes = values.map(keyShape).filter(Boolean);
  if (shapes.length === 0) return "";
  const counts = new Map<string, number>();
  for (const shape of shapes) counts.set(shape, (counts.get(shape) ?? 0) + 1);
  const common = [...counts].sort((a, b) => b[1] - a[1])[0][0];
  const parts = common.split(SEPARATOR);
  const sameLength = shapes.filter(shape => shape.split(SEPARATOR).length === parts.length);
  return parts.map((part, index) =>
    sameLength.every(shape => shape.split(SEPARATOR)[index] === part) ? part : "<id>").join("");
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
    const group = groups.get(name) ?? { items: [], pks: [], sks: [] };
    group.items.push(item);
    group.pks.push(pk);
    group.sks.push(sk);
    groups.set(name, group);
  }
  return groups;
}

function entityAttributes(items: Item[], keyNames: string[]): DesignEntity["attributes"] {
  const attributes = new Map<string, { count: number; types: Set<string> }>();
  for (const item of items) {
    for (const [name, value] of Object.entries(item)) {
      const attribute = attributes.get(name) ?? { count: 0, types: new Set<string>() };
      attribute.count++;
      attribute.types.add(Object.keys(value)[0]);
      attributes.set(name, attribute);
    }
  }
  const rank = (name: string) => keyNames.includes(name) ? keyNames.indexOf(name) : keyNames.length;
  return [...attributes]
    .map(([name, attribute]) => ({ name, count: attribute.count, types: [...attribute.types] }))
    .sort((a, b) => rank(a.name) - rank(b.name) || b.count - a.count || a.name.localeCompare(b.name));
}

function summarizeEntities(table: DynamoTable, groups: EntityGroups): DesignEntity[] {
  const keyNames = [table.keys.pk.name, table.keys.sk?.name].filter((name): name is string => !!name);
  return [...groups].map(([name, group]) => ({
    name,
    count: group.items.length,
    pkShape: sharedKeyShape(group.pks),
    skShape: sharedKeyShape(group.sks),
    attributes: entityAttributes(group.items, keyNames),
    examples: group.items.slice(0, 3),
  }));
}

/** 정렬 키 모양에서 앞의 상수 접두사(`ORDER#`). 없으면 빈 문자열 */
function skPrefixOf(skShape: string): string {
  return /^[A-Z_]+[#|:/]/.exec(skShape)?.[0] ?? "";
}

type IndexKeys = { name: string; pk: KeyAttr; sk?: KeyAttr | null; index?: string };

function patternFor(index: IndexKeys, present: Item[]): Pick<AccessPattern, "pk" | "skPrefix" | "skEquals" | "shape" | "single"> {
  const pks = present.map(item => keyValue(item, index.pk.name));
  const sks = present.map(item => keyValue(item, index.sk?.name));
  const pkShape = sharedKeyShape(pks);
  const skShape = sharedKeyShape(sks);
  const base = { pk: pks[0], shape: "", single: false };
  const pkCondition = `${index.pk.name} = ${pkShape}`;
  if (!index.sk) return { ...base, shape: pkCondition, single: !index.index };
  if (skShape !== "" && !skShape.includes("<")) {
    return { ...base, skEquals: sks[0], shape: `${pkCondition}, ${index.sk.name} = ${skShape}`, single: !index.index };
  }
  const skPrefix = skPrefixOf(skShape);
  if (skPrefix) return { ...base, skPrefix, shape: `${pkCondition}, ${index.sk.name} begins_with ${skPrefix}` };
  return { ...base, shape: `${pkCondition}, ${t.SK_RANGE(index.sk.name)}` };
}

function accessPatterns(table: DynamoTable, items: Item[], groups: EntityGroups): AccessPattern[] {
  const indexes: IndexKeys[] = [
    { name: table.name, ...table.keys },
    ...table.indexes.map(index => ({ ...index, index: index.name })),
  ];
  return indexes.flatMap((index): AccessPattern[] => {
    const present = new Set(items.filter(item => item[index.pk.name] && (!index.sk || item[index.sk.name])));
    const matching = [...groups].filter(([, group]) => group.items.some(item => present.has(item)));
    const names = matching.map(([name]) => name);
    const common = {
      name: index.name, index: index.index, count: present.size,
      sparse: present.size < items.length, overloaded: names.length > 1, entities: names,
    };
    if (!matching.length) {
      const sk = index.sk ? `, ${t.SK_RANGE(index.sk.name)}` : "";
      return [{ ...common, entityCount: 0, shape: `${index.pk.name} = ${t.ANY_VALUE}${sk}`, single: false }];
    }
    return matching.map(([entity, group]) => {
      const own = group.items.filter(item => present.has(item));
      return { ...common, entity, entityCount: own.length, ...patternFor(index, own) };
    });
  });
}

function diagnose(table: DynamoTable, items: Item[], entities: DesignEntity[], now: number): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const total = items.length;
  const add = (id: Diagnostic["id"], level: Diagnostic["level"], count: number, message: { summary: string; detail: string | null }) => {
    if (count) diagnostics.push({ id, level, count, ...message });
  };
  const ttl = table.ttl?.status === "ENABLED" ? table.ttl.attribute : null;
  if (ttl) {
    const numeric = items.filter(item => item[ttl]?.N !== undefined);
    const millis = numeric.filter(item => Number(item[ttl].N) > 1e11).length;
    const missing = items.filter(item => !item[ttl]).length;
    const notNumber = items.filter(item => item[ttl] && !("N" in item[ttl])).length;
    const expired = numeric.filter(item => Number(item[ttl].N) < now / 1000).length;
    add("ttlMillis", "warn", millis, t.TTL_MILLIS(total, millis));
    add("ttlMissing", "info", missing, t.TTL_MISSING(total, missing));
    add("ttlNotNumber", "warn", notNumber, t.TTL_NOT_NUMBER(total, notNumber));
    add("ttlExpiredPresent", "info", expired, t.TTL_EXPIRED(total, expired));
  }
  const sizes = items.map(itemSize);
  const large = sizes.filter(size => size >= 100 * 1024).length;
  const critical = sizes.some(size => size >= 350 * 1024);
  add("largeItem", critical ? "fail" : "warn", large, t.LARGE_ITEM(total, large));
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = JSON.stringify(item[table.keys.pk.name]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const hot = [...counts.values()].filter(count => count / items.length >= 0.2).length;
  add("hotKey", "info", hot, t.HOT_KEY(total, hot));
  for (const entity of entities) {
    for (const attribute of entity.attributes) {
      if (attribute.types.length > 1) add("mixedType", "warn", attribute.count, t.MIXED_TYPE(entity.name, attribute.name, attribute.types, entity.count, attribute.count));
      if (["version", "revision", "_version", "ver"].includes(attribute.name) && attribute.types.includes("N")) add("versionAttr", "info", attribute.count, t.VERSION_ATTR(entity.name, attribute.name, entity.count, attribute.count));
    }
  }
  return diagnostics;
}

export function analyze(table: DynamoTable, items: Item[], now = Date.now()): DesignReport {
  const groups = inferEntities(table, items);
  const entities = summarizeEntities(table, groups);
  return {
    sampleCount: items.length,
    entities,
    patterns: accessPatterns(table, items, groups),
    diagnostics: diagnose(table, items, entities, now),
  };
}
