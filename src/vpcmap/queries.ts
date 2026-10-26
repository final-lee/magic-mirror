import { useQuery } from "@tanstack/react-query";
import { vpcApi } from "./api";

export const topologyKey = (profile: string, region: string, vpcId: string) => ["vpc-topology", profile, region, vpcId] as const;

export function useVpcTopology(profile: string, region: string, vpcId: string) {
  return useQuery({
    queryKey: topologyKey(profile, region, vpcId),
    queryFn: () => vpcApi.topology(profile, region, vpcId),
    staleTime: Infinity,
    retry: false,
  });
}
