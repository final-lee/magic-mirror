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
 * - 줄이 없을 때도 role="status" 컨테이너는 늘 떠 있다. 이미 있는 live region에 줄이 들어와야 화면 낭독기가 읽는다.
 * - 알림은 이 polite 컨테이너 하나가 맡는다. 줄 안에 alert를 또 두면 같은 글을 두 번 읽는다.
 *   status는 aria-atomic이 true라서 그대로 두면 줄이 들어올 때마다 컨테이너 전체를 다시 읽으므로, false로 두어 들어온 줄만 읽게 한다.
 * - 줄의 key에 상태를 넣는다. 진행 줄이 실패 줄로 바뀌면 새 노드가 들어가서 읽히고, [취소]에 포커스가 있던 사용자의 노드가
 *   그대로 [다시 로그인]이 되어 Enter 한 번에 새 로그인이 열리는 일이 없다.
 */
export function SsoBanner({ entries, onCancel, onRetry, onDismiss }: Props) {
  const shown = entries.filter((e) => e.status.kind !== "cancelled");
  return (
    <div className="sso-banners" role="status" aria-atomic="false">
      {shown.map((e) => (
        <SsoLine key={`${e.key}:${e.status.kind}`} entry={e} onCancel={onCancel} onRetry={onRetry} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function SsoLine({ entry: e, onCancel, onRetry, onDismiss }: Omit<Props, "entries"> & { entry: SsoEntry }) {
  // 같은 이름의 버튼이 줄마다 생기므로, 버튼이 자기 줄의 글을 가리키게 해서 구분한다
  const textId = useId();
  if (e.status.kind === "failed") {
    // 로그인에 성공한 직후의 실패는 로그인이 실패한 것이 아니다. 프로필 설정을 보라는 문구를 그대로 보여준다.
    const text = e.status.afterSuccess ? `${e.profile}: ${e.status.message}` : `${e.profile}: SSO 로그인에 실패했어요: ${e.status.message}`;
    return (
      <div className="update-banner">
        <span id={textId}>{text}</span>
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
