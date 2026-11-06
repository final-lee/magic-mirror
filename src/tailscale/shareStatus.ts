import type { ShareRequest } from "./shareTypes";

/** `serve status --json` / `funnel status --json`의 한 줄(주소·경로 하나). */
export interface ServeRow {
  key: string;
  host: string;
  port: string;
  path: string;
  proto: "HTTPS" | "HTTP" | "TCP" | "TLS-TCP";
  kind: "proxy" | "path" | "text" | "redirect" | "tcp" | "tls-tcp" | "none";
  target: string;
  funnel: boolean;
  /** `svc:이름`이면 Service에 걸린 경로. */
  service: string;
  /** 포그라운드로 실행 중인 임시 세션의 경로. */
  foreground: boolean;
}

interface Handler { Proxy?: string; Path?: string; Text?: string; Redirect?: string }
interface PortHandler { HTTPS?: boolean; HTTP?: boolean; TCPForward?: string; TerminateTLS?: string }
interface Config {
  TCP?: Record<string, PortHandler>;
  Web?: Record<string, { Handlers?: Record<string, Handler> }>;
  AllowFunnel?: Record<string, boolean>;
  Services?: Record<string, Config>;
  Foreground?: Record<string, Config>;
}

const handlerTarget = (handler: Handler): Pick<ServeRow, "kind" | "target"> => {
  if (handler.Proxy !== undefined) return { kind: "proxy", target: handler.Proxy };
  if (handler.Path !== undefined) return { kind: "path", target: handler.Path };
  if (handler.Text !== undefined) return { kind: "text", target: handler.Text };
  if (handler.Redirect !== undefined) return { kind: "redirect", target: handler.Redirect };
  return { kind: "none", target: "" };
};

function collect(config: Config, service: string, foreground: boolean, rows: Map<string, ServeRow>) {
  const funnelOn = (port: string) =>
    Object.entries(config.AllowFunnel ?? {}).some(([hostPort, on]) => on && hostPort.endsWith(`:${port}`));
  const webPorts = new Set<string>();
  let anyHost = "";
  for (const [hostPort, web] of Object.entries(config.Web ?? {})) {
    const cut = hostPort.lastIndexOf(":");
    const host = cut < 0 ? hostPort : hostPort.slice(0, cut);
    const port = cut < 0 ? "" : hostPort.slice(cut + 1);
    webPorts.add(port);
    anyHost ||= host;
    for (const [path, handler] of Object.entries(web.Handlers ?? {})) {
      const key = `${service}|${foreground}|${host}|${port}|${path}`;
      const row: ServeRow = {
        key, host, port, path,
        proto: config.TCP?.[port]?.HTTP ? "HTTP" : "HTTPS",
        ...handlerTarget(handler),
        funnel: funnelOn(port),
        service,
        foreground,
      };
      const old = rows.get(key);
      rows.set(key, old ? { ...old, funnel: old.funnel || row.funnel } : row);
    }
  }
  for (const [port, handler] of Object.entries(config.TCP ?? {})) {
    if (webPorts.has(port) || (!handler.TCPForward && !handler.TerminateTLS)) continue;
    const key = `${service}|${foreground}|tcp|${port}`;
    const row: ServeRow = {
      key, host: anyHost, port, path: "",
      proto: handler.TerminateTLS ? "TLS-TCP" : "TCP",
      kind: handler.TerminateTLS ? "tls-tcp" : "tcp",
      target: handler.TCPForward ?? "",
      funnel: funnelOn(port),
      service,
      foreground,
    };
    const old = rows.get(key);
    rows.set(key, old ? { ...old, funnel: old.funnel || row.funnel } : row);
  }
  for (const [name, inner] of Object.entries(config.Services ?? {})) collect(inner, name, foreground, rows);
  for (const inner of Object.values(config.Foreground ?? {})) collect(inner, service, true, rows);
}

/**
 * Serve·Funnel 상태 JSON들을 합쳐 주소별 표로 만든다. Funnel 열은 어느 쪽 설정이든 `AllowFunnel`이 켜져 있으면 켜짐.
 * JSON이 아니면 null.
 */
export function parseServeStatus(...texts: (string | undefined)[]): ServeRow[] | null {
  const rows = new Map<string, ServeRow>();
  let parsed = false;
  for (const text of texts) {
    if (!text?.trim()) continue;
    try {
      const config: unknown = JSON.parse(text);
      if (!config || typeof config !== "object" || Array.isArray(config)) return null;
      collect(config as Config, "", false, rows);
      parsed = true;
    } catch { return null; }
  }
  return parsed ? [...rows.values()] : [];
}

/** 표 한 줄을 지우거나 Funnel을 끄는 명령 요청. 앱이 만들 수 없는 모양(HTTP·TLS-TCP·포그라운드)은 null. */
export function rowRequest(row: ServeRow, scope: "serve" | "funnel"): ShareRequest | null {
  if (row.foreground || row.proto === "HTTP" || row.proto === "TLS-TCP" || !row.port) return null;
  if (scope === "funnel" && row.service) return null;
  return {
    action: "mapping-off",
    target: "",
    port: row.port,
    mode: row.proto === "TCP" ? "tcp" : "https",
    path: row.path === "/" ? "" : row.path,
    service: row.service || (scope === "funnel" ? "funnel" : ""),
  };
}

export interface Taildrop { ip: string; name: string; status: string }
/** `tailscale file cp --targets` 출력(`IP<탭>이름<탭>상태`). */
export function parseTargets(text: string): Taildrop[] {
  return text.split("\n").flatMap((line) => {
    const [ip, name, ...rest] = line.split("\t");
    return ip?.trim() && name?.trim() ? [{ ip: ip.trim(), name: name.trim(), status: rest.join(" ").trim() }] : [];
  });
}

export interface ServiceItem { name: string; hostname: string; addrs: string[]; ports: string[] }
/** `tailscale service list --json`. 모양이 다르면 null. */
export function parseServices(text: string): ServiceItem[] | null {
  try {
    const list: unknown = JSON.parse(text);
    if (!Array.isArray(list)) return null;
    return list.flatMap((item: Record<string, unknown>) => typeof item?.Name === "string" ? [{
      name: item.Name,
      hostname: typeof item.Hostname === "string" ? item.Hostname : "",
      addrs: Array.isArray(item.Addrs) ? item.Addrs.map(String) : [],
      ports: Array.isArray(item.Ports) ? item.Ports.map(String) : [],
    }] : []);
  } catch { return null; }
}
