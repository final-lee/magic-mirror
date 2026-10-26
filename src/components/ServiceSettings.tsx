import type { Updater } from "../lib/useUpdater";
import type { ServiceInfo } from "../api/types";
import type { DiffTool } from "../explorer/types";
import { ServiceBadge } from "./ServiceBadge";

interface Props {
  services: ServiceInfo[];
  enabled: string[];
  onChange: (ids: string[]) => void;
  onClose: () => void;
  diffTool?: DiffTool;
  diffToolCommand?: string | null;
  onDiffToolChange?: (tool: DiffTool, command: string | null) => void;
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
  diffTool,
  diffToolCommand,
  onDiffToolChange,
  updater,
  appVersion,
}: Props) {
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
