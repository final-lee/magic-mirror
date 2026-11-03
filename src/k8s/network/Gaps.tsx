import { ErrorState } from "../../components/ErrorState";
import { groupGaps } from "./logic";
import { AWS_SECTIONS } from "./queries";
import { GAPS_LABEL, gapLine } from "./text";
import type { NetworkGap } from "./types";

interface Props {
  gaps: NetworkGap[];
  /** AWS 부분의 SSO 로그인에 쓸 프로필(앱의 프로필) */
  awsProfile: string;
  /** 쿠버네티스 부분의 SSO 로그인에 쓸 프로필(kubeconfig의 exec 프로필) */
  k8sProfile: string;
  onRetry: () => void;
}

/** 읽지 못한 부분과 그 이유. 같은 이유는 한 줄로 묶는다. 전체가 실패하지 않으니 나머지 화면은 그대로 보인다. */
export function Gaps({ gaps, awsProfile, k8sProfile, onRetry }: Props) {
  const groups = groupGaps(gaps);
  if (groups.length === 0) return null;
  return (
    <div className="net-gaps" role="group" aria-label={GAPS_LABEL}>
      {groups.map((g) => (
        <div key={JSON.stringify(g.error)} className="k8s-gap">
          <p className="dim">{gapLine(g.labels)}</p>
          <ErrorState error={g.error} profile={g.sections.every((s) => AWS_SECTIONS.has(s)) ? awsProfile : k8sProfile} compact onRetry={onRetry} onLoggedIn={onRetry} />
        </div>
      ))}
    </div>
  );
}
