import { describe, expect, it } from "vitest";
import { gsi, table } from "../fixtures";
import { analyze } from "./design";
import type { Item } from "../items/types";
describe("design analysis",()=>{
 it("treats an unprefixed partition-only table as one entity",()=>{const report=analyze(table("stg"),[{id:{S:"abc"},revision:{N:"2"}},{id:{S:"def"},revision:{N:"3"}}]);expect(report.entities).toHaveLength(1);expect(report.entities[0].name).toContain("접두사 없음");expect(report.diagnostics.some(d=>d.id==="versionAttr")).toBe(true);});
 it("detects prefixes, sparse index, TTL and mixed types",()=>{const db=table("sample",{keys:{pk:{name:"PK",type:"S"},sk:{name:"SK",type:"S"}},ttl:{status:"ENABLED",attribute:"ttl"},indexes:[gsi("g",{pk:{name:"gpk",type:"S"}})]}); const items:Item[]=[{PK:{S:"USER#1"},SK:{S:"PROFILE#1"},score:{N:"3"},gpk:{S:"x"},ttl:{N:"1700000000000"},version:{N:"1"}},{PK:{S:"USER#2"},SK:{S:"PROFILE#2"},score:{S:"3"},ttl:{S:"bad"}},{PK:{S:"ORDER#1"},SK:{S:"ORDER#1"},body:{S:"x".repeat(103000)}},{PK:{S:"SESSION#1"},SK:{S:"SESSION#1"},ttl:{N:"1"}},{PK:{S:"ORG#1"},SK:{S:"ORG#1"}}];const r=analyze(db,items,1700000000000);expect(r.entities).toHaveLength(4);expect(r.patterns.find(p=>p.name==="g")?.sparse).toBe(true);for(const id of ["ttlMillis","ttlMissing","ttlNotNumber","ttlExpiredPresent","largeItem","mixedType","versionAttr"]) expect(r.diagnostics.some(d=>d.id===id)).toBe(true);});
});
