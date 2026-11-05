import { clientRows, nodeInfo, sampleBullFlow, sampleBullTopology, sampleBullTransitions, sampleOverview, serverlessOverview, standaloneNodes } from "../fixtures";
import type { KvBullTransitions, KvClient, KvNode } from "../types";
import { buildClusterTopology, hostOf, TOP_HOSTS } from "./clusterModel";
import { flowEdgeStyle, flowNodeId, flowNodeTone, flowStateLabel, layoutFlow } from "./flowModel";
import { buildQueueMap, hostNodeId, mapAttention, queueNodeId } from "./queueModel";
import { buildTransitions, edgeWidth, normalizeState, windowNotes } from "./transitions";

describe("transitions", () => {
  const model = buildTransitions(sampleBullTransitions());
  const edge = (id: string) => model.edges.find((e) => e.id === id);

  test("a (prev, event) pair becomes an edge from the previous state to the new one, counted", () => {
    expect(edge("waiting>active")).toMatchObject({ from: "waiting", to: "active", count: 990 });
    expect(edge("active>completed")).toMatchObject({ count: 930, tone: "good" });
    expect(edge("delayed>waiting")).toMatchObject({ count: 55 });
  });

  test("an event with no prev comes from the new-job node, and the same edge from several pairs is merged", () => {
    expect(edge("new>waiting")).toMatchObject({ from: "new", to: "waiting", count: 940 });
    const merged = buildTransitions({ pairs: [{ prev: null, event: "waiting", count: 2 }, { prev: "bogus", event: "waiting", count: 3 }] });
    expect(merged.edges).toEqual([expect.objectContaining({ id: "new>waiting", count: 5 })]);
  });

  test("the old name wait is waiting, and a self transition is dropped", () => {
    expect(normalizeState("wait")).toBe("waiting");
    expect(normalizeState("waitingChildren")).toBe("waiting-children");
    expect(normalizeState("nope")).toBeNull();
    expect(buildTransitions({ pairs: [{ prev: "wait", event: "active", count: 1 }, { prev: "active", event: "active", count: 9 }] }).edges).toHaveLength(1);
  });

  test("failures are red edges, stalled adds a red active→waiting edge and a badge", () => {
    expect(edge("active>failed")?.tone).toBe("bad");
    expect(edge("stalled")).toMatchObject({ from: "active", to: "waiting", count: 3, tone: "bad", stalled: true });
    expect(model.badges.active).toEqual([{ label: "정체", count: 3, tone: "bad" }]);
  });

  test("retries-exhausted is a badge on the failed node, added a badge on the new node", () => {
    expect(model.badges.failed).toEqual([{ label: "재시도 소진", count: 6, tone: "bad" }]);
    expect(model.badges.new).toEqual([{ label: "추가", count: 1000, tone: "warn" }]);
  });

  test("events that are not transitions are listed apart, most first", () => {
    expect(model.other).toEqual([{ event: "progress", count: 700 }]);
  });

  test("edges come most-counted first, and the width grows with the count on a log scale", () => {
    expect(model.edges[0].id).toBe("waiting>active");
    expect(edgeWidth(1, 1000)).toBeLessThan(edgeWidth(10, 1000));
    expect(edgeWidth(10, 1000)).toBeLessThan(edgeWidth(1000, 1000));
    expect(edgeWidth(1000, 1000)).toBeCloseTo(6, 5);
    expect(edgeWidth(5, 0)).toBe(1.5);
  });

  describe("window notes", () => {
    const base: KvBullTransitions = sampleBullTransitions();
    test("a full window has no note", () => {
      expect(windowNotes(base)).toEqual([]);
    });
    test("a stream that starts later than the window says how many minutes it covers", () => {
      expect(windowNotes({ ...base, firstAt: base.to - 22 * 60_000 })).toEqual([{ kind: "trimmed", minutes: 22 }]);
    });
    test("a first event within a minute of the start is the window, not a trim", () => {
      expect(windowNotes({ ...base, firstAt: base.from + 30_000 })).toEqual([]);
    });
    test("hitting the read cap and an empty stream each have their own note", () => {
      expect(windowNotes({ ...base, truncated: true })).toEqual([{ kind: "truncated", events: 5_000 }]);
      expect(windowNotes({ ...base, events: 0, firstAt: null })).toEqual([{ kind: "empty" }]);
    });
  });
});

