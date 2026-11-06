import { ErrorState } from "../../components/ErrorState";
import { Findings } from "../Findings";
import { ConnectionDiagram } from "./ConnectionDiagram";
import { useConnections } from "./queries";
import * as t from "./text";

interface Props {
  profile: string;
  region: string;
  tableName: string;
  /** 이 탭이 보일 때만 읽는다 */
  active: boolean;
  onOpenLambda?: (functionArn: string) => void;
}

/** 연결 카드: 연결 그림, 읽지 못한 부분, 연결 진단 */
export function ConnectionsCard({ profile, region, tableName, active, onOpenLambda }: Props) {
  const connections = useConnections(profile, region, tableName, active);
  const reread = () => void connections.refetch();
  const data = connections.data;

  return (
    <section className="ddb-card">
      <div className="ddb-card-head">
        <h4>{t.CONNECTIONS}</h4>
        <button type="button" className="btn small tone-refresh" onClick={reread} disabled={connections.isFetching}>
          {t.REFRESH}
        </button>
      </div>
      {connections.isError && <ErrorState compact error={connections.error} profile={profile} onRetry={reread} />}
      {!connections.isError && !data && <p className="dim">{t.LOADING}</p>}
      {!connections.isError && data && (
        <>
          <ConnectionDiagram tableName={tableName} connections={data} onOpenLambda={onOpenLambda} />
          {!data.stream && <p className="dim">{t.NO_STREAM}</p>}
          {data.gaps.map((gap) => (
            <p className="ddb-stream-gap" key={gap.section}>
              {t.gapLine(gap.section, gap.error)}
            </p>
          ))}
          {data.findings.length > 0 && (
            <>
              <h5>{t.FINDINGS}</h5>
              <Findings findings={data.findings} />
            </>
          )}
        </>
      )}
    </section>
  );
}
