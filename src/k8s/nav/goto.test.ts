import { TEST_KINDS } from "./testKinds";
import { completions, opensNamespacePicker, parseGoto, VIEW_NAMES, type GotoContext } from "./goto";

const ctx: GotoContext = { kinds: TEST_KINDS, namespaces: ["default", "kube-system", "prod", "prod-web"] };

describe("parseGoto", () => {
  test("a kind name or alias goes to that kind, a colon in front is allowed", () => {
    expect(parseGoto("deploy", ctx)).toEqual({ ok: true, goto: { type: "kind", kind: expect.objectContaining({ plural: "deployments" }) } });
    expect(parseGoto(":po", ctx)).toEqual({ ok: true, goto: { type: "kind", kind: expect.objectContaining({ plural: "pods" }) } });
    expect(parseGoto("  Deployments.apps ", ctx)).toEqual({ ok: true, goto: { type: "kind", kind: expect.objectContaining({ group: "apps" }) } });
  });

  test("every menu view can be reached by its name, and each name belongs to one view", () => {
    for (const v of VIEW_NAMES) expect(parseGoto(v.names[0], ctx)).toEqual({ ok: true, goto: { type: "view", view: v.view } });
    const names = VIEW_NAMES.flatMap((v) => v.names);
    expect(new Set(names).size).toBe(names.length);
    for (const name of ["overview", "events", "helm", "access", "security", "network", "forwards", "changes"]) {
      expect(names).toContain(name);
    }
  });

  test("a menu name wins over a kind with the same name (events), but sec stays Secret", () => {
    expect(parseGoto("events", ctx)).toEqual({ ok: true, goto: { type: "view", view: "events" } });
    expect(parseGoto("sec", ctx)).toEqual({ ok: true, goto: { type: "kind", kind: expect.objectContaining({ plural: "secrets" }) } });
  });

  test("ns <name> switches the namespace, ns all means every namespace, and bare ns is the Namespace list", () => {
    expect(parseGoto("ns kube-system", ctx)).toEqual({ ok: true, goto: { type: "namespace", namespace: "kube-system" } });
    expect(parseGoto("ns   prod", ctx)).toEqual({ ok: true, goto: { type: "namespace", namespace: "prod" } });
    expect(parseGoto("ns all", ctx)).toEqual({ ok: true, goto: { type: "namespace", namespace: "" } });
    expect(parseGoto("namespace ALL", ctx)).toEqual({ ok: true, goto: { type: "namespace", namespace: "" } });
    expect(parseGoto("ns", ctx)).toEqual({ ok: true, goto: { type: "kind", kind: expect.objectContaining({ plural: "namespaces" }) } });
  });

  test("an unknown namespace is refused with the closest names, never switched to", () => {
    const r = parseGoto("ns prd", ctx);
    expect(r).toEqual({ ok: false, message: expect.stringContaining("'prd'") });
    expect(r.ok === false && r.message).toContain("prod");
    expect(parseGoto("ns nothing-like-it", ctx)).toEqual({ ok: false, message: expect.not.stringContaining("비슷한") });
  });

  test("an unknown name is refused with closest kinds and menus", () => {
    const r = parseGoto("depoy", ctx);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain("deploy");
    const menu = parseGoto("evnts", ctx);
    expect(menu.ok === false && menu.message).toContain("events");
  });

  test("an ambiguous name says which groups, and extra words after a kind are refused", () => {
    const wd = parseGoto("wd", { ...ctx, kinds: [...ctx.kinds, ...DUP] });
    expect(wd.ok === false && wd.message).toContain("widgets.acme.io");
    expect(wd.ok === false && wd.message).toContain("widgets.mm.example.com");
    expect(parseGoto("pods extra", ctx).ok).toBe(false);
    expect(parseGoto("", ctx).ok).toBe(false);
    expect(parseGoto(":", ctx).ok).toBe(false);
  });
});

const DUP = ["acme.io", "mm.example.com"].map((group) => ({ group, version: "v1", kind: "Widget", plural: "widgets", namespaced: true, verbs: [], custom: true, shortNames: ["wd"], singularName: "widget" }));

describe("completions", () => {
  test("typing a few letters fuzzy-matches kinds and menus together, best first", () => {
    const list = completions("dep", ctx);
    expect(list[0]).toMatchObject({ text: "deployments", group: "종류" });
    const ev = completions("ev", ctx);
    expect(ev[0]).toMatchObject({ text: "ev", group: "메뉴" });
    // 같은 이름의 종류(Event)는 따로 나오지 않는다
    expect(ev.filter((c) => c.text === "ev")).toHaveLength(1);
    expect(completions("events", ctx).filter((c) => c.text === "events")).toEqual([expect.objectContaining({ group: "메뉴" })]);
  });

  test("po finds pods before anything that merely contains the letters", () => {
    expect(completions("po", ctx)[0]).toMatchObject({ text: "po", group: "종류" });
  });

  test("nothing matching gives nothing", () => {
    expect(completions("zzzzq", ctx)).toEqual([]);
  });

  test("after ns and a space the namespaces are offered, filtered as you type, all first when it matches", () => {
    expect(completions("ns ", ctx).map((c) => c.text)).toEqual(["ns all", "ns default", "ns kube-system", "ns prod", "ns prod-web"]);
    expect(completions("ns pw", ctx).map((c) => c.text)).toEqual(["ns prod-web"]);
    expect(completions("ns al", ctx)[0]).toMatchObject({ text: "ns all", hint: "모든 네임스페이스" });
    expect(completions("namespaces k", ctx)[0].text).toBe("ns kube-system");
  });

  test("while a namespaced list is shown, bare ns offers that list's namespaces with the current one marked; namespaces stays the kind", () => {
    const deployments = ctx.kinds.find((k) => k.plural === "deployments")!;
    const shown = { ...ctx, current: { kind: deployments, namespace: "prod" } };
    const list = completions("ns", shown);
    expect(list.map((c) => c.text)).toEqual(["ns all", "ns default", "ns kube-system", "ns prod", "ns prod-web"]);
    expect(list.find((c) => c.title === "prod")).toMatchObject({ hint: "지금 보는 곳" });
    expect(completions("namespace", shown)[0].text).toBe("namespace all");
    expect(opensNamespacePicker("ns", shown)).toBe(true);
    expect(opensNamespacePicker("ns prod", shown)).toBe(false);
    expect(opensNamespacePicker("namespaces", shown)).toBe(false);
    expect(completions("namespaces", shown).some((c) => c.group === "네임스페이스")).toBe(false);
    // 목록을 보는 중이 아니면 그대로 종류 후보다
    expect(opensNamespacePicker("ns", ctx)).toBe(false);
    expect(completions("ns", ctx).some((c) => c.group === "네임스페이스")).toBe(false);
  });

  test("all is marked as current when the list shows every namespace", () => {
    const pods = ctx.kinds.find((k) => k.plural === "pods")!;
    expect(completions("ns", { ...ctx, current: { kind: pods, namespace: "" } })[0]).toMatchObject({ title: "all", hint: "모든 네임스페이스 · 지금 보는 곳" });
  });

  test("a kind name followed by anything else has no completions", () => {
    expect(completions("pods x", ctx)).toEqual([]);
  });

  test("at most eight at a time, and an empty line starts with the menus", () => {
    const list = completions("", ctx);
    expect(list.length).toBeLessThanOrEqual(8);
    expect(list[0].group).toBe("메뉴");
  });
});

