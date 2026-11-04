import { useEffect, useRef, useState } from "react";
import { useModal } from "../iam/useModal";
import { fuzzyKeep } from "../lib/fuzzy";
import { COMMANDS, KEYBINDINGS, type KeyScope } from "./keybindings";
import { keyLabel } from "./keys";
import { canRun, getExtraBindings } from "./registry";

export const SHORTCUTS_TITLE = "단축키";

const SCOPE_LABEL: Record<KeyScope, string> = {
  app: "앱 전체",
  list: "목록",
  dialog: "대화상자",
  terminal: "터미널",
  explorer: "파일 탐색기",
  diff: "파일 비교",
  k8s: "EKS",
};

const SCOPE_ORDER: KeyScope[] = ["app", "list", "k8s", "explorer", "diff", "dialog", "terminal"];

/** ⌘/: 키 바인딩 표를 범위별로 보여 준다. 지금 화면에서 처리할 곳이 없는 키는 흐리게 */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { sheetRef, trapTab } = useModal(onClose);
  useEffect(() => inputRef.current?.focus(), []);
  // 어떤 명령을 지금 처리할 곳이 있는지
  const bindings = [...KEYBINDINGS, ...getExtraBindings()];
  const usable = new Set(bindings.filter((b) => b.handler === "registry" && canRun(b.command)).map((b) => b.command));
  const rows = bindings.map((b) => ({ ...b, title: b.title ?? COMMANDS[b.command]?.title ?? b.command, label: keyLabel(b.key) }));
  const shown = fuzzyKeep(rows, query, (r) => [r.title, r.label, SCOPE_LABEL[r.scope]]);
  return (
    <div className="modal">
      <div className="sheet wide pk palette shortcuts" role="dialog" aria-modal="true" aria-label={SHORTCUTS_TITLE} ref={sheetRef} onKeyDown={trapTab}>
        <input
          ref={inputRef}
          type="search"
          className="iam-filter pk-search"
          aria-label={`${SHORTCUTS_TITLE} 찾기`}
          placeholder="동작이나 키로 찾기"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="shortcuts-body">
          {SCOPE_ORDER.map((scope) => {
            const list = shown.filter((r) => r.scope === scope);
            if (list.length === 0) return null;
            return (
              <section key={scope} aria-label={SCOPE_LABEL[scope]}>
                <h4>{SCOPE_LABEL[scope]}</h4>
                <table className="shortcuts-table">
                  <tbody>
                    {list.map((r) => {
                      const off = r.handler === "registry" && !usable.has(r.command);
                      return (
                        <tr key={`${r.key}|${r.command}`} className={off ? "dim" : undefined} title={off ? "이 화면에서는 쓸 수 없어요" : undefined}>
                          <td><kbd>{r.label}</kbd></td>
                          <td>{r.title}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
