import { DetailPanel } from "../components/DetailPanel";
import type { DetailData } from "../lib/detail";
import { formatBytes } from "../lib/format";
import { formatCount, formatTtl } from "./format";
import { KvError } from "./KvError";
import { useKvKey } from "./queries";
import * as t from "./text";
import type { KvFeature, KvKeyName, KvKeyView, KvTarget } from "./types";
import { ValueViewer } from "./ValueViewer";
import { mergeValue } from "./value";

interface Props {
  target: KvTarget;
  name: KvKeyName;
  /** 서버리스에서 막힌 기능: 메모리·인코딩은 "볼 수 없음"으로 보인다 */
  unsupported: readonly KvFeature[];
  onClose: () => void;
}

/** 값 상세에 위쪽에 보이는 공통 정보(타입, TTL, 길이, 메모리, 인코딩) */
function commonRows(view: KvKeyView, readAt: number, unsupported: readonly KvFeature[]): DetailData["rows"] {
  const unit = t.LENGTH_UNIT[view.type];
  return [
    { label: t.ROW_TYPE, value: view.type },
    { label: t.ROW_TTL, value: formatTtl(view.ttlMs, readAt) },
    { label: t.ROW_LENGTH, value: view.length === null ? t.DASH : `${formatCount(view.length)}${unit ? ` ${unit}` : ""}` },
    { label: t.ROW_MEMORY, value: unsupported.includes("memory") ? t.NOT_AVAILABLE : view.memory === null ? t.DASH : formatBytes(view.memory) },
    { label: t.ROW_ENCODING, value: unsupported.includes("encoding") ? t.NOT_AVAILABLE : (view.encoding ?? t.DASH) },
  ];
}

/**
 * 키 하나의 값 상세. 목록의 70%를 덮는 오른쪽 상세(DetailPanel)를 쓴다.
 * 컬렉션은 쪽마다 읽어서(next 커서) [더 읽기]로 잇는다. 값은 화면과 쿼리 캐시에만 있다.
 */
export function KeyDetail({ target, name, unsupported, onClose }: Props) {
  const q = useKvKey(target, name);
  const pages = q.data?.pages;
  const first = pages?.[0];
  const binary = name.base64 !== null;
  const detail: DetailData = {
    title: name.text,
    subtitle: first ? (binary ? `${first.type} · ${t.BINARY_NAME}` : first.type) : t.LOADING,
    rows: first ? commonRows(first, q.dataUpdatedAt, unsupported) : [],
    tags: {},
    copy: { label: binary ? t.KEY_COPY_LABEL_BINARY : t.KEY_COPY_LABEL, value: binary ? name.base64! : name.text },
    consoleUrl: null,
    raw: null,
  };
  return (
    <DetailPanel detail={detail} onShowRaw={() => {}} onClose={onClose}>
      {first && pages ? (
        <ValueViewer value={mergeValue(pages)} total={first.length} hasMore={!!q.hasNextPage} fetching={q.isFetchingNextPage} onMore={() => void q.fetchNextPage()} />
      ) : q.isError ? (
        <KvError error={q.error} target={target} compact />
      ) : (
        <div className="empty small">{t.LOADING}</div>
      )}
      {first && q.isError && <KvError error={q.error} target={target} compact />}
    </DetailPanel>
  );
}
