import { useMemo } from "react";
import { desktop } from "../api/desktop";
import { ErrorState } from "../components/ErrorState";
import { formatAgo, formatDateTime, formatDay } from "./format";
import { useLastAccessed } from "./queries";
import type { IamChange, LastAccessed } from "./types";

interface Props {
  profile: string;
  /** 살펴볼 사용자·역할의 ARN */
  arn: string;
  onOpenPolicy: (policyId: string) => void;
  onOpenGroup: (name: string) => void;
  /** 떼기·삭제·저장을 누르면 그 변경을 넘긴다(변경 미리보기가 열린다) */
  onFix: (change: IamChange) => void;
  /** 바꿀 수 없는 주체(서비스 연결·Identity Center 역할)면 그 이유. 있으면 변경 버튼을 끄고 이유를 보여준다 */
  blockedReason?: string | null;
}

type Service = LastAccessed["services"][number];
type UnusedPolicy = LastAccessed["unusedPolicies"][number];

/** 초안은 사용 기록만 보고 만든 제안이라, 저장하기 전에 알아야 할 점을 초안 아래에 늘 보여준다. */
const CAUTIONS = [
  "사용 기록이 없는 권한은 빠져 있어요. 가끔 쓰는 작업이 있다면 저장하기 전에 확인하세요.",
  "저장해도 지금 붙어 있는 정책은 그대로예요. 권한을 실제로 줄이려면 저장한 뒤 넓은 정책을 떼세요.",
];

/** 안 쓴 서비스가 먼저, 그다음은 마지막 사용이 오래된 순. 같으면 이름순이다. */
function sortServices(services: Service[]): Service[] {
  const time = (s: Service) => (s.lastUsed ? Date.parse(s.lastUsed) || -Infinity : -Infinity);
  return [...services].sort((a, b) => time(a) - time(b) || a.name.localeCompare(b.name, "ko"));
}

/** 보기 좋게 들여 쓴다. JSON이 아니면 받은 그대로 보여준다. */
function indent(document: string): string {
  try {
    return JSON.stringify(JSON.parse(document), null, 2);
  } catch {
    return document;
  }
}

/** 줄인 정책을 저장할 인라인 정책 이름: least-privilege-20261026 */
const draftName = () => `least-privilege-${formatDay(new Date().toISOString()).replace(/-/g, "")}`;

