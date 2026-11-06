import type { ReactNode } from "react";
import { desktop } from "../api/desktop";
import { formatDateTime } from "../iam/format";
import { MacControls } from "./MacControls";
import * as m from "./macControlsText";
import * as t from "./text";
import type { TsNode } from "./types";

export const value = (s: string | null | undefined) => s || t.UNKNOWN;

/** 이 Mac 노드의 상태와 연결·설정 조작. */
export function MacView({ node }: { node: TsNode }) {
  const keyExpiry = node.self?.keyExpiry;
  const rows: [string, ReactNode][] = [
    [
      t.BACKEND_STATE,
      <>
        <span title={value(node.backendState)}>{t.backendState(node.backendState)}</span>
        {node.health.map((warning, i) => (
          <div className="err" key={i}>
            {warning}
          </div>
        ))}
      </>,
    ],
    [t.TAILNET, value(node.tailnet)],
    [t.MAGIC_DNS, value(node.magicDnsSuffix)],
    [t.USER, value(node.user)],
    [t.DEVICE_NAME, value(node.self?.hostName)],
    [t.DNS_NAME, value(node.self?.dnsName)],
    [
      t.IPS,
      node.self?.ips.length
        ? node.self.ips.map((ip) => (
            <div key={ip}>
              {ip}{" "}
              <button className="btn small tone-secondary" aria-label={`${t.COPY_IP}: ${ip}`} onClick={() => void desktop.copy(ip)}>
                복사
              </button>
            </div>
          ))
        : t.UNKNOWN,
    ],
    [t.CLI_VERSION, value(node.version)],
    [t.CLI_PATH, <span className="mono">{value(node.cli)}</span>],
    [t.KEY_EXPIRY, keyExpiry ? <span title={keyExpiry}>{formatDateTime(keyExpiry)}</span> : t.UNKNOWN],
  ];
  return (
    <>
      <div className="awc-bar"><h2 className="awc-title">{t.TAB_MAC}</h2></div>
      <div className="awc-scroll">
        <div className="awc-body">
          <section className="ts-sec">
            <h3>{m.SEC_STATUS}</h3>
            <p className="ts-desc">{m.SEC_STATUS_DESC}</p>
            <dl className="ts-details">
              {rows.map(([label, content]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{content}</dd>
                </div>
              ))}
            </dl>
          </section>
          <MacControls tailnet={node.tailnet ?? ""} />
        </div>
      </div>
    </>
  );
}
