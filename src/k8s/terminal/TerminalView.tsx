import type { K8sTarget } from "../types";
import { LocalTerminal } from "./LocalTerminal";
import {
  TERMINAL_COMMAND_LABEL, TERMINAL_EMPTY, TERMINAL_NEW, TERMINAL_PINNED, TERMINAL_PINNED_NOTE, TERMINAL_TABS_LABEL, TERMINAL_VIEW_LABEL, terminalClose,
} from "./text";
import type { TerminalTab } from "./useTerminals";

interface Props {
  target: K8sTarget;
  /** 이 탭이 연결한 context. 모든 터미널이 이 context 하나에 고정된다 */
  context: string;
  ssoProfile: string;
  /** 이 화면(왼쪽 메뉴 "터미널")이 보이는지. 숨겨도 열린 터미널은 유지된다 */
  visible: boolean;
  tabs: TerminalTab[];
  active: number | null;
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
  onNew: () => void;
}

/** 이 탭의 클러스터에 고정된 터미널들. 머리줄에 고정한 context가 보이고, 터미널은 안쪽 탭으로 여러 개 연다. */
export function TerminalView({ target, context, ssoProfile, visible, tabs, active, onSelect, onClose, onNew }: Props) {
  const current = tabs.find((tab) => tab.id === active);
  return (
    <div className="k8s-term-view" aria-label={TERMINAL_VIEW_LABEL} hidden={!visible}>
      <div className="k8s-term-head">
        <span className="dim">{TERMINAL_PINNED}</span>
        <b className="mono" aria-label={TERMINAL_PINNED}>{context}</b>
        <span className="dim k8s-term-note-text">{TERMINAL_PINNED_NOTE}</span>
      </div>
      <div className="k8s-term-bar">
        <div role="tablist" className="k8s-tabs k8s-term-tabs" aria-label={TERMINAL_TABS_LABEL}>
          {tabs.map((tab) => (
            <span key={tab.id} className="k8s-term-tab">
              <button role="tab" aria-selected={tab.id === active} title={tab.command ?? undefined} onClick={() => onSelect(tab.id)}>
                {tab.title}
              </button>
              <button className="icon" aria-label={terminalClose(tab.title)} title={terminalClose(tab.title)} onClick={() => onClose(tab.id)}>
                ✕
              </button>
            </span>
          ))}
        </div>
        <button className="btn small tone-secondary" onClick={onNew}>{TERMINAL_NEW}</button>
      </div>
      {current?.command != null && (
        <p className="dim mono k8s-term-command" aria-label={TERMINAL_COMMAND_LABEL}>{current.command}</p>
      )}
      <div className="k8s-term-panes">
        {/* 터미널은 다른 탭이나 화면을 보는 동안에도 유지한다: 숨기기만 한다 */}
        {tabs.map((tab) => (
          <div key={tab.id} className="k8s-shell-host" hidden={tab.id !== active}>
            <LocalTerminal target={target} ssoProfile={ssoProfile} command={tab.command} title={tab.title} visible={visible && tab.id === active} onClose={() => onClose(tab.id)} />
          </div>
        ))}
        {tabs.length === 0 && (
          <div className="empty">
            <p>{TERMINAL_EMPTY}</p>
            <button className="btn tone-primary" onClick={onNew}>{TERMINAL_NEW}</button>
          </div>
        )}
      </div>
    </div>
  );
}
