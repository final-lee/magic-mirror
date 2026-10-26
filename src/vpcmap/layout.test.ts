import { layoutTopology, MAX_TILES } from "./layout";
import { node, sampleTopology, subnet } from "./fixtures";

const overlap = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test("places subnets in AZ columns and tier rows without overlap", () => {
  const l = layoutTopology(sampleTopology());
  const by = Object.fromEntries(l.subnets.map((s) => [s.subnet.id, s]));
  expect(by["subnet-pub-a"].x).toBe(by["subnet-prv-a"].x);
  expect(by["subnet-pub-c"].x).toBeGreaterThan(by["subnet-pub-a"].x);
  expect(by["subnet-pub-a"].y).toBe(by["subnet-pub-c"].y);
  expect(by["subnet-prv-a"].y).toBeGreaterThan(by["subnet-pub-a"].y + by["subnet-pub-a"].h);
  const boxes = l.subnets;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j])).toBe(false);
  for (const s of boxes) {
    expect(s.x).toBeGreaterThanOrEqual(l.vpc.x);
    expect(s.x + s.w).toBeLessThanOrEqual(l.vpc.x + l.vpc.w);
    expect(s.y + s.h).toBeLessThanOrEqual(l.vpc.y + l.vpc.h);
  }
  expect(l.width).toBeGreaterThanOrEqual(l.vpc.x + l.vpc.w);
  expect(l.height).toBeGreaterThanOrEqual(l.vpc.y + l.vpc.h);
});

test("omits empty tier rows and orders them public → private → isolated", () => {
  const t = sampleTopology();
  t.subnets.push(subnet("subnet-iso-a", "ap-northeast-2a", "isolated"));
  expect(layoutTopology(t).lanes.map((x) => x.tier)).toEqual(["public", "private", "isolated"]);
  t.subnets = t.subnets.filter((s) => s.tier !== "public");
  expect(layoutTopology(t).lanes.map((x) => x.tier)).toEqual(["private", "isolated"]);
});

test("stacks multiple subnets in one cell vertically", () => {
  const t = sampleTopology();
  t.subnets.push(subnet("subnet-pub-a2", "ap-northeast-2a", "public", "10.0.2.0/24"));
  const l = layoutTopology(t);
  const a = l.subnets.find((s) => s.subnet.id === "subnet-pub-a")!;
  const a2 = l.subnets.find((s) => s.subnet.id === "subnet-pub-a2")!;
  expect(a2.x).toBe(a.x);
  expect(a2.y).toBeGreaterThanOrEqual(a.y + a.h);
});

test("collapses more than 12 tiles into 11 plus a +N tile", () => {
  const t = sampleTopology();
  t.resources = Array.from({ length: 15 }, (_, i) => node(`i-${i}`, "ec2", ["subnet-prv-a"], { name: `n${i}` }));
  const s = layoutTopology(t).subnets.find((x) => x.subnet.id === "subnet-prv-a")!;
  expect(s.tiles).toHaveLength(MAX_TILES);
  expect(s.tiles.filter((x) => x.resource).length).toBe(MAX_TILES - 1);
  expect(s.tiles[MAX_TILES - 1].overflow).toBe(15 - (MAX_TILES - 1));
  const exactly12 = Array.from({ length: 12 }, (_, i) => node(`j-${i}`, "ec2", ["subnet-prv-a"]));
  t.resources = exactly12;
  expect(layoutTopology(t).subnets.find((x) => x.subnet.id === "subnet-prv-a")!.tiles.every((x) => x.resource)).toBe(true);
});

test("a multi-subnet resource gets a tile in every subnet", () => {
  const l = layoutTopology(sampleTopology());
  const withAlb = l.subnets.filter((s) => s.tiles.some((t) => t.resource?.id === "alb-1")).map((s) => s.subnet.id);
  expect(withAlb.sort()).toEqual(["subnet-pub-a", "subnet-pub-c"]);
});

test("tiles stay inside their subnet", () => {
  for (const s of layoutTopology(sampleTopology()).subnets)
    for (const t of s.tiles) {
      expect(t.x).toBeGreaterThanOrEqual(s.x);
      expect(t.x + t.w).toBeLessThanOrEqual(s.x + s.w);
      expect(t.y + t.h).toBeLessThanOrEqual(s.y + s.h);
    }
});

test("gateway chips: igw on the top border, endpoints and peerings in the bottom band", () => {
  const l = layoutTopology(sampleTopology());
  const igw = l.chips.find((c) => c.id === "igw-1")!;
  expect(igw.band).toBe("top");
  expect(igw.y + igw.h / 2).toBe(l.vpc.y);
  const s3 = l.chips.find((c) => c.id === "vpce-s3")!;
  const pcx = l.chips.find((c) => c.id === "pcx-1")!;
  expect(l.band).not.toBeNull();
  for (const c of [s3, pcx]) {
    expect(c.band).toBe("bottom");
    expect(c.y).toBeGreaterThanOrEqual(l.band!.y);
    expect(c.y + c.h).toBeLessThanOrEqual(l.band!.y + l.band!.h);
  }
  expect(overlap(s3, pcx)).toBe(false);
  expect(pcx.text).toContain("vpc-peer");
});

test("no bottom band without endpoints or peerings", () => {
  const t = sampleTopology();
  t.gateways = [];
  t.peerings = [];
  expect(layoutTopology(t).band).toBeNull();
});

test("legend sits inside the VPC bounds, bottom-right, below the content", () => {
  const l = layoutTopology(sampleTopology());
  const g = l.legend;
  expect(g.items.map((i) => i.key)).toEqual(["public", "private", "isolated", "route"]);
  expect(g.x).toBeGreaterThanOrEqual(l.vpc.x);
  expect(g.x + g.w).toBeLessThanOrEqual(l.vpc.x + l.vpc.w);
  expect(g.y + g.h).toBeLessThanOrEqual(l.vpc.y + l.vpc.h);
  for (const c of l.chips) expect(overlap(g, c)).toBe(false);
  for (const s of l.subnets) expect(overlap(g, s)).toBe(false);
  if (l.band) expect(overlap(g, l.band)).toBe(false);
  expect(g.x + g.w).toBeGreaterThan(l.vpc.x + l.vpc.w - 40);
});
