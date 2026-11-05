import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage } from "../api/errors";
import { tailscaleApi } from "./api";
import * as t from "./text";

export function TailscaleDiagnosis({ url }: { url: string }) {
  const diagnosis = useQuery({
    queryKey: ["tailscale", "diagnose", url],
    queryFn: () => tailscaleApi.diagnose(url),
    gcTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [confirm, setConfirm] = useState<boolean | null>(null);
  const [applied, setApplied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  const apply = async (enabled: boolean) => {
    setBusy(true);
    setApplyError(null);
    try {
      await tailscaleApi.acceptRoutes(enabled);
      setApplied(enabled);
      setConfirm(null);
      await diagnosis.refetch();
    } catch (error) {
      setApplyError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const data = diagnosis.data;
  return (
    <section className="tailscale-diagnosis" aria-label={t.DIAGNOSE}>
      {diagnosis.isFetching && <p role="status">{t.RUNNING}</p>}
      {diagnosis.isError && <p className="err" role="alert">{errorMessage(diagnosis.error)}</p>}
      {data && (
        <>
          <p className="tailscale-verdict">{data.verdict}</p>
          <p className="tailscale-target">
            {data.tailnet && <span>{t.TAILNET}: {data.tailnet} · </span>}
            {data.host}:{data.port} → {data.address ?? t.ADDRESS_UNKNOWN}
          </p>
          <ul className="tailscale-checks">
            {data.checks.map((check) => (
              <li key={check.id} className={`tailscale-check tailscale-check-${check.status}`}>
                <span className="tailscale-mark" aria-label={t.STATUS[check.status].label}>{t.STATUS[check.status].mark}</span>
                <div><span>{check.summary}</span>{check.detail && <p>{check.detail}</p>}</div>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="tailscale-actions">
        <button className="btn small tone-secondary" disabled={diagnosis.isFetching || busy} onClick={() => void diagnosis.refetch()}>{t.REDIAGNOSE}</button>
        {confirm === null && (applied || data?.fix === "acceptRoutes") && (
          <button className="btn small tone-warn" disabled={busy || diagnosis.isFetching} onClick={() => { setApplyError(null); setConfirm(!applied); }}>
            {applied ? t.UNDO : t.ENABLE_ROUTES}
          </button>
        )}
      </div>
      {confirm !== null && (
        <div className="tailscale-confirm">
          <code className="raw">tailscale set --accept-routes={String(confirm)}</code>
          <p>{confirm ? t.EFFECT_ENABLE : t.EFFECT_DISABLE}</p>
          <div className="tailscale-actions">
            <button className="btn small tone-warn" disabled={busy} onClick={() => void apply(confirm)}>{t.APPLY}</button>
            <button className="btn small tone-secondary" disabled={busy} onClick={() => { setConfirm(null); setApplyError(null); }}>{t.CANCEL}</button>
          </div>
        </div>
      )}
      {applyError && <p className="err" role="alert">{applyError}</p>}
    </section>
  );
}