/** 사용자·역할 상세의 "안 쓰는 권한" 탭. AWS 쪽 집계가 10~30초 걸려서 누를 때만 불러오고, 받은 결과는 캐시에 남긴다. */
export function UnusedPermissions({ profile, arn, onOpenPolicy, onOpenGroup, onFix, blockedReason = null }: Props) {
  const q = useLastAccessed(profile, arn);
  const data = q.data;
  const load = () => void q.refetch();
  const services = useMemo(() => sortServices(data?.services ?? []), [data?.services]);

  const progress = q.isFetching && (
    <p className="up-progress" role="status">
      AWS가 서비스별 마지막 사용 시각을 모으는 중이에요. 최대 30초 걸려요
    </p>
  );
  const error = q.isError && <ErrorState compact error={q.error} profile={profile} onRetry={load} />;

  if (!data) {
    return (
      <div className="up">
        <div className="up-intro">
          <p>AWS가 기록한 마지막 사용 시각을 보고, 허용받고도 쓰지 않은 서비스와 정책을 찾아요.</p>
          <p className="dim">AWS가 집계하는 동안 10~30초 걸릴 수 있어요.</p>
          <button className="btn primary" disabled={q.isFetching} onClick={load}>
            {q.isFetching ? "불러오는 중…" : "불러오기"}
          </button>
          {progress}
          {error}
        </div>
      </div>
    );
  }

  const completed = formatDateTime(data.completedAt);
  const pretty = data.draft === null ? null : indent(data.draft);

  return (
    <div className="up">
      <div className="up-bar">
        <span className="dim">
          최근 {data.trackingDays}일 사용 기록{completed && ` · 집계 ${completed}`}
        </span>
        <button className="btn small" disabled={q.isFetching} onClick={load}>
          {q.isFetching ? "불러오는 중…" : "다시 불러오기"}
        </button>
      </div>
      {progress}
      {error}
      {blockedReason && (
        <div className="iam-hint">
          <span aria-hidden="true">ⓘ</span> <span>{blockedReason}</span>
        </div>
      )}

      <h3 className="up-h">서비스별 마지막 사용</h3>
      {services.length === 0 ? (
        <div className="empty small">허용된 서비스가 없어요</div>
      ) : (
        <table aria-label="서비스별 마지막 사용">
          <thead>
            <tr>
              <th scope="col" className="nosort">서비스</th>
              <th scope="col" className="nosort">마지막 사용</th>
            </tr>
          </thead>
          <tbody>
            {services.map((s) => (
              <tr key={s.prefix}>
                <td>
                  {s.name} <small className="mx-prefix mono">{s.prefix}</small>
                </td>
                <td>
                  {s.lastUsed ? (
                    <>
                      {formatDay(s.lastUsed)} <span className="dim">{formatAgo(s.lastUsed)}</span>
                    </>
                  ) : (
                    <span className="iam-chip conditional">{`사용 안 함 (${data.trackingDays}일)`}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 className="up-h">통째로 안 쓰는 정책</h3>
      {data.unusedPolicies.length === 0 ? (
        <div className="empty small">통째로 안 쓰는 정책이 없어요</div>
      ) : (
        <table aria-label="통째로 안 쓰는 정책">
          <thead>
            <tr>
              <th scope="col" className="nosort">정책</th>
              <th scope="col" className="nosort">이유</th>
              <th scope="col" className="nosort">조치</th>
            </tr>
          </thead>
          <tbody>
            {data.unusedPolicies.map((p) => (
              <PolicyRow key={`${p.policyId}|${p.via ?? ""}`} policy={p} arn={arn} onOpenPolicy={onOpenPolicy} onOpenGroup={onOpenGroup} onFix={onFix} blockedReason={blockedReason} />
            ))}
          </tbody>
        </table>
      )}

      <h3 className="up-h">줄인 정책 초안</h3>
      {pretty === null ? (
        <div className="empty small">만들 수 있는 초안이 없어요</div>
      ) : (
        <div className="up-draft">
          <div className="iam-json-bar">
            <button className="btn small" aria-label="초안 복사" onClick={() => void desktop.copy(pretty)}>
              복사
            </button>
            <button
              className="btn small"
              disabled={!!blockedReason}
              title={blockedReason ?? undefined}
              onClick={() => onFix({ op: "putInlinePolicy", target: arn, name: draftName(), document: pretty })}
            >
              인라인 정책으로 저장
            </button>
          </div>
          <pre className="raw" data-testid="draft-json">
            {pretty}
          </pre>
          {CAUTIONS.map((c) => (
            <div className="up-caution" key={c}>
              <span aria-hidden="true">⚠</span> <span>{c}</span>
            </div>
          ))}
        </div>
      )}
      {data.draftNotes.map((n) => (
        <div className="iam-hint" key={n}>
          <span aria-hidden="true">ⓘ</span> <span>{n}</span>
        </div>
      ))}
    </div>
  );
}

function PolicyRow({
  policy,
  arn,
  onOpenPolicy,
  onOpenGroup,
  onFix,
  blockedReason,
}: { policy: UnusedPolicy; arn: string } & Pick<Props, "onOpenPolicy" | "onOpenGroup" | "onFix" | "blockedReason">) {
  // 인라인 정책은 붙은 것이 아니라 주체 안에 들어 있어서 떼는 대신 지운다
  const inline = policy.policyId.startsWith("inline:");
  const change: IamChange = inline
    ? { op: "deleteInlinePolicy", target: arn, name: policy.name }
    : { op: "detachPolicy", target: arn, policyArn: policy.policyId };
  return (
    <tr>
      <td>
        <button className="link" onClick={() => onOpenPolicy(policy.policyId)}>
          {policy.name}
        </button>
      </td>
      <td className="dim">{policy.reason}</td>
      <td className="up-act">
        <button className="btn small" disabled={!!policy.via || !!blockedReason} title={blockedReason ?? undefined} onClick={() => onFix(change)}>
          {inline ? "삭제" : "떼기"}
        </button>
        {policy.via && (
          <span className="dim up-via">
            그룹{" "}
            <button className="link" onClick={() => onOpenGroup(policy.via!)}>
              {policy.via}
            </button>
            에서 {inline ? "지워야" : "떼야"} 해요
          </span>
        )}
      </td>
    </tr>
  );
}
