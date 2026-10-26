import type { NodeResource, SubnetInfo, VpcTopology } from "./types";

export const subnet = (id: string, az: string, tier: SubnetInfo["tier"], cidr = "10.0.0.0/24", extra: Partial<SubnetInfo> = {}): SubnetInfo => ({
  id, name: id, az, cidr, tier, routeTableId: null, availableIps: 200, tags: {}, ...extra,
});
export const node = (id: string, kind: NodeResource["kind"], subnetIds: string[], extra: Partial<NodeResource> = {}): NodeResource => ({
  id, name: id, kind, subnetIds, state: "running", fields: [], consoleUrl: null, ...extra,
});

export function sampleTopology(): VpcTopology {
  return {
    vpc: { id: "vpc-1", name: "prod", cidrs: ["10.0.0.0/16"], isDefault: false, state: "available" },
    azs: ["ap-northeast-2a", "ap-northeast-2c"],
    subnets: [
      subnet("subnet-pub-a", "ap-northeast-2a", "public", "10.0.0.0/24", { name: "pub-a", routeTableId: "rtb-pub" }),
      subnet("subnet-pub-c", "ap-northeast-2c", "public", "10.0.1.0/24", { name: "pub-c", routeTableId: "rtb-pub" }),
      subnet("subnet-prv-a", "ap-northeast-2a", "private", "10.0.10.0/24", { name: "prv-a", routeTableId: "rtb-prv" }),
      subnet("subnet-prv-c", "ap-northeast-2c", "private", "10.0.11.0/24", { name: "prv-c", routeTableId: "rtb-prv" }),
    ],
    routeTables: [
      {
        id: "rtb-pub", name: "public-rt", main: false, subnetIds: ["subnet-pub-a", "subnet-pub-c"],
        routes: [
          { destination: "10.0.0.0/16", target: "local", targetKind: "local", state: "active" },
          { destination: "0.0.0.0/0", target: "igw-1", targetKind: "igw", state: "active" },
        ],
      },
      {
        id: "rtb-prv", name: "private-rt", main: true, subnetIds: [],
        routes: [
          { destination: "10.0.0.0/16", target: "local", targetKind: "local", state: "active" },
          { destination: "0.0.0.0/0", target: "nat-1", targetKind: "nat", state: "active" },
        ],
      },
    ],
    gateways: [
      { id: "igw-1", name: "prod-igw", kind: "igw", label: "", state: "available" },
      { id: "vpce-s3", name: "s3", kind: "vpce-gateway", label: "S3", state: "available" },
    ],
    peerings: [{ id: "pcx-1", peerVpcId: "vpc-peer", peerCidr: "10.1.0.0/16", peerOwnerId: null, peerRegion: null, status: "active" }],
    resources: [
      node("alb-1", "elb", ["subnet-pub-a", "subnet-pub-c"], { name: "web-alb", fields: [{ label: "Scheme", value: "internet-facing" }] }),
      node("nat-1", "nat", ["subnet-pub-a"], { name: "nat-a" }),
      node("i-1", "ec2", ["subnet-prv-a"], { name: "api-1", fields: [{ label: "Private IP", value: "10.0.10.5" }], consoleUrl: "https://console/i-1" }),
    ],
    warnings: [],
  };
}
