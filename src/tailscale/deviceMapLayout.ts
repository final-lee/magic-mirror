import type { Resource } from "../api/types";
import { coverage, EXIT_ROUTES, isExitRoute } from "./coverage";
import type { Device } from "./devicesApi";
import * as text from "./devicesText";
import type { TsPeer } from "./types";

export function peerFor(device: Device, peers: TsPeer[]) {
  const name = device.name?.replace(/\.$/, "").toLowerCase();
  return peers.find((peer) =>
    (name && peer.dnsName.replace(/\.$/, "").toLowerCase() === name) ||
    peer.ips.some((ip) => device.addresses?.includes(ip)),
  );
}

export interface MapNode {
  id: string; kind: "self" | "connection" | "device" | "route" | "vpc" | "exit";
  label: string; x: number; y: number; width: number; height: number;
  device?: Device; peer?: TsPeer; count?: number;
  /** 연결 노드: 이 경로로 붙은 기기 */
  deviceIds?: string[];
}
export interface MapGroup { id: string; name: string; x: number; y: number; width: number; height: number; devices: MapNode[] }
export interface MapEdge { id: string; from: string; to: string; count?: number; pending?: boolean; deviceIds: string[] }
export interface MapLayout { nodes: MapNode[]; edges: MapEdge[]; groups: MapGroup[]; width: number; height: number }

const CHIP_W = 156;
const CHIP_H = 29;
const CHIP_GAP = 9;
const GROUP_PAD = 12;
const GROUP_HEAD = 36;
const GROUP_GAP = 20;
const MAX_CHIP_COLUMNS = 8;
const GROUPS_X = 380;
const TOP = 45;
/** 지도 가로:세로 목표. 가로로 긴 창에 맞췄을 때 글이 읽힐 만큼 크게 보이게 묶음 줄의 폭을 고른다 */
const TARGET_RATIO = 2;
/** 태그 없는 기기는 소유자의 기기가 이만큼 있을 때만 그 소유자로 따로 묶는다 */
const OWNER_GROUP_MIN = 3;
const SIDE_NODE_W = 170;
const SIDE_NODE_H = 34;
const SIDE_NODE_STEP = 52;

/** 큰 묶음은 칩 열을 늘려 높이를 비슷하게 맞춘다(1대 1열, 2대 2열, 3대 3열, 24대 7열, 30대 8열) */
const chipColumns = (count: number) => Math.min(MAX_CHIP_COLUMNS, Math.max(1, Math.ceil(Math.sqrt(count * 2))));
const groupWidth = (columns: number) => GROUP_PAD * 2 + columns * CHIP_W + (columns - 1) * CHIP_GAP;
const groupHeight = (count: number, columns: number) => GROUP_HEAD + Math.ceil(count / columns) * (CHIP_H + CHIP_GAP) - CHIP_GAP + GROUP_PAD;

/** 첫 태그, 없으면 기기가 여럿인 소유자, 나머지는 태그 없는 기기 한 묶음. 큰 묶음부터 */
function groupDevices(sorted: Device[]): [string, Device[]][] {
  const owned = new Map<string, number>();
  for (const device of sorted) if (!device.tags?.length && device.user) owned.set(device.user, (owned.get(device.user) ?? 0) + 1);
  const groups = new Map<string, Device[]>();
  for (const device of sorted) {
    const user = device.user && (owned.get(device.user) ?? 0) >= OWNER_GROUP_MIN ? device.user : null;
    const key = device.tags?.[0] || user || text.MAP_OTHER_GROUP;
    groups.set(key, [...(groups.get(key) ?? []), device]);
  }
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
}

/**
 * 기기 지도의 자리. 왼쪽에 이 Mac과 연결 경로(직접·릴레이 지역), 가운데에 기기 묶음을 줄 맞춰 놓고(한 줄의 상자는
 * 위·아래 끝이 같다), 오른쪽에 서브넷 경로·exit node와 그 경로로 덮이는 VPC. 연결 경로는 선 대신 노드에 기기 수와
 * 기기 목록(`deviceIds`)을 실어, 화면이 노드에 올렸을 때 그 기기들을 강조한다.
 * 입력 순서에 의존하지 않으며 화면이나 네트워크에 접근하지 않는다.
 */
