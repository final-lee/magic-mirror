import { desktop } from "../../api/desktop";
import { age } from "../../k8s/format";
import { shortRev } from "../argoParts";
import type { RevisionInfo } from "../types";
import { commitUrl } from "./helpers";
import { HIST_CHART, HIST_COMMIT } from "./text";

const firstLine = (s: string | null) => s?.split("\n")[0] ?? "";
/** `Name <mail@example.com>`에서 이름만 */
const authorName = (s: string | null) => s?.replace(/\s*<[^>]*>\s*$/, "") ?? "";

/** 리비전 하나: 커밋(작성자·메시지·태그·커밋 링크), Helm 차트(차트 정보), OCI(버전·설명). 메타데이터를 못 받았으면 리비전만 보인다. */
export function RevisionCell({ info, at }: { info: RevisionInfo; at: number }) {
  const url = info.chart ? null : commitUrl(info.repoUrl, info.revision);
  const meta = info.metadata;
  return (
    <div className="argo-rev">
      <div>
        {info.chart && (
          <span className="dim">
            {HIST_CHART} {info.chart}{" "}
          </span>
        )}
        <span className="mono" title={info.revision}>
          {shortRev(info.revision)}
        </span>
        {url && (
          <>
            {" "}
            <button className="link" title={url} onClick={() => void desktop.openUrl(url)}>
              {HIST_COMMIT}
            </button>
          </>
        )}
        {meta?.tags.map((t) => (
          <span key={t} className="k8s-chip">
            {t}
          </span>
        ))}
      </div>
      {meta && (
        <div className="dim k8s-wrap">
          {firstLine(meta.message)}
          {meta.author && <> · {authorName(meta.author)}</>}
          {meta.date && (
            <>
              {" "}
              · <span title={meta.date}>{age(meta.date, at)}</span>
            </>
          )}
        </div>
      )}
      {info.chartDetails?.description && <div className="dim k8s-wrap">{info.chartDetails.description}</div>}
      {info.oci && (
        <div className="dim k8s-wrap">
          {[info.oci.version, info.oci.description, info.oci.authors].filter(Boolean).join(" · ")}
          {info.oci.sourceUrl && (
            <>
              {" "}
              <button className="link" title={info.oci.sourceUrl} onClick={() => void desktop.openUrl(info.oci!.sourceUrl!)}>
                {HIST_COMMIT}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
