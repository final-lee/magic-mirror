import { ErrorState } from "../../components/ErrorState";
import { groupGaps } from "./logic";
import { AWS_SECTIONS } from "./queries";
import { GAPS_LABEL, PARTIAL_LINE, SECTION_LABELS, gapLine, skippedLine } from "./text";
import type { SecurityGap } from "./types";

interface Props {
  gaps: SecurityGap[];
  /** 읽지 못해 점검하지 못한 항목의 이름(켜져 있는 것만) */
  skipped: string[];
  /** AWS 부분의 SSO 로그인에 쓸 프로필(앱의 프로필) */
  awsProfile: string;
  /** 쿠버네티스 부분의 SSO 로그인에 쓸 프로필(kubeconfig의 exec 프로필) */
  k8sProfile: string;
  onRetry: () => void;
}

/** 읽지 못한 부분과 그 이유, 점검하지 못한 항목. 같은 이유는 한 줄로 묶는다. 전체가 실패하지 않으니 나머지 결과는 그대로 보인다. */
export function Gaps({ gaps, skipped, awsProfile, k8sProfile, onRetry }: Props) {
  const { errors, partial } = groupGaps(gaps);
  if (errors.length === 0 && partial.length === 0 && skipped.length === 0) return null;
  return (
    <div className="sec-gaps" role="group" aria-label={GAPS_LABEL}>
      {errors.map((g) => (
        <div key={JSON.stringify(g.error)} className="k8s-gap">
          <p className="dim">{gapLine(g.sections.map((s) => SECTION_LABELS[s]))}</p>
          <ErrorState error={g.error} profile={g.sections.every((s) => AWS_SECTIONS.has(s)) ? awsProfile : k8sProfile} compact onRetry={onRetry} onLoggedIn={onRetry} />
        </div>
      ))}
      {partial.length > 0 && <p className="dim">{PARTIAL_LINE(partial.map((s) => SECTION_LABELS[s]))}</p>}
      {skipped.length > 0 && <p className="dim">{skippedLine(skipped)}</p>}
    </div>
  );
}
