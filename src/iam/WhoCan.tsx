import { useMemo, useState } from "react";
import { ErrorState } from "../components/ErrorState";
import { Source } from "./ActionDrilldown";
import { ActionInput } from "./ActionInput";
import { BadgeList } from "./Badges";
import { KIND_LABEL, STATUS_LABEL } from "./labels";
import { useIamCatalog, useSimulation, useWhoCan } from "./queries";
import { policyRoute, principalRoute, type IamRoute, type WhoCanSearch } from "./route";
import type { IamOverview, SimulateResult, WhoCanResult } from "./types";

interface Props {
  profile: string;
  /** 근거에 나온 그룹 이름을 그룹 상세로 연결하는 데 쓴다 */
  overview: IamOverview;
  onOpen: (route: IamRoute) => void;
  /** 뒤로 가기로 돌아왔을 때 마지막으로 찾은 조건을 되살린다(결과는 캐시에서 바로 나온다) */
  initial?: WhoCanSearch;
  onViewState?: (state: { search: WhoCanSearch }) => void;
}

const NO_ACTIONS: string[] = [];

/** AWS 정책 시뮬레이터가 알려 준 결과. 암시적 거부는 "허용하는 문장이 없다"는 뜻이라 명시적 거부와 색을 달리한다. */
const DECISION: Record<SimulateResult["decision"], { label: string; tone: string }> = {
  allowed: { label: "허용", tone: "allowed" },
  explicitDeny: { label: "명시적 거부", tone: "denied" },
  implicitDeny: { label: "허용 안 됨", tone: "" },
};

export function WhoCan({ profile, overview, onOpen, initial, onViewState }: Props) {
  const catalog = useIamCatalog();
  const [action, setAction] = useState(initial?.action ?? "");
  const [resource, setResource] = useState(initial?.resource ?? "");
  const [search, setSearch] = useState<WhoCanSearch | null>(initial ?? null);
  const q = useWhoCan(profile, search);

  const run = () => {
    const next = { action: action.trim(), resource: resource.trim() };
    if (!next.action) return;
    if (search && search.action === next.action && search.resource === next.resource) {
      // 같은 조건으로 다시 누르면 현재 스냅숏으로 다시 계산한다
      if (!q.isFetching) void q.refetch();
      return;
    }
    setSearch(next);
    onViewState?.({ search: next });
  };

  return (
    <section className="center wc">
      <div className="wc-form" role="search" aria-label="누가 할 수 있나 검색">
        <div className="wc-field wc-action">
          <span className="wc-label" aria-hidden="true">
            작업
          </span>
          <ActionInput label="작업" value={action} onChange={setAction} onSubmit={run} options={catalog.data ?? NO_ACTIONS} placeholder="s3:GetObject" />
        </div>
        <div className="wc-field wc-resource">
          <span className="wc-label" aria-hidden="true">
            대상 ARN <small className="dim">(선택)</small>
          </span>
          <input
            type="text"
            className="iam-filter"
            aria-label="대상 ARN"
            placeholder="arn:aws:s3:::my-bucket/*"
            autoComplete="off"
            spellCheck={false}
            value={resource}
            onChange={(e) => setResource(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") run();
            }}
          />
        </div>
        <button className="btn primary wc-go" disabled={!action.trim() || q.isFetching} onClick={run}>
          찾기
        </button>
      </div>
      {catalog.isError && <div className="iam-hint">작업 목록을 불러오지 못해서 자동 완성은 쓸 수 없어요</div>}

      {!search ? (
        <div className="empty small">작업 이름을 입력하면 그 작업을 할 수 있는 사용자와 역할을 찾아요</div>
      ) : q.data ? (
        <>
          {q.isError && <ErrorState compact error={q.error} profile={profile} onRetry={() => void q.refetch()} />}
          <Results profile={profile} result={q.data} overview={overview} onOpen={onOpen} />
        </>
      ) : q.isError ? (
        <ErrorState error={q.error} profile={profile} onRetry={() => void q.refetch()} />
      ) : (
        <div className="empty small">찾는 중…</div>
      )}
    </section>
  );
}

interface ResultsProps {
  profile: string;
  result: WhoCanResult;
  overview: IamOverview;
  onOpen: (route: IamRoute) => void;
}

