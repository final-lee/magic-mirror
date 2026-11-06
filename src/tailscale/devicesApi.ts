export interface Device {
  id: string; name: string; hostname?: string; os?: string; addresses?: string[]; user?: string;
  tags?: string[]; authorized?: boolean; lastSeen?: string; expires?: string;
  keyExpiryDisabled?: boolean; updateAvailable?: boolean; clientVersion?: string;
  advertisedRoutes?: string[]; enabledRoutes?: string[]; connectedToControl?: boolean;
  isExternal?: boolean; postureIdentity?: { serialNumber?: string }; findings: string[];
}
export interface PreviewItem { device: Device; method: string; path: string; body: unknown; action: string }
export interface Preview { items: PreviewItem[] }
export interface ResultItem { id: string; name: string; ok: boolean; error: string | null }
export interface Change { id: string; at: string; action: string; target: { deviceId?: string; name?: string }; summary: string; before: unknown; after: unknown; undone: boolean; undoOf?: string }
