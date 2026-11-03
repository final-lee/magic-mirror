import { useState } from "react";
import type { Updater } from "../lib/useUpdater";
import type { ServiceInfo } from "../api/types";
import type { DiffTool } from "../explorer/types";
import { SETTINGS_KUBECONFIG_LABEL, SETTINGS_KUBECONFIG_PLACEHOLDER } from "../k8s/text";
import type { Theme } from "../lib/theme";
import { ServiceBadge } from "./ServiceBadge";

const THEME_LABEL = "화면 테마";
const THEME_CHOICES: { id: Theme; label: string }[] = [
  { id: "system", label: "시스템 설정 따르기" },
  { id: "light", label: "밝게" },
  { id: "dark", label: "어둡게" },
];

interface Props {
  services: ServiceInfo[];
  enabled: string[];
  onChange: (ids: string[]) => void;
  onClose: () => void;
  theme?: Theme;
  onThemeChange?: (theme: Theme) => void;
  diffTool?: DiffTool;
  diffToolCommand?: string | null;
  onDiffToolChange?: (tool: DiffTool, command: string | null) => void;
  kubeconfigPath?: string | null;
  onKubeconfigPathChange?: (path: string | null) => void;
  updater?: Updater;
  appVersion?: string | null;
}

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
  theme,
  onThemeChange,
  diffTool,
  diffToolCommand,
  onDiffToolChange,
  kubeconfigPath,
  onKubeconfigPathChange,
  updater,
  appVersion,
}: Props) {
  const [kubeconfigDraft, setKubeconfigDraft] = useState(kubeconfigPath ?? "");
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
        {onThemeChange && (
          <>
            <h4>{THEME_LABEL}</h4>
            <div className="tools" role="group" aria-label={THEME_LABEL}>
              {THEME_CHOICES.map((choice) => (
                <label key={choice.id}>
                  <input type="radio" name="theme" checked={(theme ?? "system") === choice.id} onChange={() => onThemeChange(choice.id)} />
                  {choice.label}
                </label>
              ))}
            </div>
          </>
        )}
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
