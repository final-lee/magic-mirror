import { useState } from "react";
import { errorMessage } from "../api/errors";
import { DEFAULT_RESOURCE_TTL_MINUTES } from "../api/queries";
import type { Updater } from "../lib/useUpdater";
import type { ServiceInfo } from "../api/types";
import type { DiffTool } from "../explorer/types";
import { SETTINGS_KUBECONFIG_LABEL, SETTINGS_KUBECONFIG_PLACEHOLDER } from "../k8s/text";
import { ServiceBadge } from "./ServiceBadge";

interface Props {
  services: ServiceInfo[];
  enabled: string[];
  onChange: (ids: string[]) => void;
  onClose: () => void;
  diffTool?: DiffTool;
  diffToolCommand?: string | null;
  onDiffToolChange?: (tool: DiffTool, command: string | null) => void;
  kubeconfigPath?: string | null;
  onKubeconfigPathChange?: (path: string | null) => void;
  updater?: Updater;
  appVersion?: string | null;
  /** 리소스 목록 캐시 TTL(분). 비어 있으면 기본값, 0이면 무제한 */
  cacheTtlMinutes?: number | null;
  onCacheTtlChange?: (minutes: number) => void;
  /** 하드 리셋: 모든 리소스 목록 캐시(메모리·디스크)를 비우고 보이는 목록을 다시 읽는다 */
  onClearCache?: () => Promise<void>;
}

const TTL_OPTIONS: { minutes: number; label: string }[] = [
  { minutes: 5, label: "5분" },
  { minutes: 15, label: "15분" },
  { minutes: 60, label: "1시간" },
  { minutes: 360, label: "6시간" },
  { minutes: 0, label: "무제한" },
];

const TOOLS: { id: DiffTool; label: string }[] = [
  { id: "filemerge", label: "FileMerge" },
  { id: "vscode", label: "VS Code" },
  { id: "custom", label: "직접 입력" },
];

function updateStatus(u: Updater): string {
  switch (u.state.kind) {
    case "checking":
      return "확인하는 중…";
    case "upToDate":
      return "최신 버전이에요.";
    case "available":
      return `새 버전 ${u.state.version}이 있어요.`;
    case "downloading":
      return `새 버전 ${u.state.version} 내려받는 중…`;
    case "error":
      return `확인하지 못했어요: ${u.state.message}`;
    default:
      return "";
  }
}

export function ServiceSettings({
  services,
  enabled,
  onChange,
  onClose,
  diffTool,
  diffToolCommand,
  onDiffToolChange,
  kubeconfigPath,
  onKubeconfigPathChange,
  updater,
  appVersion,
  cacheTtlMinutes,
  onCacheTtlChange,
  onClearCache,
}: Props) {
  const [kubeconfigDraft, setKubeconfigDraft] = useState(kubeconfigPath ?? "");
  const [clearState, setClearState] = useState<{ kind: "idle" | "busy" | "done" } | { kind: "error"; message: string }>({ kind: "idle" });
  const clearCache = async () => {
    if (!onClearCache) return;
    setClearState({ kind: "busy" });
    try {
      await onClearCache();
      setClearState({ kind: "done" });
    } catch (e) {
      setClearState({ kind: "error", message: errorMessage(e) });
    }
  };
  const toggle = (id: string, on: boolean) => onChange(on ? [...enabled, id] : enabled.filter((x) => x !== id));
  return (
    <div
      className="modal"
      data-testid="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet" role="dialog" aria-label="표시할 서비스">
        <h3>표시할 서비스</h3>
        <p>체크한 서비스만 사이드바에 나오고 조회해요.</p>
        <div className="grid">
          {services.map((s) => (
            <label key={s.id}>
              <input type="checkbox" checked={enabled.includes(s.id)} onChange={(e) => toggle(s.id, e.target.checked)} />
              <ServiceBadge service={s} /> {s.name}
            </label>
          ))}
        </div>
        {onDiffToolChange && (
          <>
            <h4>비교 도구</h4>
            <p>S3 탐색기 비교 탭의 "외부 도구로 열기"에 써요.</p>
            <div className="tools">
              {TOOLS.map((t) => (
                <label key={t.id}>
                  <input
                    type="radio"
                    name="diff-tool"
                    checked={(diffTool ?? "filemerge") === t.id}
                    onChange={() => onDiffToolChange(t.id, t.id === "custom" ? (diffToolCommand ?? null) : null)}
                  />
                  {t.label}
                </label>
              ))}
            </div>
            {diffTool === "custom" && (
              <input
                className="field-input mono"
                aria-label="비교 명령"
                placeholder="ksdiff {left} {right}"
                value={diffToolCommand ?? ""}
                onChange={(e) => onDiffToolChange("custom", e.target.value)}
              />
            )}
          </>
        )}
        {onKubeconfigPathChange && (
          <>
            <h4>{SETTINGS_KUBECONFIG_LABEL}</h4>
            <input
              className="field-input mono"
              aria-label={SETTINGS_KUBECONFIG_LABEL}
              placeholder={SETTINGS_KUBECONFIG_PLACEHOLDER}
              value={kubeconfigDraft}
              onChange={(e) => setKubeconfigDraft(e.target.value)}
              onBlur={() => {
                const next = kubeconfigDraft.trim() || null;
                if (next !== (kubeconfigPath ?? null)) onKubeconfigPathChange(next);
              }}
            />
          </>
        )}
        {onCacheTtlChange && (
          <>
            <h4>리소스 캐시</h4>
            <p>한 번 읽은 목록은 앱이 켜져 있는 동안 남겨 두고 ⌘K로 찾아요. 이 시간이 지난 목록은 다시 열 때 뒤에서 다시 읽어요. 검색용 사본(이름·ID·열 값·태그)은 디스크에 7일 남아요.</p>
            <label className="sel cache-ttl">
              <small>다시 읽는 주기</small>
              <select aria-label="리소스 캐시 TTL" value={cacheTtlMinutes ?? DEFAULT_RESOURCE_TTL_MINUTES} onChange={(e) => onCacheTtlChange(Number(e.target.value))}>
                {TTL_OPTIONS.map((o) => (
                  <option key={o.minutes} value={o.minutes}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            {onClearCache && (
              <div className="tools cache-reset">
                <button className="btn small" disabled={clearState.kind === "busy"} onClick={() => void clearCache()} title="⌘⇧R">
                  캐시 비우기
                </button>
                <span className={clearState.kind === "error" ? "err" : "dim"} role="status">
                  {clearState.kind === "done" ? "비웠어요. 보이는 목록을 다시 읽어요" : clearState.kind === "error" ? clearState.message : "모든 프로필·리전의 목록과 디스크 사본을 지워요(⌘⇧R)"}
                </span>
              </div>
            )}
          </>
        )}
        {updater && (
          <>
            <h4>업데이트</h4>
            <p>
              현재 버전 {appVersion ?? "—"} {updateStatus(updater) && `· ${updateStatus(updater)}`}
            </p>
            <div className="tools">
              <button className="btn small" disabled={updater.state.kind === "checking" || updater.state.kind === "downloading"} onClick={() => void updater.checkNow()}>
                업데이트 확인
              </button>
              {updater.state.kind === "available" && (
                <button className="btn small primary" onClick={() => void updater.install()}>
                  지금 업데이트
                </button>
              )}
            </div>
          </>
        )}
        <div className="foot">
          <button className="btn primary" onClick={onClose}>
            완료
          </button>
        </div>
      </div>
    </div>
  );
}
