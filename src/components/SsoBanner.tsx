import { useId } from "react";
import type { SsoEntry } from "../lib/useSsoLogin";

interface Props {
  entries: SsoEntry[];
  onCancel: (key: string) => void;
  onRetry: (profile: string) => void;
  onDismiss: (key: string) => void;
}

/**
 * 진행 중이거나 실패한 SSO 로그인을 한 줄씩 보여준다. 취소한 로그인은 보여주지 않는다.
 * 줄이 없을 때도 role="status" 컨테이너는 늘 떠 있다. 이미 있는 live region에 줄이 들어와야 화면 낭독기가 읽는다.
 */
export function SsoBanner({ entries, onCancel, onRetry, onDismiss }: Props) {
  const shown = entries.filter((e) => e.status.kind !== "cancelled");
  return (
    <div className="sso-banners" role="status">
      {shown.map((e) => (
        <SsoLine key={e.key} entry={e} onCancel={onCancel} onRetry={onRetry} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function SsoLine({ entry: e, onCancel, onRetry, onDismiss }: Omit<Props, "entries"> & { entry: SsoEntry }) {
  // 같은 이름의 버튼이 줄마다 생기므로, 버튼이 자기 줄의 글을 가리키게 해서 구분한다
  const textId = useId();
  if (e.status.kind === "failed") {
    return (
      <div className="update-banner" role="alert">
        <span id={textId}>{`${e.profile}: SSO 로그인에 실패했어요: ${e.status.message}`}</span>
        <button className="btn small primary" aria-describedby={textId} onClick={() => onRetry(e.profile)}>
          다시 로그인
        </button>
        <button className="btn small" aria-describedby={textId} onClick={() => onDismiss(e.key)}>
          닫기
        </button>
      </div>
    );
  }
  return (
    <div className="update-banner">
      <span id={textId}>{`${e.profile}: SSO 로그인 중이에요. 브라우저에서 승인해 주세요`}</span>
      <button className="btn small" aria-describedby={textId} onClick={() => onCancel(e.key)}>
        취소
      </button>
    </div>
  );
}
