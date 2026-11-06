import type { Resource } from "../api/types";
import { layoutDeviceMap } from "./deviceMapLayout";
import type { Device } from "./devicesApi";
import type { TsPeer } from "./types";

const device = (id: string, extra: Partial<Device> = {}): Device => ({ id, name: `${id}.example`, findings: [], ...extra });
const peer = (id: string, extra: Partial<TsPeer> = {}): TsPeer => ({ hostName: id, dnsName: `${id}.example`, os: "linux", ips: [], online: true, routes: [], exitNodeOption: false, exitNode: false, tags: [], relay: "nyc", curAddr: "", lastSeen: null, keyExpiry: null, owner: null, ...extra });
const vpc: Resource = { id: "v1", name: "production", arn: null, values: { cidr: "10.1.0.0/16" }, tags: {}, fields: [], raw: "", consoleUrl: null };

test("groups by first tag, owners with several untagged devices, then the rest; orders by size and counts online paths", () => {
  const devices = [
    device("a", { tags: ["tag:k8s", "tag:other"] }), device("b", { tags: ["tag:k8s"] }),
    device("c", { user: "alice" }), device("d"), device("e", { user: "bob" }),
    device("f", { user: "carol" }), device("g", { user: "carol" }), device("h", { user: "carol" }),
  ];
  const peers = [peer("a", { curAddr: "1.2.3.4" }), peer("b"), peer("c", { online: false }), peer("d", { relay: "sfo" })];
  const graph = layoutDeviceMap({ devices, peers, self: peer("self") });
  // 기기가 한두 대인 소유자(alice, bob)와 소유자 없는 기기는 한 묶음으로 모은다
  expect(graph.groups.map((g) => [g.name, g.devices.length])).toEqual([["carol", 3], ["태그 없는 기기", 3], ["tag:k8s", 2]]);
  expect(graph.nodes.filter((n) => n.kind === "connection").map((n) => [n.label, n.deviceIds])).toEqual([["직접", ["a"]], ["릴레이 nyc", ["b"]], ["릴레이 sfo", ["d"]]]);
  // 연결 경로는 묶음으로 선을 긋지 않는다(경로 노드에 올리면 그 기기들을 강조한다). 오프라인 기기는 어느 경로에도 없다
  expect(graph.edges.filter((e) => e.to.startsWith("group:"))).toEqual([]);
  expect(graph.nodes.some((n) => n.deviceIds?.includes("c"))).toBe(false);
  expect(layoutDeviceMap({ devices: [...devices].reverse(), peers, self: peer("self") })).toEqual(graph);
});

test("groups sit in aligned rows: same top and height within a row, never overlapping", () => {
  const devices = [
    ...Array.from({ length: 30 }, (_, i) => device(`k${i}`, { tags: ["tag:k8s"] })),
    ...Array.from({ length: 24 }, (_, i) => device(`w${i}`, { tags: ["tag:web"] })),
    ...["ann", "ben", "cat", "dan", "eve", "fay", "gus", "hal"].flatMap((user) => Array.from({ length: 3 }, (_, i) => device(`${user}${i}`, { user }))),
  ];
  const { groups } = layoutDeviceMap({ devices, peers: [], self: null });
  const rows = new Map<number, typeof groups>();
  for (const group of groups) rows.set(group.y, [...(rows.get(group.y) ?? []), group]);
  expect(rows.size).toBeGreaterThan(1);
  for (const row of rows.values()) expect(new Set(row.map((g) => g.height)).size).toBe(1);
  for (const a of groups) {
    for (const b of groups) {
      if (a === b) continue;
      const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
      expect(apart, `${a.name} overlaps ${b.name}`).toBe(true);
    }
  }
  // 칩은 제 묶음 상자 안에 있다
  for (const group of groups) {
    for (const chip of group.devices) {
      expect(chip.x >= group.x && chip.x + chip.width <= group.x + group.width && chip.y + chip.height <= group.y + group.height).toBe(true);
    }
  }
});

test("this Mac's own device shows online from the CLI self entry and never counts as a connection path", () => {
  const self = peer("mac", { relay: "tok" });
  const graph = layoutDeviceMap({ devices: [device("mac"), device("b")], peers: [peer("b")], self });
  expect(graph.nodes.find((n) => n.device?.id === "mac")?.peer).toBe(self);
  expect(graph.nodes.filter((n) => n.kind === "connection").map((n) => [n.label, n.count])).toEqual([["릴레이 nyc", 1]]);
});

test("connects approved and pending routes, covered VPCs, and exit nodes", () => {
  const router = device("router", { enabledRoutes: ["10.0.0.0/8", "0.0.0.0/0", "::/0"], advertisedRoutes: ["10.0.0.0/8", "192.168.0.0/16", "0.0.0.0/0", "::/0"] });
  const graph = layoutDeviceMap({ devices: [router], peers: [], self: null, vpcs: [vpc] });
  expect(graph.edges).toEqual(expect.arrayContaining([
    expect.objectContaining({ from: "device:router", to: "route:10.0.0.0/8", pending: false }),
    expect.objectContaining({ from: "device:router", to: "route:192.168.0.0/16", pending: true }),
    expect.objectContaining({ from: "route:10.0.0.0/8", to: "vpc:v1" }),
    expect.objectContaining({ from: "device:router", to: "exit" }),
  ]));
  expect(graph.nodes.some((n) => n.kind === "self")).toBe(false);
});
