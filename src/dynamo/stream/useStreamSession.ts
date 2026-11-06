import { useCallback, useEffect, useState } from "react";
import type { AppError } from "../../api/types";
import { appendRecords } from "./records";
import { runSession } from "./session";
import type { StartFrom, StreamPoll, StreamRecord } from "./types";

interface Target {
  profile: string;
  region: string;
  table: string;
  /** 이 탭이 보이는가. 숨으면 세션을 멈춘다 */
  active: boolean;
}

export interface StreamSession {
  running: boolean;
  records: StreamRecord[];
  shards: number;
  behind: number;
  error: AppError | null;
  start: (from: StartFrom) => void;
  stop: () => void;
}

const IDLE_STATUS = { shards: 0, behind: 0 };

/**
 * 스트림 읽기 세션의 수명. 시작하면 탭이 보이는 동안 2초마다 읽고,
 * 멈추거나 탭이 숨거나 테이블(프로필·리전)이 바뀌거나 화면이 사라지면 세션을 지운다. 읽은 레코드는 메모리에만 두고 최근 2,000개까지다.
 * 숨거나 바뀌면 읽던 레코드도 비운다.
 */
export function useStreamSession({ profile, region, table, active }: Target): StreamSession {
  const [startedFrom, setStartedFrom] = useState<StartFrom | null>(null);
  const [records, setRecords] = useState<StreamRecord[]>([]);
  const [status, setStatus] = useState(IDLE_STATUS);
  const [error, setError] = useState<AppError | null>(null);

  // 대상이 바뀌면 그린 직후가 아니라 그리기 전에 비운다: 효과가 새 대상에 낡은 시작 지점으로 세션을 열지 않게
  const scope = `${profile}/${region}/${table}/${active}`;
  const [seenScope, setSeenScope] = useState(scope);
  if (seenScope !== scope) {
    setSeenScope(scope);
    setStartedFrom(null);
    setRecords([]);
    setStatus(IDLE_STATUS);
    setError(null);
  }

  useEffect(() => {
    if (startedFrom === null || !active) return;
    const onPage = (page: StreamPoll) => {
      setRecords((current) => appendRecords(current, page.records));
      setStatus({ shards: page.shards, behind: page.behind });
    };
    const onError = (e: AppError) => {
      setError(e);
      setStartedFrom(null);
    };
    return runSession({ profile, region, table, from: startedFrom }, { onPage, onError });
  }, [startedFrom, active, profile, region, table]);

  const start = useCallback((from: StartFrom) => {
    setError(null);
    setRecords([]);
    setStatus(IDLE_STATUS);
    setStartedFrom(from);
  }, []);
  const stop = useCallback(() => setStartedFrom(null), []);

  return { running: startedFrom !== null, records, ...status, error, start, stop };
}
