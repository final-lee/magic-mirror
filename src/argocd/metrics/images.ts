import { envOf, type ArgoEnv } from "../argoEnv";
import type { ArgoAppRow, ArgoTreeNode } from "../types";
import { rowKey } from "../argoGroup";

export interface ImageRef {
  /** 태그와 다이제스트를 뗀 이름(`registry/repo`) */
  repository: string;
  tag: string | null;
  digest: string | null;
}

/** `registry:5000/team/web:1.2@sha256:…` → 저장소·태그·다이제스트. 태그의 `:`는 마지막 `/` 뒤에 있는 것만 본다(레지스트리 포트와 구분) */
export function parseImage(raw: string): ImageRef {
  const at = raw.indexOf("@");
  const digest = at >= 0 ? raw.slice(at + 1) : null;
  const name = at >= 0 ? raw.slice(0, at) : raw;
  const colon = name.lastIndexOf(":");
  const hasTag = colon > name.lastIndexOf("/");
  return { repository: hasTag ? name.slice(0, colon) : name, tag: hasTag ? name.slice(colon + 1) : null, digest };
}

export interface ImageApp {
  key: string;
  namespace: string;
  name: string;
  env: ArgoEnv;
}

export interface TagUse {
  /** 태그. 태그가 없고 다이제스트만 있으면 다이제스트, 둘 다 없으면 null */
  tag: string | null;
  apps: ImageApp[];
}

export interface RepoImages {
  repository: string;
  tags: TagUse[];
  /** 이 저장소를 쓰는 앱 수 */
  appCount: number;
  /** `latest` 태그를 쓰는 곳이 있다 */
  latest: boolean;
  /** 태그도 다이제스트도 없는 곳이 있다(암묵적으로 latest) */
  untagged: boolean;
  /** 환경마다 다른 태그를 쓰고 있다(preview·분류 못 한 환경은 빼고 본다) */
  envMismatch: boolean;
  envs: ArgoEnv[];
}

export interface TreeImages {
  app: { namespace: string; name: string };
  nodes: Pick<ArgoTreeNode, "images">[];
}

const COMPARED_ENVS: ArgoEnv[] = ["dev", "stg", "prd", "ops", "demo"];

/**
 * 앱 목록 행의 `status.summary.images`와 열어 본 리소스 트리의 이미지를 저장소별로 묶는다.
 * 트리가 없는 앱은 요약만 쓴다(요약은 서버가 앱 상태에 싣는 것이라 목록만으로 거의 다 나온다).
 */
export function imageInventory(rows: ArgoAppRow[], trees: TreeImages[]): RepoImages[] {
  const fromTrees = new Map(trees.map((t) => [rowKey(t.app.namespace, t.app.name), t.nodes.flatMap((n) => n.images)]));
  const repos = new Map<string, Map<string | null, Map<string, ImageApp>>>();
  for (const row of rows) {
    const key = rowKey(row.namespace, row.name);
    const raws = new Set([...(row.images ?? []), ...(fromTrees.get(key) ?? [])]);
    const app: ImageApp = { key, namespace: row.namespace, name: row.name, env: envOf(row).env };
    for (const raw of raws) {
      const image = parseImage(raw);
      const tags = repos.get(image.repository) ?? new Map<string | null, Map<string, ImageApp>>();
      const label = image.tag ?? image.digest;
      const users = tags.get(label) ?? new Map<string, ImageApp>();
      users.set(key, app);
      tags.set(label, users);
      repos.set(image.repository, tags);
    }
  }
  const result = [...repos].map(([repository, tags]): RepoImages => {
    const uses = [...tags].map(([tag, users]): TagUse => ({ tag, apps: [...users.values()].sort((a, b) => a.key.localeCompare(b.key)) }));
    uses.sort((a, b) => b.apps.length - a.apps.length || String(a.tag).localeCompare(String(b.tag)));
    const tagsByEnv = new Map<ArgoEnv, Set<string | null>>();
    for (const use of uses) for (const app of use.apps) tagsByEnv.set(app.env, (tagsByEnv.get(app.env) ?? new Set()).add(use.tag));
    const compared = COMPARED_ENVS.filter((env) => tagsByEnv.has(env));
    const first = compared.length ? [...(tagsByEnv.get(compared[0]) as Set<string | null>)].sort().join("\0") : "";
    return {
      repository,
      tags: uses,
      appCount: new Set(uses.flatMap((u) => u.apps.map((a) => a.key))).size,
      latest: uses.some((u) => u.tag === "latest"),
      untagged: uses.some((u) => u.tag === null),
      envMismatch: compared.length > 1 && compared.some((env) => [...(tagsByEnv.get(env) as Set<string | null>)].sort().join("\0") !== first),
      envs: [...tagsByEnv.keys()],
    };
  });
  const flagged = (r: RepoImages) => Number(r.envMismatch) + Number(r.latest) + Number(r.untagged);
  return result.sort((a, b) => flagged(b) - flagged(a) || b.appCount - a.appCount || a.repository.localeCompare(b.repository));
}
