import { useRef, useState, type ReactNode } from "react";
import { SnsChangeDialog } from "./SnsChangeDialog";
import type { SnsTopicRef } from "./targets";
import type { SnsApplyResult, SnsChangeRequest, SnsPlan } from "./types";

interface StartOptions {
  /** 변경별 추가 정보(필터 판정 전후, 정책 검사)를 계획 아래에 그린다 */
  renderExtra?: (plan: SnsPlan) => ReactNode;
  /** 적용 호출이 끝났을 때(일부만 하고 실패한 경우 포함) 한 번 */
  onApplied?: (result: SnsApplyResult) => void;
}

/**
 * 화면이 변경 대화창(SnsChangeDialog)을 여는 방법. `start(request)`로 열고, `dialog`를 화면 어딘가에 그린다.
 * 요청은 열릴 때 한 번만 읽히므로 열 때마다 새 `key`(nonce)로 만든다.
 */
export function useSnsChange(target: Pick<SnsTopicRef, "profile" | "region">) {
  const [open, setOpen] = useState<(StartOptions & { request: SnsChangeRequest; nonce: number }) | null>(null);
  const nonce = useRef(0);
  const start = (request: SnsChangeRequest, options: StartOptions = {}) => setOpen({ request, ...options, nonce: ++nonce.current });
  const dialog = open ? <SnsChangeDialog key={open.nonce} profile={target.profile} region={target.region} request={open.request} renderExtra={open.renderExtra} onApplied={open.onApplied} onClose={() => setOpen(null)} /> : null;
  return { start, dialog };
}
