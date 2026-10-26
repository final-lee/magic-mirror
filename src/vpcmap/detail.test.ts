import { defaultRouteTargets, gatewayMatchesTarget, subnetDetail } from "./detail";
import { sampleTopology } from "./fixtures";
import type { GatewayInfo } from "./types";

const gw = (o: Partial<GatewayInfo>): GatewayInfo => ({ id: "x", name: "", kind: "igw", label: "", state: "available", ...o });

test("defaultRouteTargets ignores empty targets", () => {
  const t = sampleTopology();
  t.routeTables[0].routes.push({ destination: "::/0", target: "", targetKind: "other", state: "active" });
  const s = t.subnets.find((x) => x.id === "subnet-pub-a")!;
  expect(defaultRouteTargets(t, s)).toEqual(["igw-1"]);
});

test("gatewayMatchesTarget is exact, not substring", () => {
  expect(gatewayMatchesTarget(gw({ id: "igw-1" }), "igw-1")).toBe(true);
  expect(gatewayMatchesTarget(gw({ id: "igw-10" }), "igw-1")).toBe(false);
  expect(gatewayMatchesTarget(gw({ id: "igw-1" }), "")).toBe(false);
  expect(gatewayMatchesTarget(gw({ id: "tgw-attach-1", kind: "tgw", label: "tgw-1", name: "tgw-1" }), "tgw-1")).toBe(true);
  expect(gatewayMatchesTarget(gw({ id: "tgw-attach-1", kind: "tgw", label: "tgw-12", name: "my tgw-1 attach" }), "tgw-1")).toBe(false);
});

test("subnet route rows use destination as label and disambiguate duplicates", () => {
  const t = sampleTopology();
  t.routeTables[0].routes.push({ destination: "0.0.0.0/0", target: "nat-9", targetKind: "nat", state: "blackhole" });
  const s = t.subnets.find((x) => x.id === "subnet-pub-a")!;
  const rows = subnetDetail(t, s).rows;
  expect(rows).toContainEqual({ label: "0.0.0.0/0", value: "igw-1 (active)" });
  expect(rows).toContainEqual({ label: "0.0.0.0/0 (2)", value: "nat-9 (blackhole)" });
  expect(rows).toContainEqual({ label: "10.0.0.0/16", value: "local (active)" });
});
