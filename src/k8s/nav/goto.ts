import { fuzzyRank, tokenize } from "../../lib/fuzzy";
import type { K8sView } from "../K8sNav";
import { ALL } from "../TopBar";
import { NAV_ALL, NAV_EVENTS, NAV_FORWARDS, NAV_MY_PERMISSIONS, NAV_OVERVIEW, CHANGE_LOG } from "../text";
import { NAV_ACCESS } from "../access/text";
import { NAV_HELM } from "../helm/text";
import { NAV_NETWORK } from "../network/text";
import { NAV_SECURITY } from "../security/text";
import { NAV_TERMINAL } from "../terminal/text";
import type { K8sKind, K8sKindRef } from "../types";
import { closestNames, resolveKind, suggestKinds } from "./aliases";
import {
  GOTO_GROUP_KIND, GOTO_GROUP_NS, GOTO_GROUP_VIEW, GOTO_NS_ALL, GOTO_NS_CURRENT, GOTO_NS_USAGE, gotoAmbiguous, gotoUnknown, gotoUnknownNamespace,
} from "./text";

/** EKS 탭의 메뉴 화면과 `:` 뒤에 적는 이름들(첫째가 대표 이름). 종류 별칭과 겹치면 메뉴가 먼저다(`:events`) */
export const VIEW_NAMES: { view: K8sView; names: string[]; label: string }[] = [
  { view: "overview", names: ["overview", "ov", "home"], label: NAV_OVERVIEW },
  { view: "workloads", names: ["workloads", "all"], label: NAV_ALL },
  { view: "events", names: ["events", "event", "ev"], label: NAV_EVENTS },
  { view: "network", names: ["network", "net", "networking"], label: NAV_NETWORK },
  { view: "forwards", names: ["forwards", "forward", "pf", "portforward"], label: NAV_FORWARDS },
  { view: "helm", names: ["helm"], label: NAV_HELM },
  { view: "terminal", names: ["terminal", "term", "kubectl"], label: NAV_TERMINAL },
  { view: "myRules", names: ["permissions", "perms", "myrules"], label: NAV_MY_PERMISSIONS },
  { view: "access", names: ["access", "rbac"], label: NAV_ACCESS },
  { view: "security", names: ["security", "audit"], label: NAV_SECURITY },
  { view: "changeLog", names: ["changes", "changelog", "history"], label: CHANGE_LOG },
];

/** 네임스페이스를 바꾸는 명령 이름. 목록을 보는 중이 아닐 때 인자 없이 `:ns`만 적으면 Namespace 종류 목록으로 간다 */
const NS_WORDS = ["ns", "namespace", "namespaces"];
/** 네임스페이스 있는 종류의 목록을 보는 중이면 이 이름만 적어도 그 목록의 네임스페이스 고르기가 된다(`namespaces`는 늘 종류 목록) */
const NS_PICK_WORDS = ["ns", "namespace"];

export type Goto =
  | { type: "kind"; kind: K8sKindRef }
  | { type: "view"; view: K8sView }
  /** namespace가 ALL("")이면 모든 네임스페이스 */
  | { type: "namespace"; namespace: string };

export type Parsed = { ok: true; goto: Goto } | { ok: false; message: string };

export interface GotoContext {
  kinds: K8sKind[];
  /** 네임스페이스 watch가 아는 이름들 */
  namespaces: string[];
  /** 지금 보는 네임스페이스 있는 종류의 목록과 그 네임스페이스(ALL("")이면 모두). 목록이 아니거나 클러스터 범위 종류면 없다 */
  current?: { kind: K8sKindRef; namespace: string };
}

/** 입력 하나를 이름과 인자로 나눈다(`ns  kube-system` → ns, kube-system) */
function split(input: string): { name: string; arg: string | null } {
  const text = input.trim().replace(/^:/, "").trim();
  const space = text.search(/\s/);
  if (space < 0) return { name: text, arg: null };
  return { name: text.slice(0, space), arg: text.slice(space).trim() };
}

const viewOf = (name: string) => VIEW_NAMES.find((v) => v.names.includes(name.toLowerCase()));

/** 목록을 보는 중에 `ns`(뒤에 이름이 있든 없든)를 적고 있으면 그 목록의 네임스페이스를 고르는 중이다 */
export function pickingNamespace(input: string, ctx: GotoContext): boolean {
  return ctx.current !== undefined && NS_PICK_WORDS.includes(split(input).name.toLowerCase());
}

/** 목록을 보는 중에 `ns`만 적고 Enter를 누르면 이동하지 않고 그 목록의 네임스페이스 고르기를 연다 */
export function opensNamespacePicker(input: string, ctx: GotoContext): boolean {
  return pickingNamespace(input, ctx) && split(input).arg === null;
}

