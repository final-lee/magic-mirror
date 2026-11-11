import type { DetailContext } from "../TableDetail";
import { ConnectionsCard } from "./ConnectionsCard";
import { LiveRecords } from "./LiveRecords";
import "./stream.css";

/**
 * 스트림 탭: 위에 연결 그림, 스트림이 켜져 있으면 그 아래 실시간 레코드.
 * 스트림을 껐다 켜면 ARN이 바뀌어 읽던 세션이 낡으므로(`key`) 세션을 지우고 처음부터 시작하게 한다.
 */
export function StreamTab({ profile, region, table, active, onOpenLambda }: DetailContext) {
  return (
    <div className="ddb-stream">
      <ConnectionsCard profile={profile} region={region} tableName={table.name} active={active} onOpenLambda={onOpenLambda} />
      {table.stream && <LiveRecords key={table.stream.arn} profile={profile} region={region} table={table.name} active={active} />}
    </div>
  );
}
