import { useState } from "react";
import { errorMessage } from "../api/errors";
import { snsApi } from "./api";
import { endpointLabel } from "./format";
import type { FilterResult, FilterSample, SnsTopic } from "./types";

import { recent } from "./samples";
const initialSample: FilterSample = { attributes: [{ name: "", dataType: "String", value: "" }], body: null };

export function FilterTester({ topic, tabId }: { topic: SnsTopic; tabId: string }) {
  const [sample, setSample] = useState<FilterSample>(() => recent.get(tabId)?.[0] ?? initialSample);
  const [mode, setMode] = useState<"attributes" | "body">(() => recent.get(tabId)?.[0]?.body != null ? "body" : "attributes");
  const [results, setResults] = useState<FilterResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const update = (index: number, patch: Partial<FilterSample["attributes"][number]>) => setSample(s => ({ ...s, attributes: s.attributes.map((a, i) => i === index ? { ...a, ...patch } : a) }));
  const run = async () => {
    const current = { ...sample, attributes: mode === "attributes" ? sample.attributes : [], body: mode === "body" ? sample.body ?? "" : null };
    recent.set(tabId, [current, ...(recent.get(tabId) ?? []).filter(s => JSON.stringify(s) !== JSON.stringify(current))].slice(0, 10));
    setBusy(true); setError(null);
    try {
      setResults(await snsApi.filterTest(topic.subscriptions.map(s => ({ key: s.key, policy: s.attributes.FilterPolicy ?? (s.filter ? JSON.stringify(s.filter.policy) : null), scope: s.filter?.scope ?? (s.attributes.FilterPolicyScope === "MessageBody" ? "MessageBody" : "MessageAttributes") })), current));
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  return <section className="center sns-screen sns-workspace" aria-label="필터 시험">
    <h2>필터 시험</h2>
    <p>앱이 문서대로 판정한 결과예요. 실제 확인은 시험 발행 후 소비자 없는 구독 큐를 엿보세요.</p>
    <div className="toolbar">
      <label><input type="radio" checked={mode === "attributes"} onChange={() => setMode("attributes")} /> 메시지 속성</label>{" "}
      <label><input type="radio" checked={mode === "body"} onChange={() => setMode("body")} /> 본문 JSON</label>
    </div>
    {mode === "attributes" ? <div>{sample.attributes.map((attr, i) => <div key={i} className="toolbar">
      <input aria-label={`속성 이름 ${i + 1}`} placeholder="이름" value={attr.name} onChange={e => update(i, { name: e.target.value })} />
      <select aria-label={`속성 타입 ${i + 1}`} value={attr.dataType} onChange={e => update(i, { dataType: e.target.value as typeof attr.dataType })}><option>String</option><option>String.Array</option><option>Number</option><option>Binary</option></select>
      <input aria-label={`속성 값 ${i + 1}`} placeholder="값" value={attr.value} onChange={e => update(i, { value: e.target.value })} />
      <button className="btn small tone-secondary" onClick={() => setSample(s => ({ ...s, attributes: s.attributes.filter((_, n) => n !== i) }))}>행 지우기</button>
    </div>)}<button className="btn small tone-secondary" onClick={() => setSample(s => ({ ...s, attributes: [...s.attributes, { name: "", dataType: "String", value: "" }] }))}>속성 추가</button></div> : <textarea aria-label="본문 JSON 입력" rows={8} value={sample.body ?? ""} onChange={e => setSample(s => ({ ...s, body: e.target.value }))} />}
    <div className="toolbar"><button className="btn tone-primary" disabled={busy} onClick={() => void run()}>시험</button>
      {(recent.get(tabId)?.length ?? 0) > 0 && <label>최근 표본 <select aria-label="최근 표본" defaultValue="" onChange={e => { const selected = recent.get(tabId)?.[Number(e.target.value)]; if (selected) { setSample(selected); setMode(selected.body === null ? "attributes" : "body"); } }}><option value="" disabled>선택</option>{recent.get(tabId)?.map((s, i) => <option key={i} value={i}>{s.body ?? s.attributes.map(a => `${a.name}=${a.value}`).join(", ")}</option>)}</select></label>}
    </div>
    {error && <p role="alert">{error}</p>}
    {results && <table className="sns-table"><thead><tr><th>구독</th><th>결과</th><th>이유</th></tr></thead><tbody>{topic.subscriptions.map(sub => { const result = results.find(r => r.key === sub.key); return <tr key={sub.key}><td>{endpointLabel(sub, topic).name}</td><td>{!result?.verdict ? "판정 불가" : !sub.attributes.FilterPolicy && !sub.filter ? "필터 없음(받음)" : result.verdict.matched ? "받음" : "걸러짐"}</td><td>{result?.errors.map((e, i) => <div key={i}>{e.path && `${e.path}: `}{e.message}</div>)}{result?.verdict?.key && `${result.verdict.key}: `}{result?.verdict?.reason}</td></tr>; })}</tbody></table>}
  </section>;
}
