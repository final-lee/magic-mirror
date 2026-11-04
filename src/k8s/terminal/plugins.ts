import type { K8sPlugin } from "../../api/types";
import { KEYBINDINGS } from "../../keymap/keybindings";
import { normalizeKey } from "../../keymap/keys";
import type { K8sKindRef, ObjectRef } from "../types";
import { PLUGIN_TEMPLATE_SUBSTITUTION, PLUGIN_TEMPLATE_DOLLAR_QUOTE, PLUGIN_TEMPLATE_ESCAPE, PLUGIN_TEMPLATE_HEREDOC, PLUGIN_TEMPLATE_SYNTAX, PLUGIN_TEMPLATE_VARIABLE, PLUGIN_TEMPLATE_BOUNDARY, PLUGIN_TEMPLATE_UNCLOSED, PLUGIN_KEY_INVALID, PLUGIN_KEY_CONFLICT } from "./text";

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
    return PLUGIN_TEMPLATE_SUBSTITUTION;
  }
  if (template.includes("$'") || template.includes('$"')) return PLUGIN_TEMPLATE_DOLLAR_QUOTE;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < template.length; i++) {
    const char = template[i];
    if (char === "\\" && quote !== "'") {
      if (PLACEHOLDER.test(template.slice(i + 1))) return PLUGIN_TEMPLATE_ESCAPE;
      i++;
      continue;
    }
    if ((char === "'" || char === '"') && (quote === null || quote === char)) {
      quote = quote === null ? char : null;
      continue;
    }
    if (quote === null && char === "<" && template[i + 1] === "<") return PLUGIN_TEMPLATE_HEREDOC;
    if (quote === null && (char === "(" || char === ")" || char === "#")) return PLUGIN_TEMPLATE_SYNTAX;
    const match = char === "$" ? template.slice(i).match(PLACEHOLDER) : null;
    if (!match) continue;
    const after = template[i + match[0].length];
    if (after && /[A-Za-z0-9_]/.test(after)) return PLUGIN_TEMPLATE_VARIABLE;
    const before = template[i - 1];
    if (quote === null && ((before && !BOUNDARY.test(before)) || (after && !BOUNDARY.test(after)))) {
      return PLUGIN_TEMPLATE_BOUNDARY;
    }
    i += match[0].length - 1;
  }
  return quote === null ? null : PLUGIN_TEMPLATE_UNCLOSED;
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

/** `$KIND` 값: kubectl이 알아보는 `복수형.그룹`(코어 그룹은 복수형만) */
export function kindArgument(kind: K8sKindRef): string {
  return kind.group ? `${kind.plural}.${kind.group}` : kind.plural;
}

/** 고른 객체에서 플러그인 변수의 값을 만든다. 네임스페이스가 없는 객체와 컨테이너가 없는 종류는 빈 값이다. */
export function pluginValues(context: string, object: ObjectRef, container: string | null): PluginValues {
  return { NAMESPACE: object.namespace ?? "", NAME: object.name, CONTEXT: context, KIND: kindArgument(object.kind), CONTAINER: container ?? "" };
}

/** 플러그인 i번째의 키 명령 이름 */
export const pluginCommand = (index: number) => `k8s.plugin.${index}`;

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
    return PLUGIN_KEY_INVALID;
  }
  const normalized = normalizeKey(key);
  if (KEYBINDINGS.some((binding) => normalizeKey(binding.key) === normalized) || otherKeys.some((other) => normalizeKey(other) === normalized)) {
    return PLUGIN_KEY_CONFLICT;
  }
  return null;
}
