import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";

export const desktop = {
  openUrl: (url: string) => openUrl(url),
  copy: (text: string) => writeText(text),
};
