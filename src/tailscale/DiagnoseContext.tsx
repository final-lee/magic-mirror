import { createContext, useContext, type ReactNode } from "react";

const DiagnoseTargetContext = createContext<string | null>(null);

export function DiagnoseTargetProvider({ value, children }: { value: string | null; children: ReactNode }) {
  return <DiagnoseTargetContext.Provider value={value}>{children}</DiagnoseTargetContext.Provider>;
}

export function useDiagnoseTarget() {
  return useContext(DiagnoseTargetContext);
}
