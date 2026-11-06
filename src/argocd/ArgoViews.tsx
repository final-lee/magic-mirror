import { ARGO_VIEWS_LABEL, ARGO_VIEW_APPS, ARGO_VIEW_RESOURCES, ARGO_VIEW_METRICS } from "./text";

/** 서버 화면 위쪽의 화면 전환 목록. 화면을 늘릴 때는 여기에 한 줄을 더하고 ArgocdTab에서 그리는 곳을 정한다. id는 설정에 남는다. */
export const ARGO_VIEWS = [
  { id: "apps", label: ARGO_VIEW_APPS },
  { id: "resources", label: ARGO_VIEW_RESOURCES },
  { id: "metrics", label: ARGO_VIEW_METRICS },
] as const;

export type ArgoViewId = (typeof ARGO_VIEWS)[number]["id"];

/** 설정에 남은 글을 화면 id로. 모르는 글이면 첫 화면 */
export const parseArgoView = (id: string | null | undefined): ArgoViewId => ARGO_VIEWS.find((v) => v.id === id)?.id ?? ARGO_VIEWS[0].id;

export function ArgoViewSwitcher({ view, onChange }: { view: ArgoViewId; onChange: (view: ArgoViewId) => void }) {
  return (
    <div role="tablist" className="k8s-tabs" aria-label={ARGO_VIEWS_LABEL}>
      {ARGO_VIEWS.map((v) => (
        <button key={v.id} role="tab" aria-selected={view === v.id} onClick={() => onChange(v.id)}>
          {v.label}
        </button>
      ))}
    </div>
  );
}