describe("flow graph", () => {
  const flow = sampleBullFlow();

  test("parents are left of their children and every node is placed", () => {
    const layout = layoutFlow(flow);
    expect(layout.nodes).toHaveLength(4);
    const x = (key: string) => layout.nodes.find((n) => n.id === key)!.x;
    for (const child of ["bull:emails:185", "bull:payments:301", "bull:shipping:412"]) expect(x("bull:orders:77")).toBeLessThan(x(child));
    expect(layout.edges).toHaveLength(3);
  });

  test("states map to colours and edge statuses to line styles", () => {
    expect(flowNodeTone("completed")).toBe("good");
    expect(flowNodeTone("failed")).toBe("bad");
    expect(flowNodeTone("missing")).toBe("mute");
    expect(flowEdgeStyle("done")).toEqual({ tone: "good", dashed: false, dotted: false });
    expect(flowEdgeStyle("pending")).toMatchObject({ dashed: true });
    expect(flowEdgeStyle("ignored")).toMatchObject({ dotted: true });
    expect(flowEdgeStyle("failed").tone).toBe("bad");
  });

  test("labels name the queue and the id, and the states in Korean", () => {
    expect(flowNodeId({ queue: "emails", id: "185" })).toBe("emails · #185");
    expect(flowStateLabel("failed")).toBe("실패");
    expect(flowStateLabel("missing")).toBe("없음");
  });
});

describe("queue map", () => {
  const map = buildQueueMap(sampleBullTopology());

  test("one node per queue and one per worker host, with the workers counted", () => {
    expect(map.nodes.filter((n) => n.kind === "queue").map((n) => n.id)).toEqual(["q:orders", "q:emails", "q:payments", "q:reports"]);
    const hosts = map.nodes.flatMap((n) => (n.kind === "host" ? [n] : []));
    expect(hosts.map((h) => [h.host, h.workers, h.queues])).toEqual([["10.0.4.7", 1, ["orders"]], ["10.0.4.8", 2, ["emails", "orders"]], ["10.0.5.2", 1, ["payments"]]]);
  });

  test("parent → child links carry the job counts, and hosts link to the queues they work", () => {
    expect(map.edges.find((e) => e.id === "link:orders>emails")).toMatchObject({ from: queueNodeId("orders"), to: queueNodeId("emails"), value: 40, kind: "link" });
    expect(map.edges.find((e) => e.id === "worker:10.0.4.8>orders")).toMatchObject({ from: hostNodeId("10.0.4.8"), value: 1, kind: "worker" });
    expect(map.edges.filter((e) => e.kind === "worker")).toHaveLength(4);
  });

  test("a queue with waiting jobs and no worker is danger; others by backlog or pause", () => {
    const att = (name: string) => (map.nodes.find((n) => n.id === queueNodeId(name)) as { attention: string | null }).attention;
    expect(att("reports")).toBe("danger");
    expect(att("emails")).toBeNull();
    expect(mapAttention({ ...sampleBullTopology().queues[0].counts, wait: 2000 }, false, 3)).toBe("warn");
    expect(mapAttention({ ...sampleBullTopology().queues[0].counts, wait: 5 }, true, 0)).toBe("warn");
  });

  test("the health the cards computed wins over the guess from counts", () => {
    const m = buildQueueMap(sampleBullTopology(), new Map([["emails", "danger" as const]]));
    expect((m.nodes.find((n) => n.id === "q:emails") as { attention: string | null }).attention).toBe("danger");
  });

  test("when the workers cannot be read there are no hosts and worker counts are unknown", () => {
    const m = buildQueueMap(sampleBullTopology({ workers: null }));
    expect(m.workersKnown).toBe(false);
    expect(m.nodes.every((n) => n.kind === "queue")).toBe(true);
    expect((m.nodes[0] as { workers: number | null }).workers).toBeNull();
  });

  test("links to unknown queues are dropped", () => {
    const m = buildQueueMap(sampleBullTopology({ links: [{ from: "orders", to: "ghost", jobs: 1 }] }));
    expect(m.edges.filter((e) => e.kind === "link")).toHaveLength(0);
  });
});

