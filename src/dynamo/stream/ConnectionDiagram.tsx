import { hasNoConsumers, lambdaFunctionName } from "./connections";
import * as t from "./text";
import type { Connections, Esm, KinesisDestination, Pipe, ReplicaConnection } from "./types";

/** 매핑 설정 접기 안에 보이는 JSON. 읽은 값을 그대로 보인다 */
function mappingSettings(esm: Esm): string {
  const settings = {
    startingPosition: esm.startingPosition,
    parallelization: esm.parallelization,
    bisect: esm.bisect,
    retries: esm.retries,
    maxAge: esm.maxAge,
    failureDestination: esm.failureDestination,
    filters: esm.filters,
  };
  return JSON.stringify(settings, null, 2);
}

interface EsmNodeProps {
  esm: Esm;
  /** 없으면 이동 버튼을 그리지 않는다 */
  onOpenLambda?: (functionArn: string) => void;
}

function EsmNode({ esm, onOpenLambda }: EsmNodeProps) {
  return (
    <div className="ddb-stream-node">
      <b>{t.lambdaNode(lambdaFunctionName(esm.function))}</b>
      <small>
        {esm.state} · {t.batchAndAge(esm.batchSize, esm.iteratorAgeMs)}
      </small>
      <details>
        <summary>{t.MAPPING_SETTINGS}</summary>
        <pre>{mappingSettings(esm)}</pre>
      </details>
      {onOpenLambda && (
        <button type="button" className="btn small tone-nav" onClick={() => onOpenLambda(esm.function)}>
          {t.JUMP}
        </button>
      )}
    </div>
  );
}

function PipeNode({ pipe }: { pipe: Pipe }) {
  return (
    <div className="ddb-stream-node">
      <b>{t.pipeNode(pipe.name)}</b>
      <small>{pipe.state}</small>
      <small>{pipe.target}</small>
    </div>
  );
}

function KinesisNode({ destination }: { destination: KinesisDestination }) {
  return (
    <div className="ddb-stream-node">
      <b>{t.KINESIS}</b>
      <small>{destination.arn}</small>
      <small>
        {destination.state} · {destination.precision ?? t.NONE_VALUE}
      </small>
    </div>
  );
}

function ReplicaNode({ replica }: { replica: ReplicaConnection }) {
  return (
    <div className="ddb-stream-node">
      <b>{t.replicaNode(replica.region)}</b>
      <small>{t.replicaLine(replica.status, replica.class, replica.latencyMs)}</small>
    </div>
  );
}

interface Props {
  tableName: string;
  connections: Connections;
  onOpenLambda?: (functionArn: string) => void;
}

/** 연결 그림: 테이블 → 스트림 → ESM·Pipe, 테이블 → Kinesis, 테이블 ↔ 복제본 */
export function ConnectionDiagram({ tableName, connections, onOpenLambda }: Props) {
  return (
    <div className="ddb-stream-graph">
      <div className="ddb-stream-node">
        <b>{tableName}</b>
      </div>
      {connections.stream && (
        <div className="ddb-stream-branch">
          <div className="ddb-stream-node">
            <b>{t.STREAM}</b>
            <small>{connections.stream.viewType}</small>
          </div>
          <div className="ddb-stream-children">
            {connections.esms.map((esm) => (
              <EsmNode key={esm.id} esm={esm} onOpenLambda={onOpenLambda} />
            ))}
            {connections.pipes.map((pipe) => (
              <PipeNode key={pipe.name} pipe={pipe} />
            ))}
            {hasNoConsumers(connections) && <span className="dim">{t.NO_CONSUMERS}</span>}
          </div>
        </div>
      )}
      {connections.kinesis.map((destination) => (
        <div className="ddb-stream-branch" key={destination.arn}>
          <KinesisNode destination={destination} />
        </div>
      ))}
      {connections.replicas.map((replica) => (
        <div className="ddb-stream-branch" key={replica.region}>
          <ReplicaNode replica={replica} />
        </div>
      ))}
    </div>
  );
}
