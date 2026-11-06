import { AttributeDiff } from "../items/AttributeDiff";
import { attributeChanges } from "./records";
import * as t from "./text";
import type { StreamRecord } from "./types";

/** 이전·새 이미지를 속성별로 맞댄 표. 뷰 타입이 이미지를 담지 않으면(KEYS_ONLY) 안내만 보인다 */
export function RecordDiff({ record }: { record: StreamRecord }) {
  const changes = attributeChanges(record);
  if (changes.length === 0) return <p className="dim">{t.MISSING}</p>;
  return <AttributeDiff changes={changes} attribute={t.ATTRIBUTE} before={t.OLD} after={t.NEW} />;
}