/** Enter로 실행할 이동. 정확히 맞는 이름만 받고, 아니면 이유와 가까운 이름을 돌려준다 */
export function parseGoto(input: string, ctx: GotoContext): Parsed {
  const { name, arg } = split(input);
  if (!name) return { ok: false, message: gotoUnknown("", []) };
  const word = name.toLowerCase();
  if (NS_WORDS.includes(word) && arg) return parseNamespace(arg, ctx.namespaces);
  if (arg) return { ok: false, message: gotoUnknown(`${name} ${arg}`, []) };
  const view = viewOf(word);
  if (view) return { ok: true, goto: { type: "view", view: view.view } };
  const found = resolveKind(word, ctx.kinds);
  if (found.ok) return { ok: true, goto: { type: "kind", kind: found.kind } };
  if (found.reason === "ambiguous") return { ok: false, message: gotoAmbiguous(name, found.options.map((o) => `${o.plural}.${o.group}`)) };
  const closeViews = VIEW_NAMES.flatMap((v) => v.names.slice(0, 1)).filter((n) => fuzzyRank([n], word, (x) => [x]).length > 0);
  return { ok: false, message: gotoUnknown(name, [...closeViews, ...closestNames(word, ctx.kinds)].slice(0, 3)) };
}

function parseNamespace(arg: string, namespaces: string[]): Parsed {
  const wanted = arg.toLowerCase();
  if (wanted === "all" || wanted === "-a" || wanted === "*") return { ok: true, goto: { type: "namespace", namespace: ALL } };
  const exact = namespaces.find((n) => n === arg);
  if (exact !== undefined) return { ok: true, goto: { type: "namespace", namespace: exact } };
  const close = fuzzyRank(namespaces, arg, (n) => [n]).slice(0, 3).map((r) => r.item);
  return { ok: false, message: gotoUnknownNamespace(arg, close) };
}

/** 후보 한 줄 */
export interface Completion {
  /** 고르면 입력칸을 이 글자로 채운다 */
  text: string;
  /** 줄 왼쪽 */
  title: string;
  /** 줄 오른쪽(다른 이름들, 그룹) */
  hint: string;
  group: string;
  goto?: Goto;
}

const MAX_COMPLETIONS = 8;
/** 네임스페이스 후보는 목록 안에서 스크롤해 고르므로 더 많이 보인다 */
const MAX_NAMESPACES = 100;

/** 입력 중인 글자에 맞는 후보: 메뉴, 종류, 그리고 `ns ` 뒤(목록을 보는 중이면 `ns`만 적어도)에는 네임스페이스 */
export function completions(input: string, ctx: GotoContext): Completion[] {
  const text = input.replace(/^:/, "").replace(/^\s+/, "");
  const space = text.search(/\s/);
  const picking = ctx.current !== undefined && space < 0 && NS_PICK_WORDS.includes(text.toLowerCase());
  if (space >= 0 || picking) {
    const word = (picking ? text : text.slice(0, space)).toLowerCase();
    if (!NS_WORDS.includes(word)) return [];
    const arg = picking ? "" : text.slice(space).trim();
    const now = ctx.current?.namespace;
    const options = [{ name: "all", hint: GOTO_NS_ALL, current: now === ALL }, ...ctx.namespaces.map((n) => ({ name: n, hint: "", current: now === n }))];
    return fuzzyRank(options, arg, (o) => [o.name])
      .slice(0, MAX_NAMESPACES)
      .map(({ item }) => ({
        text: `${word === "namespaces" ? "ns" : word} ${item.name}`,
        title: item.name,
        hint: [item.hint, item.current ? GOTO_NS_CURRENT : ""].filter(Boolean).join(" · "),
        group: GOTO_GROUP_NS,
      }));
  }
  const tokens = tokenize(text);
  const views = VIEW_NAMES.map((v) => ({ v, ranked: tokens.length === 0 ? [{ item: v.names[0], score: 0 }] : fuzzyRank(v.names, text, (n) => [n]) }))
    .filter((x) => x.ranked.length > 0)
    .map(({ v, ranked }): Completion & { score: number } => ({
      text: ranked[0].item,
      title: ranked[0].item,
      hint: [v.label, ...v.names.filter((n) => n !== ranked[0].item).slice(0, 2)].join(" · "),
      group: GOTO_GROUP_VIEW,
      score: ranked[0].score,
    }));
  const kinds = suggestKinds(text, ctx.kinds, MAX_COMPLETIONS).map((h): Completion & { score: number } => ({
    text: h.name,
    title: h.name,
    hint: [h.kind.group || "core", ...h.others].join(" · "),
    group: GOTO_GROUP_KIND,
    goto: { type: "kind", kind: h.kind },
    score: h.score,
  }));
  // 이름이 같은 메뉴와 종류(events)는 메뉴만 보인다. 점수가 높은 것부터, 같으면 메뉴가 먼저
  const taken = new Set(views.map((c) => c.text));
  return [...views, ...kinds.filter((c) => !taken.has(c.text))]
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_COMPLETIONS)
    .map(({ score: _score, ...c }) => c);
}
