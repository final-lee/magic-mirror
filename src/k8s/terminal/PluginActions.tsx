import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { K8sPlugin } from "../../api/types";
import { errorMessage } from "../../api/errors";
import { useModal } from "../../iam/useModal";
import type { Keybinding } from "../../keymap/keybindings";
import { keyLabel } from "../../keymap/keys";
import { useCommand, useExtraBindings } from "../../keymap/registry";
import type { ObjectRef } from "../types";
import { expandPlugin, pluginCommand, pluginValues, supportsKind } from "./plugins";
import {
  PLUGIN_CANCEL, PLUGIN_COMMAND, PLUGIN_CONTEXT, PLUGIN_INVALID, PLUGIN_MENU, PLUGIN_MENU_LABEL, PLUGIN_NONE, PLUGIN_RUN, PLUGIN_RUNS_IN, pluginConfirmTitle,
} from "./text";

/** 플러그인 키는 입력칸·터미널·대화상자에서 누른 것은 받지 않는다 */
const PLUGIN_WHEN = "!dialogOpen && !inputFocus && !terminalFocus";

interface Pending {
  plugin: K8sPlugin;
  command: string;
}

interface Props {
  /** 설정의 플러그인 전부(키 명령 번호가 이 목록의 순서다) */
  plugins: K8sPlugin[];
  context: string;
  objectRef: ObjectRef;
  /** `$CONTAINER`로 넘길 컨테이너(Pod의 첫 컨테이너, 워크로드는 템플릿의 첫 컨테이너). 없으면 빈 값 */
  container: string | null;
  /** 플러그인 키를 받는 목록·상세 상자. 이 상자가 보일 때만 키가 동작한다 */
  host: RefObject<HTMLElement>;
  /** 확인을 마친 명령을 새 터미널 탭에서 실행한다 */
  onRun: (command: string, title: string) => void;
}

/** 플러그인 키 하나의 처리기. 이 종류에 쓸 수 없는 플러그인은 처리기를 두지 않아 키가 그냥 지나간다. */
function PluginKey({ command, enabled, host, onPress }: { command: string; enabled: boolean; host: RefObject<HTMLElement>; onPress: () => void }) {
  useCommand(command, onPress, { host, enabled });
  return null;
}

/** 실행 전 확인: 확장된 명령을 있는 그대로 보여 준다. 이 명령이 그대로 셸에 간다. */
function Confirm({ pending, context, onRun, onCancel }: { pending: Pending; context: string; onRun: () => void; onCancel: () => void }) {
  const { sheetRef, trapTab } = useModal(onCancel);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);
  const title = pluginConfirmTitle(pending.plugin.name);
  return createPortal(
    <div className="modal">
      <div className="sheet cp" role="dialog" aria-modal="true" aria-label={title} ref={sheetRef} onKeyDown={trapTab}>
        <div className="cp-body">
          <h3>{title}</h3>
          {pending.plugin.description && <p className="dim">{pending.plugin.description}</p>}
          <p>{PLUGIN_RUNS_IN}</p>
          <h4>{PLUGIN_CONTEXT}</h4>
          <code className="mono">{context}</code>
          <h4>{PLUGIN_COMMAND}</h4>
          <pre className="mono k8s-plugin-command" aria-label={PLUGIN_COMMAND}>{pending.command}</pre>
        </div>
        <div className="foot">
          <button ref={cancelRef} className="btn tone-secondary" onClick={onCancel}>{PLUGIN_CANCEL}</button>
          <button className="btn tone-primary" onClick={onRun}>{PLUGIN_RUN}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * 객체 상세 도구 줄의 "플러그인" 메뉴와 플러그인 키. 고르거나 키를 누르면 명령을 확장해 확인 창에 그대로 보이고(확인을 끈 플러그인은 바로),
 * 확인하면 `onRun`이 이 탭의 새 터미널에서 실행한다. 값은 모두 셸 단일 인자로 인용된다(`expandPlugin`).
 */
export function PluginActions({ plugins, context, objectRef, container, host, onRun }: Props) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState("");
  const menu = useRef<HTMLSpanElement>(null);
  const matching = plugins.map((plugin, index) => ({ plugin, index })).filter(({ plugin }) => supportsKind(plugin, objectRef.kind));
  const bindings = useMemo<Keybinding[]>(
    () => plugins.flatMap((plugin, index) => (plugin.key ? [{ key: plugin.key, command: pluginCommand(index), title: plugin.name, when: PLUGIN_WHEN, scope: "k8s" as const, handler: "registry" as const }] : [])),
    [plugins],
  );
  useExtraBindings(bindings);
  useCommand("k8s.pluginMenuClose", () => setOpen(false), { host: menu, enabled: open });

  const request = (plugin: K8sPlugin) => {
    setOpen(false);
    setError("");
    let command: string;
    try {
      command = expandPlugin(plugin.command, pluginValues(context, objectRef, container));
    } catch (e) {
      setError(`${PLUGIN_INVALID}: ${errorMessage(e)}`);
      return;
    }
    if (plugin.confirm === false) onRun(command, plugin.name);
    else setPending({ plugin, command });
  };

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => {
      document.removeEventListener("pointerdown", away, true);
    };
  }, [open]);

  return (
    <>
      {plugins.map((plugin, index) => (plugin.key ? <PluginKey key={index} command={pluginCommand(index)} enabled={supportsKind(plugin, objectRef.kind)} host={host} onPress={() => request(plugin)} /> : null))}
      <span className="k8s-plugin-menu" ref={menu}>
        <button
          className="btn small tone-secondary"
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={matching.length === 0}
          title={matching.length === 0 ? PLUGIN_NONE : undefined}
          aria-description={matching.length === 0 ? PLUGIN_NONE : undefined}
          onClick={() => setOpen(!open)}
        >
          {PLUGIN_MENU} ▾
        </button>
        {open && (
          <div className="k8s-plugin-pop" role="menu" aria-label={PLUGIN_MENU_LABEL}>
            {matching.map(({ plugin }) => (
              <button key={plugin.name} role="menuitem" className="k8s-plugin-item" title={plugin.description ?? undefined} onClick={() => request(plugin)}>
                <span>{plugin.name}</span>
                {plugin.key && <kbd>{keyLabel(plugin.key)}</kbd>}
              </button>
            ))}
          </div>
        )}
      </span>
      {error && <span className="err" role="alert">{error}</span>}
      {pending && (
        <Confirm
          pending={pending}
          context={context}
          onRun={() => {
            setPending(null);
            onRun(pending.command, pending.plugin.name);
          }}
          onCancel={() => setPending(null)}
        />
      )}
    </>
  );
}
