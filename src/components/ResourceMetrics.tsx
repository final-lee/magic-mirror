import { useState } from "react";
import { useResourceMetrics } from "../api/queries";
import type { MetricRange, Resource, ServiceInfo } from "../api/types";
import { ErrorState } from "./ErrorState";
import { MetricChart } from "./MetricChart";

const RANGES: { id: MetricRange; label: string }[] = [
  { id: "1h", label: "1시간" },
  { id: "3h", label: "3시간" },
  { id: "12h", label: "12시간" },
  { id: "1d", label: "1일" },
  { id: "3d", label: "3일" },
  { id: "1w", label: "1주" },
];

interface Props {
  profile: string;
  region: string;
  service: ServiceInfo;
  typeId: string;
  row: Resource;
}

/** 리소스 상세의 CloudWatch 지표: 기간 고르기와 지표마다 선 그래프. 저절로 다시 읽지 않는다(CloudWatch 요청은 돈이 든다). */
export function ResourceMetrics({ profile, region, service, typeId, row }: Props) {
  const [range, setRange] = useState<MetricRange>("3h");
  const q = useResourceMetrics(profile, region, service, typeId, row, range);
  const m = q.data;
  return (
    <section className="metrics" aria-label="CloudWatch 지표">
      <div className="metrics-bar">
        <span className="sect">CloudWatch 지표</span>
        {m && !m.note && <span className="dim metrics-where">{`${m.namespace} · ${m.region}`}</span>}
        {!m?.note && (
          <span className="metrics-tools">
            <span className="kv-seg" role="group" aria-label="기간">
              {RANGES.map((r) => (
                <button key={r.id} type="button" className={`kv-seg-btn${range === r.id ? " on" : ""}`} aria-pressed={range === r.id} onClick={() => setRange(r.id)} disabled={m?.daily}>
                  {r.label}
                </button>
              ))}
            </span>
            <button type="button" className="btn small" onClick={() => void q.refetch()} disabled={q.isFetching}>
              {q.isFetching ? "읽는 중…" : "다시 읽기"}
            </button>
          </span>
        )}
      </div>
      {q.isError ? (
        <ErrorState error={q.error} profile={profile} compact onRetry={() => void q.refetch()} />
      ) : !m ? (
        <div className="dim metrics-loading">지표를 읽는 중이에요…</div>
      ) : m.note ? (
        <p className="dim metrics-note">{m.note}</p>
      ) : (
        <>
          {m.daily && <p className="dim metrics-note">하루에 한 번 쌓이는 지표라 최근 2주를 하루 간격으로 보여요</p>}
          <div className="metrics-grid">
            {m.charts.map((c) => (
              <MetricChart key={`${c.metric}-${c.stat}`} chart={c} start={m.start} end={m.end} period={m.period} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
