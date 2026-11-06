import { invoke } from "../../api/invoke";
import type { Connections, StreamPoll } from "./types";

export const streamApi = {
  connections: (profile: string, region: string, table: string) => invoke<Connections>("dynamo_connections", { profile, region, table }),
  start: (profile: string, region: string, table: string, from: string) => invoke<{ streamId: string }>("dynamo_stream_start", { profile, region, table, from }),
  poll: (streamId: string) => invoke<StreamPoll>("dynamo_stream_poll", { streamId }),
  stop: (streamId: string) => invoke<void>("dynamo_stream_stop", { streamId }),
};
