import { createContext, useContext } from "react";
import type { IamChange } from "./types";

/**
 * 변경 흐름이 화면에 끼어드는 자리.
 *
 * IamTab이 Provider로 `start`를 내려 주면, 상세 화면의 버튼(붙이기·떼기·키 비활성화 등)이
 * 변경 미리보기를 열고 확인 뒤 적용한다. Provider가 없으면(null) 읽기 전용이라 변경 버튼을 그리지 않는다.
 * 변경 UI는 이 컨텍스트만 읽으면 되고, 목록·상세 컴포넌트의 props를 늘릴 필요가 없다.
 */
export interface IamChangeApi {
  start: (change: IamChange, opts?: { undoOf?: string }) => void;
}

export const IamChangeContext = createContext<IamChangeApi | null>(null);

export const useIamChangeApi = () => useContext(IamChangeContext);
