import type { DynamoTable, KeyAttr } from "../types";
import type { Item } from "../items/types";
import { itemSize } from "../items/value";

export interface DesignEntity { name: string; count: number; pkShape: string; skShape: string; attributes: { name: string; count: number; types: string[] }[]; examples: Item[] }
export interface AccessPattern { name: string; index?: string; count: number; sparse: boolean; overloaded: boolean; entities: string[]; pk?: string; skPrefix?: string; description: string }
export interface Diagnostic { id: "ttlMillis" | "ttlMissing" | "ttlNotNumber" | "ttlExpiredPresent" | "largeItem" | "hotKey" | "mixedType" | "versionAttr"; level: "info" | "warn" | "fail"; detail: string; count: number }
export interface DesignReport { sampleCount: number; entities: DesignEntity[]; patterns: AccessPattern[]; diagnostics: Diagnostic[] }
const str = (item: Item, name?: string) => name && item[name]?.S !== undefined ? String(item[name].S) : name && item[name]?.N !== undefined ? String(item[name].N) : "";
function prefix(value: string): string { const match = /^([A-Z_]+)[#|:/]/.exec(value); return match?.[1] ?? ""; }
function shape(value: string): string { if (!value) return ""; const parts=value.split(/([#|:/])/); return parts.map((p,i)=>i===0 && prefix(value) ? p : /^[#|:/]$/.test(p) ? p : /^\d{4}-\d\d-\d\d/.test(p) ? "<date>" : /^\d+$/.test(p) ? "<number>" : /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(p) ? "<uuid>" : /^[0-9A-HJKMNP-TV-Z]{26}$/.test(p) ? "<ulid>" : "<id>").join(""); }
export function analyze(table: DynamoTable, items: Item[], now = Date.now()): DesignReport {
 const groups = new Map<string, { items: Item[]; pk: string; sk: string }>();
 for (const item of items) {
  const pk=str(item,table.keys.pk.name), sk=str(item,table.keys.sk?.name);
  const label=["type","entityType","_type","__typename","_et"].map(k=>str(item,k)).find(Boolean);
  const pair=[prefix(pk),prefix(sk)].filter(Boolean).join(" / "); const name=label || pair || "엔티티 1종(접두사 없음)";
  const group=groups.get(name) ?? {items:[],pk:shape(pk),sk:shape(sk)}; group.items.push(item); groups.set(name,group);
 }
 const entities: DesignEntity[]=[...groups].map(([name,g])=>{ const attrs=new Map<string,{count:number;types:Set<string>}>(); for(const item of g.items) for(const [key,value] of Object.entries(item)){ const a=attrs.get(key) ?? {count:0,types:new Set<string>()}; a.count++; a.types.add(Object.keys(value)[0]); attrs.set(key,a); } return {name,count:g.items.length,pkShape:g.pk,skShape:g.sk,attributes:[...attrs].map(([name,a])=>({name,count:a.count,types:[...a.types]})),examples:g.items.slice(0,3)}; });
 const patterns: AccessPattern[] = [{name:table.name,pk:undefined,sk:undefined},...table.indexes.map(i=>({name:i.name,pk:i.pk,sk:i.sk ?? undefined}))].flatMap((index)=>{
  const pk: KeyAttr=index.pk ?? table.keys.pk; const sk=index.sk ?? (index.name===table.name ? table.keys.sk ?? undefined : undefined); const present=items.filter(item=>item[pk.name] && (!sk || item[sk.name])); const matching=[...groups].filter(([,g])=>g.items.some(item=>present.includes(item))); const names=matching.map(([name])=>name);
  const common={name:index.name,index:index.name===table.name?undefined:index.name,count:present.length,sparse:present.length<items.length,overloaded:names.length>1,entities:names};
  if (!matching.length) return [{...common,description:`${index.name}: ${pk.name}${sk ? `로 ${sk.name} 범위 조회` : " 조회"}`}];
  return matching.map(([entity,g])=>{ const example=g.items.find(item=>present.includes(item))!; const pkValue=str(example,pk.name); const skValue=str(example,sk?.name); const skPrefix=prefix(skValue); return {...common,pk:pkValue,skPrefix:skPrefix ? skPrefix + skValue[skPrefix.length] : undefined,description:`${index.name}: ${pk.name}=${pkValue}${skPrefix ? `, ${sk?.name} begins_with ${skPrefix}${skValue[skPrefix.length]}` : sk ? `, ${sk.name} 범위` : ""} (${entity})`}; });
 });
 const diagnostics: Diagnostic[]=[]; const add=(id:Diagnostic["id"],level:Diagnostic["level"],count:number,detail:string)=>{if(count) diagnostics.push({id,level,count,detail});};
 const ttl=table.ttl?.status==="ENABLED" ? table.ttl.attribute : null;
 if(ttl){ const missing=items.filter(i=>!i[ttl]).length; const invalid=items.filter(i=>i[ttl] && !("N" in i[ttl])).length; const numeric=items.filter(i=>i[ttl]?.N!==undefined); add("ttlMillis","warn",numeric.filter(i=>Number(i[ttl].N)>1e11).length,"TTL은 초 단위 Unix 시간이어야 지워져요."); add("ttlMissing","info",missing,"TTL 속성이 없는 아이템이에요."); add("ttlNotNumber","warn",invalid,"숫자가 아닌 TTL은 지워지지 않아요."); add("ttlExpiredPresent","info",numeric.filter(i=>Number(i[ttl].N)<now/1000).length,"만료됐지만 아직 남아 있어요. 삭제에는 보통 며칠 걸려요."); }
 const large=items.filter(i=>itemSize(i)>=100*1024), critical=large.filter(i=>itemSize(i)>=350*1024); add("largeItem",critical.length?"fail":"warn",large.length,"추정 크기가 100 KB 이상이에요 (한도 400 KB).");
 const counts=new Map<string,number>(); for(const item of items){const k=JSON.stringify(item[table.keys.pk.name]); counts.set(k,(counts.get(k)??0)+1);} add("hotKey","info",[...counts.values()].filter(n=>n/items.length>=0.2).length,"샘플의 20% 이상이 같은 파티션 키예요. Scan 샘플은 분포를 대략 따릅니다.");
 for(const entity of entities) for(const a of entity.attributes){ if(a.types.length>1) add("mixedType","warn",a.count,`${entity.name}: ${a.name}의 타입이 ${a.types.join(", ")}로 섞여 있어요.`); if(["version","revision","_version","ver"].includes(a.name) && a.types.includes("N")) add("versionAttr","info",a.count,`${entity.name}: ${a.name}은 버전 속성으로 보입니다.`); }
 return {sampleCount:items.length,entities,patterns,diagnostics};
}
