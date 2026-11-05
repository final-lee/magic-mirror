import { describe, expect, it } from "vitest";
import type { ArgoAppRow } from "../types";
import { imageInventory, parseImage } from "./images";

const row = (name: string, env: string, images: string[]): ArgoAppRow => ({ name, namespace: "argocd", resourceVersion: "1", values: {}, labels: { environment: env }, images });

describe("parseImage", () => {
  it("separates repository, tag and digest without confusing a registry port for a tag", () => {
    expect(parseImage("nginx")).toEqual({ repository: "nginx", tag: null, digest: null });
    expect(parseImage("ghcr.io/team/web:1.2.3")).toEqual({ repository: "ghcr.io/team/web", tag: "1.2.3", digest: null });
    expect(parseImage("registry.local:5000/team/web")).toEqual({ repository: "registry.local:5000/team/web", tag: null, digest: null });
    expect(parseImage("registry.local:5000/team/web:v2@sha256:abc")).toEqual({ repository: "registry.local:5000/team/web", tag: "v2", digest: "sha256:abc" });
    expect(parseImage("team/web@sha256:abc")).toEqual({ repository: "team/web", tag: null, digest: "sha256:abc" });
  });
});

describe("imageInventory", () => {
  it("groups by repository and lists tags with the apps and environments that use them", () => {
    const rows = [row("web-dev", "dev", ["repo/web:1.1", "repo/side:1"]), row("web-stg", "stg", ["repo/web:1.1"]), row("web-prd", "prd", ["repo/web:1.0"])];
    const [web, side] = imageInventory(rows, []);
    expect(web.repository).toBe("repo/web");
    expect(web.tags.map((t) => [t.tag, t.apps.map((a) => a.name)])).toEqual([["1.1", ["web-dev", "web-stg"]], ["1.0", ["web-prd"]]]);
    expect(web.appCount).toBe(3);
    expect(web.envMismatch).toBe(true);
    expect(side.envMismatch).toBe(false);
  });

  it("flags latest and untagged images, and treats a digest-only reference as pinned", () => {
    const [latest, untagged, pinned] = imageInventory([row("a", "dev", ["repo/a:latest", "repo/b", "repo/c@sha256:abc"])], []).sort((x, y) => x.repository.localeCompare(y.repository));
    expect([latest.latest, latest.untagged]).toEqual([true, false]);
    expect([untagged.latest, untagged.untagged]).toEqual([false, true]);
    expect([pinned.latest, pinned.untagged]).toEqual([false, false]);
  });

  it("does not flag a mismatch for the same tags in every environment, or for preview and unclassified apps", () => {
    const same = imageInventory([row("a-dev", "dev", ["repo/x:2"]), row("a-prd", "prd", ["repo/x:2"])], []);
    expect(same[0].envMismatch).toBe(false);
    const preview = imageInventory([row("a-prd", "prd", ["repo/x:2"]), { ...row("pr-1", "x", ["repo/x:3"]), labels: { preview: "true" } }, row("misc", "none", ["repo/x:9"])], []);
    expect(preview[0].envMismatch).toBe(false);
    const sets = imageInventory([row("a-dev", "dev", ["repo/x:1", "repo/x:2"]), row("a-prd", "prd", ["repo/x:2"])], []);
    expect(sets[0].envMismatch).toBe(true);
  });

  it("adds images found in opened resource trees to the row summary without counting an app twice", () => {
    const inventory = imageInventory([row("web", "dev", ["repo/web:1"])], [{ app: { namespace: "argocd", name: "web" }, nodes: [{ images: ["repo/web:1", "repo/sidecar:5"] }, { images: [] }] }, { app: { namespace: "argocd", name: "unknown-app" }, nodes: [{ images: ["repo/ghost:1"] }] }]);
    expect(inventory.map((r) => r.repository).sort()).toEqual(["repo/sidecar", "repo/web"]);
    expect(inventory.find((r) => r.repository === "repo/web")?.appCount).toBe(1);
  });

  it("lists flagged repositories first", () => {
    const rows = [row("a", "dev", ["repo/plain:1", "repo/risky:latest"]), row("b", "dev", ["repo/plain:1"])];
    expect(imageInventory(rows, []).map((r) => r.repository)).toEqual(["repo/risky", "repo/plain"]);
  });
});
