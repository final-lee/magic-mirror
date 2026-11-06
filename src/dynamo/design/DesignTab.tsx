import { useMemo, useState } from "react";
import { errorMessage } from "../../api/errors";
import type { DetailContext } from "../TableDetail";
import { itemsApi } from "../items/api";
import { ItemDetail } from "../items/ItemDetail";
import { openQuery, tableStoreKey, updateItems, useItems } from "../items/store";
import type { Item } from "../items/types";
import { analyze } from "./design";
import * as t from "./text";
export function Design({ profile, region, table, openItems }: DetailContext) {
 const key=tableStoreKey(profile,region,table.name), store=useItems(key); const report=useMemo(()=>analyze(table,store.items),[table,store.items]); const [busy,setBusy]=useState(false),[error,setError]=useState(""),[selected,setSelected]=useState<Item|null>(null);
 const sample=async()=>{setBusy(true);setError("");try{const page=await itemsApi.read(profile,region,table.name,{kind:"scan",index:null,filters:[],projection:[],consistent:false,limit:null,startKey:store.scanStarted?store.scanKey:null});const keys=[table.keys.pk.name,table.keys.sk?.name].filter((k):k is string=>!!k);const merged=new Map([...store.items,...page.items].map(item=>[JSON.stringify(keys.map(k=>item[k])),item]));updateItems(key,{items:[...merged.values()],scanKey:page.lastKey,scanStarted:true});}catch(e){setError(errorMessage(e));}finally{setBusy(false);}};
 return <div className="ddb-design"><p>{report.sampleCount.toLocaleString()}개 아이템 · {t.DISCLAIMER}</p><button className="btn small tone-refresh" disabled={busy || (store.scanStarted && !store.scanKey)} title={store.scanStarted && !store.scanKey?"마지막 페이지까지 읽었어요":undefined} onClick={()=>void sample()}>{t.SAMPLE}</button>{error && <p className="err">{error}</p>}
 <h3>{t.ENTITIES}</h3>{report.entities.map(e=><section key={e.name}><h4>{e.name} · {e.count}개 ({(e.count / report.sampleCount*100).toFixed(1)}%)</h4><p>PK {e.pkShape || "—"} {e.skShape && `· SK ${e.skShape}`}</p><p>{e.attributes.map(a=>`${a.name} ${Math.round(a.count/e.count*100)}% (${a.types.join("/")})`).join(" · ")}</p><div>{e.examples.map((item,i)=><button key={i} className="btn small tone-secondary" onClick={()=>setSelected(item)}>예시 키 {i+1}: {JSON.stringify(item[table.keys.pk.name])}</button>)}</div></section>)}
 <h3>{t.PATTERNS}</h3>{report.patterns.map((p,i)=><div key={`${p.name}-${i}`}><button className="btn small tone-nav" onClick={()=>{openQuery(key,{index:p.index,pk:p.pk,skPrefix:p.skPrefix});openItems();}}>{p.description}</button> {p.count}/{report.sampleCount} {p.sparse && "· 희소"} {p.overloaded && "· 여러 엔티티"} {p.entities.join(", ")}</div>)}
 <h3>{t.DIAGNOSTICS}</h3>{report.diagnostics.length===0?<p className="dim">진단할 항목이 없어요.</p>:<ul>{report.diagnostics.map((d,i)=><li key={i}><strong>{d.level} · {d.id}</strong> {d.detail} ({d.count})</li>)}</ul>}{selected && <ItemDetail item={selected} table={table} onClose={()=>setSelected(null)}/>}</div>;
}
