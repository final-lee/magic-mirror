import { Fragment, useState } from "react";
import { desktop } from "../api/desktop";
import { errorMessage } from "../api/errors";
import { argowfApi } from "./api";
import { useTokenGate } from "./catalogHooks";
import { useUserInfo } from "./catalogQueries";
import type { ArgoWfConn, ArgoWfSession, ArgoWfUserInfo } from "./types";

/** userinfo 칸의 보이는 이름 */
const LABELS: [keyof ArgoWfUserInfo, string][] = [
  ["subject", "주체(subject)"],
  ["email", "이메일"],
  ["emailVerified", "이메일 확인"],
  ["groups", "그룹"],
  ["issuer", "발급자(issuer)"],
  ["serviceAccountName", "ServiceAccount"],
  ["serviceAccountNamespace", "SA 네임스페이스"],
];

const AUTH_TEXT = { context: "kubeconfig context", token: "API 토큰" } as const;

/** 지금 신원(`/api/v1/userinfo`)과 CLI에 쓸 토큰 복사. 토큰은 클립보드에만 넣고 화면에 두지 않는다 */
export function UserInfoView({ conn, session, onTokenError }: { conn: ArgoWfConn; session: ArgoWfSession; onTokenError(m: string): void }) {
  const q = useUserInfo(conn);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  useTokenGate([q.error], onTokenError);
  const copy = async () => {
    try {
      await desktop.copy(await argowfApi.copyToken(conn));
      setNote({ ok: true, text: "토큰을 클립보드에 복사했어요" });
    } catch (e) {
      setNote({ ok: false, text: errorMessage(e) });
    }
  };
  const info = q.data;
  const shown = (value: ArgoWfUserInfo[keyof ArgoWfUserInfo]) =>
    Array.isArray(value)
      ? value.join(", ") || "—"
      : value === null || value === undefined
        ? "—"
        : typeof value === "boolean"
          ? value
            ? "예"
            : "아니요"
          : value;
  return (
    <div className="awc">
      <div className="awc-bar">
        <h2 className="awc-title">User Info</h2>
        <span className="dim">Argo Server가 보는 지금 신원</span>
      </div>
      <div className="awc-body">
        <dl className="kv awc-userinfo">
          <dt>연결</dt>
          <dd>
            {session.identity} · {AUTH_TEXT[session.auth]} · Argo {session.version}
          </dd>
          {info &&
            LABELS.map(([key, label]) => (
              <Fragment key={key}>
                <dt>{label}</dt>
                <dd className="mono">{shown(info[key])}</dd>
              </Fragment>
            ))}
        </dl>
        {q.error && (
          <p className="err" role="alert">
            {errorMessage(q.error)}
          </p>
        )}
        <div className="awc-userinfo-acts">
          <button className="btn small" onClick={() => void copy()}>
            토큰 복사
          </button>
          {note && (
            <span className={note.ok ? "dim" : "err"} role={note.ok ? "status" : "alert"}>
              {note.text}
            </span>
          )}
        </div>
        <p className="dim">
          CLI에서: <code className="mono">argo --server {conn.url} --token &lt;복사한 토큰&gt;</code>
        </p>
      </div>
    </div>
  );
}
