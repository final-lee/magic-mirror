/** 화면이 보관하는 최대 줄 수(백엔드 logs::KEEP_LINES와 같다) */
export const KEEP_LINES = 50_000;
/** 줄을 이만큼씩 묶어 둔다. 다 찬 묶음은 바뀌지 않아 다시 그리지 않는다. */
export const CHUNK = 1_000;

/** 보관하는 줄 하나. source는 `sourceKey(pod, container)` */
export interface LogEntry {
  source: string;
  /** 서버가 붙인 시각(RFC 3339). 없으면 null */
  ts: string | null;
  text: string;
}

/** Pod·컨테이너 흐름 하나를 가리키는 키(Pod·컨테이너 이름에는 `/`가 없다) */
export const sourceKey = (pod: string, container: string) => `${pod}/${container}`;

export interface LogChunk {
  /** 처음부터 센 묶음 번호(React key) */
  id: number;
  lines: LogEntry[];
}

export interface LogBuffer {
  chunks: LogChunk[];
  /** 지금 보관 중인 줄 수 */
  size: number;
  /** 받은 줄 수(지운 것 포함) */
  received: number;
  /** 오래된 줄을 지운 적이 있다 */
  trimmed: boolean;
}

export const EMPTY_BUFFER: LogBuffer = { chunks: [], size: 0, received: 0, trimmed: false };

/**
 * 줄을 뒤에 붙인 새 버퍼. 마지막 묶음만 새 배열이 되고 앞의 묶음은 그대로다.
 * 보관 한도를 넘으면 앞의 묶음을 통째로 지워 늘 최근 `keep`줄 이상(`keep + chunk` 미만)을 둔다.
 */
export function appendLines(buf: LogBuffer, lines: LogEntry[], keep = KEEP_LINES, chunk = CHUNK): LogBuffer {
  if (lines.length === 0) return buf;
  const chunks = [...buf.chunks];
  let rest = lines;
  while (rest.length > 0) {
    const last = chunks[chunks.length - 1];
    if (last && last.lines.length < chunk) {
      const room = chunk - last.lines.length;
      chunks[chunks.length - 1] = { id: last.id, lines: [...last.lines, ...rest.slice(0, room)] };
      rest = rest.slice(room);
    } else {
      chunks.push({ id: last ? last.id + 1 : 0, lines: rest.slice(0, chunk) });
      rest = rest.slice(chunk);
    }
  }
  let size = buf.size + lines.length;
  let trimmed = buf.trimmed;
  while (chunks.length > 1 && size - chunks[0].lines.length >= keep) {
    size -= chunks[0].lines.length;
    chunks.shift();
    trimmed = true;
  }
  return { chunks, size, received: buf.received + lines.length, trimmed };
}
