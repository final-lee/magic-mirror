import type { DynamoPreview } from "./types";

/** 이름 입력은 대소문자와 공백까지 정확히 일치해야 한다. */
export function canApply(preview: DynamoPreview, typed: string, loading: boolean): boolean {
  return !loading && !preview.blocked && (!preview.confirmName || preview.confirmName === typed);
}