describe("cluster topology", () => {
  const client = (node: string, addr: string, own = false): KvClient => ({ ...clientRows[0], node, addr, own });
  const shardNodes: KvNode[] = [
    { id: "a1", address: "a1:6379", role: "primary", shard: "0001", slots: "0-8191" },
    { id: "a2", address: "a2:6379", role: "replica", shard: "0001", slots: null },
    { id: "b1", address: "b1:6379", role: "primary", shard: "0002", slots: "8192-16383" },
    { id: "b2", address: "b2:6379", role: "replica", shard: "0002", slots: null },
  ];
  const ov = sampleOverview({
    mode: "cluster",
    nodes: shardNodes,
    info: [nodeInfo("a1:6379"), nodeInfo("a2:6379", { role: "slave", replicationLagSeconds: 2 }), nodeInfo("b1:6379"), nodeInfo("b2:6379", { role: "slave", replicationLagSeconds: 0 })],
  });

  test("shards are groups with the primary first, slots on the primary and the lag on the replica", () => {
    const t = buildClusterTopology(ov, []);
    expect(t.groups.map((g) => [g.label, g.nodes.map((n) => n.address)])).toEqual([["샤드 0001", ["a1:6379", "a2:6379"]], ["샤드 0002", ["b1:6379", "b2:6379"]]]);
    expect(t.groups[0].nodes[0]).toMatchObject({ role: "primary", slots: "0-8191", lagSeconds: null, maxMemory: 1024 * 1024 * 1024 });
    expect(t.groups[0].nodes[1]).toMatchObject({ role: "replica", lagSeconds: 2 });
  });

  test("a standalone cache is one replication group, and serverless is one node", () => {
    expect(buildClusterTopology(sampleOverview(), []).groups.map((g) => [g.label, g.nodes.length])).toEqual([["복제 그룹", 3]]);
    const s = buildClusterTopology(serverlessOverview(), null);
    expect(s.groups.map((g) => [g.label, g.nodes.length])).toEqual([["서버리스", 1]]);
  });

  test("client hosts are grouped by address without the port, with connections per node", () => {
    const t = buildClusterTopology(ov, [client("a1:6379", "10.0.4.7:5001"), client("a1:6379", "10.0.4.7:5002"), client("b1:6379", "10.0.4.7:5003"), client("a2:6379", "10.0.4.8:6000", true)]);
    expect(t.clientsKnown).toBe(true);
    expect(t.hosts.map((h) => [h.label, h.connections, h.own])).toEqual([["10.0.4.7", 3, false], ["10.0.4.8", 1, true]]);
    expect(t.hosts[0].links).toEqual([{ node: "a1:6379", count: 2 }, { node: "b1:6379", count: 1 }]);
    expect(t.groups[0].nodes[0].connections).toBe(2);
  });

  test("only the busiest 20 hosts are drawn; the rest fold into one node with their links added", () => {
    const many = Array.from({ length: 25 }, (_, i) => client(i % 2 ? "a1:6379" : "b1:6379", `10.1.0.${i}:1000`));
    const heavy = Array.from({ length: 5 }, (_, i) => client("a1:6379", `10.9.9.9:${i}`));
    const t = buildClusterTopology(ov, [...many, ...heavy]);
    expect(t.hosts).toHaveLength(TOP_HOSTS + 1);
    expect(t.hosts[0]).toMatchObject({ label: "10.9.9.9", connections: 5 });
    const rest = t.hosts[TOP_HOSTS];
    expect(rest).toMatchObject({ id: "host:*", label: "기타 6호스트", folded: 6, connections: 6 });
    expect(rest.links.reduce((s, l) => s + l.count, 0)).toBe(6);
  });

  test("without the client list there are no hosts, and the nodes say nothing about connections", () => {
    const t = buildClusterTopology(ov, null);
    expect(t).toMatchObject({ hosts: [], clientsKnown: false });
    expect(t.groups[0].nodes[0].connections).toBeNull();
  });

  test("hostOf takes the port off IPv4, IPv6 in brackets and bare hosts", () => {
    expect(hostOf("10.0.4.7:51000")).toBe("10.0.4.7");
    expect(hostOf("[::1]:5000")).toBe("::1");
    expect(hostOf("fe80::1")).toBe("fe80::1");
    expect(hostOf("host")).toBe("host");
  });

  test("the node list of the fixtures is a primary and two replicas", () => {
    expect(standaloneNodes.map((n) => n.role)).toEqual(["primary", "replica", "replica"]);
  });
});
