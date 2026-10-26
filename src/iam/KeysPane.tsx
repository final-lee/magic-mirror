import { ErrorState } from "../components/ErrorState";
import { formatDay } from "./format";
import { useAccessKeys } from "./queries";
import type { AccessKeyInfo, IamChange } from "./types";

interface Props {
  profile: string;
  userName: string;
  /** 비활성화·활성화·삭제를 누르면 그 변경을 넘긴다(미리보기와 확인은 변경 흐름이 맡는다) */
  onFix: (change: IamChange) => void;
}

/** 마지막 사용 칸. 읽지 못한 경우(권한 없음 등)는 "사용 기록 없음"과 구분해서 보여준다. */
function lastUse(k: AccessKeyInfo) {
  if (k.lastUsedAt) return formatDay(k.lastUsedAt);
  return <span className="dim">{k.lastUsedUnknown ? "마지막 사용 확인 못 함 (권한 없음)" : "사용 기록 없음"}</span>;
}

function KeyRow({ k, userName, onFix }: { k: AccessKeyInfo; userName: string; onFix: Props["onFix"] }) {
  const where = [k.lastUsedService, k.lastUsedRegion].filter(Boolean).join(" · ");
  const active = k.status === "Active";
  return (
    <tr>
      <td className="mono">{k.id}</td>
      <td>
        <span className={`dot ${active ? "green" : ""}`} />
        {k.status}
      </td>
      <td>{formatDay(k.createdAt) || "—"}</td>
      <td>{k.ageDays === null ? "—" : `${k.ageDays}일`}</td>
      <td>{lastUse(k)}</td>
      <td>{where || <span className="dim">—</span>}</td>
      <td className="key-act">
        <button
          className="btn small"
          aria-label={`${k.id} ${active ? "비활성화" : "활성화"}`}
          onClick={() => onFix({ op: "setAccessKeyStatus", userName, accessKeyId: k.id, status: active ? "Inactive" : "Active" })}
        >
          {active ? "비활성화" : "활성화"}
        </button>
        <button className="btn small danger" aria-label={`${k.id} 삭제`} onClick={() => onFix({ op: "deleteAccessKey", userName, accessKeyId: k.id })}>
          삭제
        </button>
      </td>
    </tr>
  );
}

/** 액세스 키 탭(사용자): 상태·나이·마지막 사용과 [비활성화]/[활성화] [삭제]. 비밀 키는 다루지 않는다. */
export function KeysPane({ profile, userName, onFix }: Props) {
  const q = useAccessKeys(profile, userName);
  if (q.isError) return <ErrorState compact error={q.error} profile={profile} onRetry={() => void q.refetch()} />;
  if (!q.data) return <div className="empty small">불러오는 중…</div>;
  if (q.data.length === 0) return <div className="empty small">액세스 키가 없어요</div>;
  return (
    <table aria-label="액세스 키">
      <thead>
        <tr>
          <th className="nosort">키 ID</th>
          <th className="nosort">상태</th>
          <th className="nosort">만든 날</th>
          <th className="nosort">나이</th>
          <th className="nosort">마지막 사용</th>
          <th className="nosort">서비스 · 리전</th>
          <th className="nosort">조치</th>
        </tr>
      </thead>
      <tbody>
        {q.data.map((k) => (
          <KeyRow key={k.id} k={k} userName={userName} onFix={onFix} />
        ))}
      </tbody>
    </table>
  );
}
