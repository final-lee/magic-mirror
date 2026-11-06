import type { Finding, Gap, StreamSpec } from "../types";

export interface Esm { id: string; function: string; state: string; batchSize: number | null; startingPosition: string | null; parallelization: number | null; bisect: boolean | null; retries: number | null; maxAge: number | null; failureDestination: string | null; filters: string[]; iteratorAgeMs: number | null }
export interface Connections { stream: StreamSpec | null; esms: Esm[]; pipes: { name: string; state: string; target: string }[]; kinesis: { arn: string; state: string; precision: string | null }[]; replicas: { region: string; status: string; class: string | null; latencyMs: number | null }[]; gaps: Gap[]; findings: Finding[] }
export interface StreamRecord { id: string; event: string; time: number | null; keys: Record<string, unknown> | null; size: number | null; oldImage: Record<string, unknown> | null; newImage: Record<string, unknown> | null }
export interface StreamPoll { records: StreamRecord[]; shards: number; behind: number }
