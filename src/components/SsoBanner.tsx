import type { SsoEntry } from "../lib/useSsoLogin";

interface Props {
  entries: SsoEntry[];
  onCancel: (key: string) => void;
  onRetry: (profile: string) => void;
  onDismiss: (key: string) => void;
}

/** 진행 중이거나 실패한 SSO 로그인을 한 줄씩 보여준다. 취소한 로그인은 보여주지 않는다. */
export function SsoBanner({ entries, onCancel, onRetry, onDismiss }: Props) {
  const shown = entries.filter((e) => e.status.kind !== "cancelled");
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map((e) => (
        <div key={e.key} className="update-banner" role="status">
          {e.status.kind === "failed" ? (
            <>
              <span>{`${e.profile}: SSO 로그인에 실패했어요: ${e.status.message}`}</span>
              <button className="btn small primary" onClick={() => onRetry(e.profile)}>
                다시 로그인
              </button>
              <button className="btn small" onClick={() => onDismiss(e.key)}>
                닫기
              </button>
            </>
          ) : (
            <>
              <span>{`${e.profile}: SSO 로그인 중이에요. 브라우저에서 승인해 주세요`}</span>
              <button className="btn small" onClick={() => onCancel(e.key)}>
                취소
              </button>
            </>
          )}
        </div>
      ))}
    </>
  );
}
