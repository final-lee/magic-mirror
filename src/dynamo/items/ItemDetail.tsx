import { useState } from "react";
import { desktop } from "../../api/desktop";
import type { DynamoTable } from "../types";
import type { Attribute, Item } from "./types";
import { itemSize, plainItem, summary } from "./value";
import * as t from "./text";
function Tree({ name, value }: { name: string; value: Attribute }) {
 const [tag, content] = Object.entries(value)[0] ?? [];
 const children: [string, Attribute][] = tag === "M" ? Object.entries(content as Item) : tag === "L" ? (content as Attribute[]).map((v,i)=>[String(i),v]) : [];
 if(children.length) return <details><summary><b>{name}</b> <span className="iam-chip">{tag}</span> {summary(value)}</summary><div className="ddb-items-tree">{children.map(([k,v])=><Tree key={k} name={k} value={v}/>)}</div></details>;
 return <div><b>{name}</b> <span className="iam-chip">{tag}</span> {summary(value)} <button className="btn small tone-secondary" onClick={()=>void desktop.copy(JSON.stringify(value))}>{t.COPY}</button></div>;
}
export function ItemDetail({ item, table, onClose }: { item: Item; table: DynamoTable; onClose: () => void }) {
 const [mode,setMode]=useState<"tree"|"ddb"|"plain">("tree"); const size=itemSize(item); const ttl=table.ttl?.attribute; const seconds=ttl && item[ttl]?.N ? Number(item[ttl].N) : null;
 const keys=Object.fromEntries([table.keys.pk.name,table.keys.sk?.name].filter((k): k is string=>!!k && !!item[k]).map(k=>[k,item[k]]));
 return <div className="ddb-items-overlay" role="dialog" aria-modal="true" aria-label="아이템 상세"><div className="ddb-items-dialog"><header><h3>아이템 상세</h3><button className="btn small tone-ghost" onClick={onClose}>{t.CLOSE}</button></header><p>추정 크기 {size.toLocaleString()} B / 400 KB ({(size / 409600 * 100).toFixed(1)}%)</p>{seconds !== null && Number.isFinite(seconds) && <p>TTL: {new Date(seconds*1000).toLocaleString()} {seconds*1000<Date.now()?"(만료됐지만 아직 지워지지 않았어요)":`(약 ${Math.ceil((seconds*1000-Date.now())/3600000)}시간 남음)`}</p>}<div className="ddb-items-actions"><button className="btn small tone-secondary" onClick={()=>setMode("tree")}>트리</button><button className="btn small tone-secondary" onClick={()=>setMode("ddb")}>DynamoDB JSON</button><button className="btn small tone-secondary" onClick={()=>setMode("plain")}>일반 JSON</button><button className="btn small tone-secondary" onClick={()=>void desktop.copy(JSON.stringify(keys,null,2))}>키 복사</button><button className="btn small tone-secondary" onClick={()=>void desktop.copy(JSON.stringify(mode==="plain"?plainItem(item):item,null,2))}>아이템 복사</button></div>{mode==="tree" ? Object.entries(item).map(([k,v])=><Tree key={k} name={k} value={v}/>) : <pre>{JSON.stringify(mode==="plain"?plainItem(item):item,null,2)}</pre>}</div></div>;
}
