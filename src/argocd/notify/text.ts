import type { Notice } from "./rules";

/** macOS 알림 문구. 제목에 서버 이름을 넣어 어느 ArgoCD인지 알 수 있게 한다 */
export const noticeTitle = (serverName: string) => `ArgoCD · ${serverName}`;

const MESSAGE_MAX = 120;

export function noticeBody(notice: Notice): string {
  switch (notice.kind) {
    case "degraded":
      return `${notice.app} 앱이 Degraded 상태가 됐어요`;
    case "operation": {
      const head = notice.phase === "Failed" ? `${notice.app} 앱의 작업이 실패했어요` : `${notice.app} 앱의 작업이 오류로 끝났어요`;
      const message = notice.message?.trim();
      return message ? `${head}: ${message.length > MESSAGE_MAX ? `${message.slice(0, MESSAGE_MAX)}…` : message}` : head;
    }
    case "outOfSync":
      return `${notice.app} 앱이 ${notice.minutes}분 넘게 OutOfSync예요`;
  }
}

export const NOTIFY_SECTION = "macOS 알림";
export const NOTIFY_ENABLE = "알림 켜기";
export const NOTIFY_HELP = "이 서버의 앱이 Degraded가 되거나, 작업이 실패하거나, OutOfSync가 오래 이어지면 macOS 알림으로 알려요. 앱이 켜져 있는 동안만 알려요.";
export const NOTIFY_ENVS = "알릴 환경";
export const NOTIFY_ENVS_ALL = "모든 환경";
export const NOTIFY_MINUTES = "OutOfSync 지속 시간(분)";
export const NOTIFY_DENIED = "macOS가 이 앱의 알림을 막고 있어요. 시스템 설정 > 알림에서 허용해 주세요";
export const NOTIFY_PERMISSION_FAILED = "알림 권한을 확인하지 못했어요";
