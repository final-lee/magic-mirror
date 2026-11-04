import type { K8sPlugin } from "../../api/types";
import { KEYBINDINGS } from "../../keymap/keybindings";
import { normalizeKey } from "../../keymap/keys";
import type { K8sKindRef } from "../types";

export interface PluginValues {
  NAMESPACE: string;
  NAME: string;
  CONTEXT: string;
  KIND: string;
  CONTAINER: string;
}

/** 셸의 단일 인자로만 해석되도록 감싼다. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function expandPlugin(template: string, values: PluginValues): string {
  let quote: "'" | '"' | null = null;
  let result = "";
  for (let i = 0; i < template.length; i++) {
    const char = template[i];
    if (char === "\\" && quote !== "'") {
      result += char;
      if (i + 1 < template.length) result += template[++i];
      continue;
    }
    if ((char === "'" || char === '"') && (quote === null || quote === char)) {
      quote = quote === null ? char : null;
      result += char;
      continue;
    }
    if (char === "$") {
      const match = template.slice(i).match(/^\$(NAMESPACE|NAME|CONTEXT|KIND|CONTAINER)\b/);
      if (match) {
        const value = values[match[1] as keyof PluginValues];
        result += quote === "'" ? value.replace(/'/g, "'\\''")
          : quote === '"' ? value.replace(/[\\"$`]/g, "\\$&")
          : shellQuote(value);
        i += match[0].length - 1;
        continue;
      }
    }
    result += char;
  }
  return result;
}

export function supportsKind(plugin: K8sPlugin, kind: K8sKindRef): boolean {
  return plugin.kinds.some((candidate) => candidate === "*" || (candidate.group === kind.group && candidate.version === kind.version && candidate.kind === kind.kind && candidate.plural === kind.plural));
}

/** 문법이 틀리거나 고정 키 표·다른 플러그인과 겹치면 거절한다. */
export function pluginKeyError(key: string, otherKeys: readonly string[] = []): string | null {
  if (!key.trim()) return null;
  const parts = key.toLowerCase().split("+");
  const base = parts.pop() ?? "";
  const validMods = ["ctrl", "alt", "shift", "cmd"];
  if (!/^[a-z]$/.test(base) || parts.some((part) => !validMods.includes(part)) || new Set(parts).size !== parts.length) {
    return "한 글자 또는 수식 키와 한 글자를 입력해 주세요";
  }
  const normalized = normalizeKey(key);
  if (KEYBINDINGS.some((binding) => normalizeKey(binding.key) === normalized) || otherKeys.some((other) => normalizeKey(other) === normalized)) {
    return "이미 사용 중인 단축키예요";
  }
  return null;
}
