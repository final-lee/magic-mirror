import type { ReactNode } from "react";

/** 제목이 있는 상세 구역 */
export function Sect({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="k8s-sect" aria-label={title}>
      <h4>{title}</h4>
      {children}
    </section>
  );
}

/** 값이 없으면 줄을 그리지 않는 이름·값 한 줄 */
export function Kv({ label, children }: { label: string; children: ReactNode }) {
  if (children === null || children === undefined || children === "" || children === false) return null;
  return (
    <div className="k8s-kv">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
