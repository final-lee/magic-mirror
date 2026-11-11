// 필터 시험기가 쓴 최근 표본(주제 탭마다 10개, 메모리에만). 필터 정책 변경 미리보기가 같은 표본으로 판정 전후를 보여 준다.
import type { FilterSample } from "./types";

/** 탭 id → 최근 표본(가장 최근이 앞) */
export const recent = new Map<string, FilterSample[]>();

export const recentSamples = (tabId: string): FilterSample[] => recent.get(tabId) ?? [];

/** 표본의 한 줄 이름: 본문이면 본문, 속성이면 `이름=값`들 */
export const sampleLabel = (sample: FilterSample): string => sample.body ?? sample.attributes.map((a) => `${a.name}=${a.value}`).join(", ");
