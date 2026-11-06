export interface Backup { arn: string; name: string; status: string; size: number | null; createdAt: string | null }
export interface Export { arn: string; status: string; bucket: string | null; prefix: string | null; size: number | null; createdAt: string | null; error: string | null }
