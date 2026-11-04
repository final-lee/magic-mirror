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

const PLACEHOLDER = /^\$(NAMESPACE|NAME|CONTEXT|KIND|CONTAINER)/;
const BOUNDARY = /[\s;|&<>]/;

/** 셸 문법을 완전히 해석하지 않으므로 안전하게 인용할 수 없는 템플릿은 거절한다. */
export function pluginTemplateError(template: string): string | null {
  if (template.includes("$(") || template.includes("${") || template.includes("`")) {
    return "명령 치환과 중괄호 변수는 사용할 수 없어요";
  }
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < template.length; i++) {
    const char = template[i];
    if (char === "\\" && quote !== "'") {
      if (PLACEHOLDER.test(template.slice(i + 1))) return "변수 앞에 역슬래시를 쓸 수 없어요";
      i++;
      continue;
    }
    if ((char === "'" || char === '"') && (quote === null || quote === char)) {
      quote = quote === null ? char : null;
      continue;
    }
    if (quote === null && char === "<" && template[i + 1] === "<") return "here 문서는 사용할 수 없어요";
    if (quote === null && (char === "(" || char === ")" || char === "#")) return "이 셸 구문에서는 변수를 사용할 수 없어요";
    const match = char === "$" ? template.slice(i).match(PLACEHOLDER) : null;
    if (!match) continue;
    const after = template[i + match[0].length];
    if (after && /[A-Za-z0-9_]/.test(after)) return "변수 이름을 확인해 주세요";
    const before = template[i - 1];
    if (quote === null && ((before && !BOUNDARY.test(before)) || (after && !BOUNDARY.test(after)))) {
      return "변수는 독립된 단어 또는 따옴표 안에 넣어 주세요";
    }
    i += match[0].length - 1;
  }
  return quote === null ? null : "닫히지 않은 따옴표가 있어요";
}

export function expandPlugin(template: string, values: PluginValues): string {
  const error = pluginTemplateError(template);
  if (error) throw new Error(error);
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
      const match = template.slice(i).match(PLACEHOLDER);
      if (match) {
        const value = values[match[1] as keyof PluginValues];
        result += quote ? quote + shellQuote(value) + quote : shellQuote(value);
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
