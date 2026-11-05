import { createContext, useContext } from "react";
import type { KvLogin, KvLoginSaved, KvTargetInfo } from "./types";

/**
 * 탭이 아래 화면에 주는 로그인 도구. 쿼리가 loginRequired로 실패하면 그 화면이 자리에서 로그인 상자를 띄우고(KvError),
 * 로그인을 보내면 탭이 새로 연결한다.
 */
export interface KvLoginApi {
  info: KvTargetInfo;
  /** 지금 쓰는(또는 쓰려던) 로그인. 처음이면 null */
  current: KvLoginSaved | null;
  connect: (login: KvLogin) => void;
}

export const KvLoginContext = createContext<KvLoginApi | null>(null);

export const useKvLogin = () => useContext(KvLoginContext);
