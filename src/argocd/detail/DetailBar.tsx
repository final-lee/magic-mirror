import { useState } from "react";
import { desktop } from "../../api/desktop";
import type { SyncWindows } from "../types";
import { argoWebUrl } from "./helpers";
import { LinkButtons } from "./LinkButtons";
import { useAppLinks, useSyncWindows } from "./queries";
import {
  APP_LINKS_LABEL, ARGO_OPEN_UI, ARGO_OPEN_UI_TITLE, SW_ACTIVE, SW_ALLOWED, SW_ALLOWED_TITLE, SW_BLOCKED, SW_BLOCKED_TITLE, SW_MANUAL_OK, SW_PANEL_LABEL, swKind, swSchedule,
} from "./text";
import { useTokenGuard } from "./useTokenGuard";

/** sync window가 걸려 있을 때만 보이는 알약: 지금 동기화가 막혔는지 알리고, 누르면 window 목록과 설명을 펼친다. */
export function SyncWindowBadge({ windows }: { windows: SyncWindows }) {
  const [open, setOpen] = useState(false);
  if (windows.assigned.length === 0) return null;
  const blocked = !windows.canSync;
  const isActive = (w: SyncWindows["assigned"][number]) => windows.active.some((a) => a.kind === w.kind && a.schedule === w.schedule && a.duration === w.duration);
  return (
    <>
      <button className={`argo-badge ${blocked ? "argo-bad" : "argo-warn"} argo-sw`} aria-expanded={open} title={blocked ? SW_BLOCKED_TITLE : SW_ALLOWED_TITLE} onClick={() => setOpen((o) => !o)}>
        {blocked ? SW_BLOCKED : SW_ALLOWED}
      </button>
      {open && (
        <ul className="argo-sw-list" aria-label={SW_PANEL_LABEL}>
          {windows.assigned.map((w, i) => (
            <li key={i}>
              <b>{swKind(w.kind)}</b> <span className="mono">{swSchedule(w.schedule, w.duration)}</span>
              {isActive(w) && <span className="k8s-chip argo-chip-warn">{SW_ACTIVE}</span>}
              {w.manualSync && <span className="dim"> · {SW_MANUAL_OK}</span>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

interface Props {
  url: string;
  namespace: string;
  name: string;
  version: string | null;
  live: boolean;
  onTokenError: (message: string) => void;
}

/** 상세 머리 아래 줄: ArgoCD 웹 UI로 열기, 서버가 설정한 deep link, sync window 알림 */
export function DetailBar({ url, namespace, name, version, live, onTokenError }: Props) {
  const links = useAppLinks(url, namespace, name);
  const windows = useSyncWindows(url, namespace, name, version, live);
  useTokenGuard([links.error, windows.error], onTokenError);
  return (
    <div className="argo-bar-links">
      <button className="btn small tone-secondary" title={ARGO_OPEN_UI_TITLE} onClick={() => void desktop.openUrl(argoWebUrl(url, namespace, name))}>
        {ARGO_OPEN_UI}
      </button>
      {links.data && <LinkButtons links={links.data} label={APP_LINKS_LABEL} />}
      {windows.data && <SyncWindowBadge windows={windows.data} />}
    </div>
  );
}
