import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import type { Notice } from "./rules";
import { noticeBody, noticeTitle } from "./text";

export type NotifyPermission = "granted" | "denied";

/** 지금 알림이 허용돼 있는가(묻지 않는다) */
export const notifyGranted = () => isPermissionGranted();

/** 알림을 켤 때 한 번 묻는다. 이미 허용됐으면 묻지 않고, 거절하면 macOS가 다시 묻지 않는다(시스템 설정에서 바꿔야 한다) */
export async function askNotifyPermission(): Promise<NotifyPermission> {
  if (await isPermissionGranted()) return "granted";
  return (await requestPermission()) === "granted" ? "granted" : "denied";
}

/** 알림 하나를 보낸다. 허용되지 않았으면 조용히 건너뛴다 */
export async function deliver(serverName: string, notice: Notice): Promise<void> {
  if (!(await isPermissionGranted())) return;
  sendNotification({ title: noticeTitle(serverName), body: noticeBody(notice) });
}
