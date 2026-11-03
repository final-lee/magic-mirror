import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

export const desktop = {
  openUrl: (url: string) => openUrl(url),
  copy: (text: string) => writeText(text),
  /** 파일을 Finder(탐색기)에서 보여 준다 */
  reveal: (path: string) => revealItemInDir(path),
};
