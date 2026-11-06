import type { AppError } from "../../api/types";
import { streamApi } from "./api";
import type { StartFrom, StreamPoll } from "./types";

/** 새 레코드를 읽는 간격. 샤드당 초당 읽기 한도(5회)를 소비자와 나눠 쓰므로 느긋하게 읽는다 */
export const POLL_INTERVAL_MS = 2000;

export interface SessionTarget {
  profile: string;
  region: string;
  table: string;
  from: StartFrom;
}

export interface SessionHandlers {
  onPage: (page: StreamPoll) => void;
  onError: (error: AppError) => void;
}

/**
 * 읽기 세션을 열고 `POLL_INTERVAL_MS`마다 읽는다. 다음 읽기는 앞의 읽기가 끝난 뒤에 예약해서 겹치지 않는다.
 * 돌려주는 함수가 읽기를 멈추고 세션을 지운다(세션을 여는 중이었으면 열리는 대로 지운다).
 * 오류가 나면 `onError`를 한 번 부르고 더는 읽지 않는다.
 */
export function runSession({ profile, region, table, from }: SessionTarget, { onPage, onError }: SessionHandlers): () => void {
  let cancelled = false;
  let streamId: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const fail = (error: unknown) => {
    if (!cancelled) onError(error as AppError);
  };

  const poll = async (id: string) => {
    try {
      const page = await streamApi.poll(id);
      if (cancelled) return;
      onPage(page);
      timer = setTimeout(() => void poll(id), POLL_INTERVAL_MS);
    } catch (error) {
      fail(error);
    }
  };

  streamApi.start(profile, region, table, from).then(({ streamId: opened }) => {
    if (cancelled) {
      void streamApi.stop(opened);
      return;
    }
    streamId = opened;
    timer = setTimeout(() => void poll(opened), POLL_INTERVAL_MS);
  }, fail);

  return () => {
    cancelled = true;
    clearTimeout(timer);
    if (streamId !== null) void streamApi.stop(streamId);
  };
}