export function layoutDeviceMap({ devices, peers, self, vpcs = [] }: {
  devices: Device[]; peers: TsPeer[]; self: TsPeer | null; vpcs?: Resource[];
}): MapLayout {
  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  const groups: MapGroup[] = [];
  const sorted = [...devices].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  // 이 Mac은 CLI 피어 목록에 없어서 따로 맞춘다. 자기 자신으로 가는 연결 경로는 없다
  const known = self ? [self, ...peers] : peers;
  const peerOf = new Map(sorted.map((device) => [device.id, peerFor(device, known)]));
  const paths = new Map<string, string[]>();
  for (const device of sorted) {
    const peer = peerOf.get(device.id);
    if (!peer?.online || peer === self) continue;
    const path = peer.curAddr ? text.DIRECT : text.relay(peer.relay || text.NONE);
    paths.set(path, [...(paths.get(path) ?? []), device.id]);
  }

  if (self) nodes.push({ id: "self", kind: "self", label: text.MAP_SELF, x: 24, y: TOP + 20, width: 130, height: 42 });
  [...paths.entries()]
    .sort(([a], [b]) => (a === text.DIRECT ? -1 : b === text.DIRECT ? 1 : a.localeCompare(b)))
    .forEach(([name, ids], index) => {
      const id = `path:${name}`;
      nodes.push({ id, kind: "connection", label: name, count: ids.length, deviceIds: ids, x: 190, y: TOP + index * 56, width: 150, height: 42 });
      if (self) edges.push({ id: `self-${id}`, from: "self", to: id, count: ids.length, deviceIds: ids });
    });

  // 묶음을 큰 것부터 왼쪽→오른쪽으로 놓고 줄 폭을 넘으면 다음 줄로. 한 줄의 상자는 그 줄에서 가장 높은 상자 높이로 맞춘다
  const grouped = groupDevices(sorted).map(([name, members]) => {
    const columns = chipColumns(members.length);
    return { name, members, columns, width: groupWidth(columns), height: groupHeight(members.length, columns) };
  });
  const area = grouped.reduce((sum, g) => sum + (g.width + GROUP_GAP) * (g.height + GROUP_GAP), 0);
  const rowWidth = Math.max(...grouped.map((g) => g.width), Math.sqrt(area * TARGET_RATIO), 0);
  let rowStart = 0;
  let x = GROUPS_X;
  let y = TOP;
  let rowHeight = 0;
  const closeRow = (end: number) => {
    for (const group of groups.slice(rowStart, end)) group.height = rowHeight;
    y += rowHeight + GROUP_GAP;
    x = GROUPS_X;
    rowHeight = 0;
    rowStart = end;
  };
  let right = GROUPS_X;
  for (const g of grouped) {
    if (x > GROUPS_X && x + g.width > GROUPS_X + rowWidth) closeRow(groups.length);
    const group: MapGroup = { id: `group:${g.name}`, name: g.name, x, y, width: g.width, height: g.height, devices: [] };
    g.members.forEach((device, index) => {
      const chip: MapNode = {
        id: `device:${device.id}`, kind: "device", label: device.hostname || device.name,
        x: x + GROUP_PAD + (index % g.columns) * (CHIP_W + CHIP_GAP),
        y: y + GROUP_HEAD + Math.floor(index / g.columns) * (CHIP_H + CHIP_GAP),
        width: CHIP_W, height: CHIP_H, device, peer: peerOf.get(device.id),
      };
      group.devices.push(chip);
      nodes.push(chip);
    });
    groups.push(group);
    rowHeight = Math.max(rowHeight, g.height);
    x += g.width + GROUP_GAP;
    right = Math.max(right, x - GROUP_GAP);
  }
  if (groups.length > rowStart) closeRow(groups.length);

  // 오른쪽: 서브넷 경로·exit node는 그 경로를 낸 기기 칩 높이 가까이, VPC는 그 VPC를 덮는 경로 가까이 둔다(선이 짧고 덜 엇갈리게)
  const routesX = right + 80;
  const vpcsX = routesX + SIDE_NODE_W + 80;
  const chipMiddle = new Map(nodes.filter((n) => n.device).map((n) => [n.device!.id, n.y + n.height / 2]));
  const side = new Map<string, { kind: MapNode["kind"]; label: string; sources: string[] }>();
  const link = (id: string, kind: MapNode["kind"], label: string, deviceId: string, pending: boolean) => {
    const entry = side.get(id) ?? { kind, label, sources: [] };
    entry.sources.push(deviceId);
    side.set(id, entry);
    edges.push({ id: `${deviceId}-${id}`, from: `device:${deviceId}`, to: id, pending, deviceIds: [deviceId] });
  };
  for (const device of sorted) {
    const approved = device.enabledRoutes ?? [];
    const advertised = device.advertisedRoutes ?? [];
    for (const route of [...new Set([...approved, ...advertised])].filter((r) => !isExitRoute(r)).sort()) {
      link(`route:${route}`, "route", route, device.id, !approved.includes(route));
    }
    if (EXIT_ROUTES.every((route) => approved.includes(route))) link("exit", "exit", text.MAP_EXIT, device.id, false);
    for (const route of EXIT_ROUTES.filter((r) => advertised.includes(r) && !approved.includes(r))) {
      link(`route:${route}`, "route", route, device.id, true);
    }
  }
  const average = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
  /** 바라는 높이 순으로 놓되 앞 노드와 겹치면 아래로 민다. 놓은 노드의 가운데 높이를 돌려준다 */
  const placeColumn = (entries: { id: string; kind: MapNode["kind"]; label: string; desired: number; width: number }[], x: number) => {
    const middles = new Map<string, number>();
    let next = TOP;
    for (const entry of [...entries].sort((a, b) => a.desired - b.desired || a.id.localeCompare(b.id))) {
      const y = Math.max(next, entry.desired - SIDE_NODE_H / 2);
      nodes.push({ id: entry.id, kind: entry.kind, label: entry.label, x, y, width: entry.width, height: SIDE_NODE_H });
      middles.set(entry.id, y + SIDE_NODE_H / 2);
      next = y + SIDE_NODE_STEP;
    }
    return middles;
  };
  const routeMiddles = placeColumn(
    [...side].map(([id, { kind, label, sources }]) => ({ id, kind, label, width: SIDE_NODE_W, desired: average(sources.map((d) => chipMiddle.get(d) ?? TOP)) })),
    routesX,
  );

  const routes = [...side.keys()].filter((id) => id.startsWith("route:")).map((id) => id.slice("route:".length));
  const vpcEntries = [...vpcs].flatMap((vpc) => {
    const covering = routes.filter((route) =>
      coverage(vpc.values.cidr ?? "", [route]) === text.COVERAGE_FULL && sorted.some((d) => d.enabledRoutes?.includes(route)));
    if (!covering.length) return [];
    const id = `vpc:${vpc.id}`;
    for (const route of covering) {
      edges.push({ id: `${route}-${id}`, from: `route:${route}`, to: id, deviceIds: sorted.filter((d) => d.enabledRoutes?.includes(route)).map((d) => d.id) });
    }
    return [{ id, kind: "vpc" as const, label: `${vpc.name} (${vpc.values.cidr})`, width: SIDE_NODE_W + 30, desired: average(covering.map((r) => routeMiddles.get(`route:${r}`)!)) }];
  });
  placeColumn(vpcEntries, vpcsX);

  const width = (vpcEntries.length ? vpcsX + SIDE_NODE_W + 30 : side.size ? routesX + SIDE_NODE_W : right) + 24;
  const height = Math.max(300, y, ...nodes.map((n) => n.y + n.height + 40));
  return { nodes, edges, groups, width, height };
}
