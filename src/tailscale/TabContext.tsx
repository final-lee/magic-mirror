import { createContext, useContext, useState } from "react";

export type TailscaleTabId =
  | "mac" | "peers" | "users" | "routes" | "services" | "dns" | "policy" | "keys"
  | "logs" | "integrations" | "share" | "diagnosis" | "settings" | "connect" | "org";
export type DeviceView = "table" | "map";

interface TailscaleTabs {
  /** Tailscale 탭 안에서 다른 보기로 옮긴다. */
  select: (id: TailscaleTabId) => void;
  /** 기기 보기의 표·지도. 다른 보기에 다녀와도 남게 탭 셸이 쥔다 */
  deviceView: DeviceView;
  setDeviceView: (view: DeviceView) => void;
}

const TailscaleTabsContext = createContext<TailscaleTabs | null>(null);

export const TailscaleTabsProvider = TailscaleTabsContext.Provider;

/** 탭 셸 밖(없는 경우)에서는 null. 보기가 다른 보기로 넘어가자고 요청할 때 쓴다. */
export function useTailscaleTabs() {
  return useContext(TailscaleTabsContext);
}

/** 기기 보기의 표·지도 선택. 탭 셸 안에서는 셸이 기억하고, 밖(시험 등)에서는 이 컴포넌트만 기억한다 */
export function useDeviceView(): [DeviceView, (view: DeviceView) => void] {
  const tabs = useContext(TailscaleTabsContext);
  const [local, setLocal] = useState<DeviceView>("table");
  return tabs ? [tabs.deviceView, tabs.setDeviceView] : [local, setLocal];
}
