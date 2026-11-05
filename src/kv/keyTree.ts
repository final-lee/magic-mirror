import type { KvKeyRow } from "./types";
import { keyId } from "./route";

export interface FolderNode {
  kind: "folder";
  /** 폴더를 가리키는 글: 구분자까지 붙은 앞부분("session:2026:") */
  path: string;
  label: string;
  /** 이 폴더 아래의(깊은 것까지) 읽은 키 수 */
  count: number;
  children: TreeNode[];
}
export interface LeafNode {
  kind: "key";
  id: string;
  row: KvKeyRow;
  /** 폴더 안에서 보이는 이름(마지막 조각) */
  label: string;
}
export type TreeNode = FolderNode | LeafNode;

const collate = (a: string, b: string) => a.localeCompare(b, "ko", { numeric: true, sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);

/**
 * 읽은 키를 구분자로 끊어 폴더 트리로 묶는다. 구분자가 비면 평면 목록이다.
 * 폴더가 앞, 키가 뒤이고 각각 이름순(숫자는 크기순)이다. 키 이름이 폴더 이름과 같은 키("a"와 "a:b")는 둘 다 보인다.
 */
export function buildKeyTree(rows: readonly KvKeyRow[], delimiter: string): TreeNode[] {
  const root: FolderNode = { kind: "folder", path: "", label: "", count: 0, children: [] };
  const folders = new Map<string, FolderNode>();
  for (const row of rows) {
    const parts = delimiter ? row.name.text.split(delimiter) : [row.name.text];
    let parent = root;
    parent.count++;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join(delimiter) + delimiter;
      let folder = folders.get(path);
      if (!folder) {
        folder = { kind: "folder", path, label: parts[i], count: 0, children: [] };
        folders.set(path, folder);
        parent.children.push(folder);
      }
      folder.count++;
      parent = folder;
    }
    parent.children.push({ kind: "key", id: keyId(row.name), row, label: parts[parts.length - 1] });
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => (a.kind === b.kind ? collate(a.label, b.label) : a.kind === "folder" ? -1 : 1));
    for (const n of nodes) if (n.kind === "folder") sort(n.children);
  };
  sort(root.children);
  return root.children;
}

/** 화면에 그리는 한 줄: 노드와 들여쓰기 깊이 */
export interface TreeRow {
  node: TreeNode;
  depth: number;
}

/** 펼친 폴더만 따라 한 줄씩 편다. expanded가 "all"이면 모두 펼친다(찾기 결과) */
export function flattenTree(nodes: readonly TreeNode[], expanded: ReadonlySet<string> | "all", depth = 0, out: TreeRow[] = []): TreeRow[] {
  for (const node of nodes) {
    out.push({ node, depth });
    if (node.kind === "folder" && (expanded === "all" || expanded.has(node.path))) flattenTree(node.children, expanded, depth + 1, out);
  }
  return out;
}
