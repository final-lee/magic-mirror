import * as t from "./text";
import type { HelmChartSource } from "./types";

export type SourceKind = "path" | "repo" | "oci";

/** 차트 위치 입력 칸들의 값. 종류마다 쓰는 칸이 다르다 */
export interface SourceForm {
  kind: SourceKind;
  path: string;
  repoUrl: string;
  chartName: string;
  oci: string;
  version: string;
}

export const EMPTY_SOURCE: SourceForm = { kind: "path", path: "", repoUrl: "", chartName: "", oci: "", version: "" };

/** 입력을 차트 위치로. 필요한 칸이 비어 있으면 null */
export function toSource(form: SourceForm): HelmChartSource | null {
  const version = form.version.trim() || null;
  if (form.kind === "path") {
    const path = form.path.trim();
    return path ? { reference: path, repo: null, version: null } : null;
  }
  if (form.kind === "repo") {
    const repo = form.repoUrl.trim();
    const chart = form.chartName.trim();
    return repo && chart ? { reference: chart, repo, version } : null;
  }
  const oci = form.oci.trim();
  return oci ? { reference: oci, repo: null, version } : null;
}

const KINDS: { kind: SourceKind; label: string }[] = [
  { kind: "path", label: t.SRC_PATH },
  { kind: "repo", label: t.SRC_REPO },
  { kind: "oci", label: t.SRC_OCI },
];

interface Props {
  form: SourceForm;
  onChange: (form: SourceForm) => void;
}

/** 차트 위치: 로컬 경로, 저장소 주소 + 차트 이름 + 버전, OCI 주소 + 버전 */
export function ChartSourceFields({ form, onChange }: Props) {
  const set = (patch: Partial<SourceForm>) => onChange({ ...form, ...patch });
  return (
    <div className="helm-source">
      <div role="radiogroup" aria-label={t.SRC_KIND_LABEL} className="helm-seg">
        {KINDS.map(({ kind, label }) => (
          <label key={kind} className={form.kind === kind ? "on" : undefined}>
            <input type="radio" name="helm-source-kind" checked={form.kind === kind} onChange={() => set({ kind })} />
            {label}
          </label>
        ))}
      </div>
      {form.kind === "path" && (
        <label className="helm-field">
          <span>{t.SRC_PATH_LABEL}</span>
          <input value={form.path} placeholder={t.SRC_PATH_HINT} spellCheck={false} onChange={(e) => set({ path: e.target.value })} />
        </label>
      )}
      {form.kind === "repo" && (
        <>
          <label className="helm-field">
            <span>{t.SRC_REPO_URL}</span>
            <input value={form.repoUrl} placeholder={t.SRC_REPO_URL_HINT} spellCheck={false} onChange={(e) => set({ repoUrl: e.target.value })} />
          </label>
          <label className="helm-field">
            <span>{t.SRC_CHART_NAME}</span>
            <input value={form.chartName} placeholder={t.SRC_CHART_NAME_HINT} spellCheck={false} onChange={(e) => set({ chartName: e.target.value })} />
          </label>
        </>
      )}
      {form.kind === "oci" && (
        <label className="helm-field">
          <span>{t.SRC_OCI_REF}</span>
          <input value={form.oci} placeholder={t.SRC_OCI_HINT} spellCheck={false} onChange={(e) => set({ oci: e.target.value })} />
        </label>
      )}
      {form.kind !== "path" && (
        <label className="helm-field">
          <span>{t.SRC_VERSION}</span>
          <input value={form.version} spellCheck={false} onChange={(e) => set({ version: e.target.value })} />
        </label>
      )}
    </div>
  );
}