function Results({ profile, result, overview, onOpen }: ResultsProps) {
  const { hits } = result;
  // 물어보는 대상은 입력창이 아니라 방금 찾은 결과의 조건이다(찾은 뒤 입력창을 고쳤을 수 있다)
  const sim = useSimulation(
    profile,
    hits.map((h) => h.principal.arn),
    result.action,
    result.resource,
  );
  const decisions = useMemo(() => new Map((sim.data ?? []).map((r) => [r.principalArn, r])), [sim.data]);
  const asked = !!sim.data;

  const openGroup = (name: string) => {
    const group = overview.groups.find((g) => g.name === name);
    if (group) onOpen(principalRoute("group", group.arn));
  };

  return (
    <div className="wc-results">
      <div className="wc-sum" data-testid="who-can-summary">
        <span className="mono wc-act">{result.action}</span>
        {result.resource && <span className="mono dim wc-arn">{result.resource}</span>}
        <span className="dim">{hits.length}개</span>
        <span className="wc-sum-end">
          <button className="btn small" disabled={sim.isFetching || hits.length === 0} onClick={() => void sim.refetch()}>
            {sim.isFetching ? "확인하는 중…" : asked ? "다시 확인" : "AWS로 확인"}
          </button>
        </span>
      </div>
      {sim.isFetching && (
        <div className="iam-hint" role="status">
          AWS 정책 시뮬레이터로 확인하는 중이에요…
        </div>
      )}
      {/* 누를 때만 도는 쿼리(enabled: false)라서 로그인 관리자의 무효화로는 다시 불리지 않는다. 로그인이 끝나면 상자가 이 쿼리만 다시 부른다 */}
      {sim.isError && (
        <ErrorState compact error={sim.error} profile={profile} onRetry={() => void sim.refetch()} onLoggedIn={() => void sim.refetch()} />
      )}
      {result.notes.map((n) => (
        <div className="iam-hint" key={n}>
          <span aria-hidden="true">ⓘ</span> <span>{n}</span>
        </div>
      ))}
      {hits.length === 0 ? (
        <div className="empty small">이 작업을 할 수 있는 사용자와 역할이 없어요</div>
      ) : (
        <table className="wc-table" aria-label="찾은 주체">
          <thead>
            <tr>
              <th scope="col" className="nosort">주체</th>
              <th scope="col" className="nosort">결과</th>
              <th scope="col" className="nosort">근거</th>
              {asked && <th scope="col" className="nosort">AWS 확인</th>}
            </tr>
          </thead>
          <tbody>
            {hits.map((h) => (
              <tr key={h.principal.arn}>
                <td>
                  <span className="iam-chip">{KIND_LABEL[h.principal.kind]}</span>{" "}
                  <button className="link wc-name" onClick={() => onOpen(principalRoute(h.principal.kind, h.principal.arn))}>
                    {h.principal.name}
                  </button>{" "}
                  <BadgeList badges={h.principal.badges} />
                </td>
                <td>
                  <span className={`iam-chip ${h.status}`}>{STATUS_LABEL[h.status]}</span>
                </td>
                <td>
                  <ul className="dr-src" aria-label="근거">
                    {h.sources.map((s, i) => (
                      <Source key={i} s={s} onOpenPolicy={(id) => onOpen(policyRoute(id))} onOpenGroup={openGroup} />
                    ))}
                  </ul>
                </td>
                {asked && (
                  <td>
                    <Decision result={decisions.get(h.principal.arn)} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** 이 주체의 AWS 판정. 시뮬레이터는 찾은 주체 모두에 대해 물었으니, 결과가 없으면 그 주체만 실패한 것이다(권한 없음 등) */
function Decision({ result }: { result: SimulateResult | undefined }) {
  if (!result) return <span className="dim">확인하지 못했어요</span>;
  const d = DECISION[result.decision];
  return (
    <>
      <span className={`iam-chip ${d.tone}`}>{d.label}</span>
      {result.missingContext.length > 0 && (
        <div className="wc-missing dim">조건 값이 필요해요: {result.missingContext.join(", ")}</div>
      )}
    </>
  );
}
