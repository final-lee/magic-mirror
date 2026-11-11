import type { ReactNode } from "react";
import type { SnsTopic } from "./types";
import * as t from "./text";
import { ArchiveEditor } from "./ReplayControls";
import type { SnsTopicRef } from "./targets";
import { LoggingEdit, TopicDeliveryEdit } from "./OverviewEdits";

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <section className="sns-section" aria-label={title}>
    <div className="sns-section-head"><h4 className="sns-heading">{title}</h4>{action}</div>
    {children}
  </section>;
}

function Values({ rows }: { rows: [string, ReactNode][] }) {
  return <dl className="sns-values">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function Value({ value, note, warn }: t.OverviewValue) {
  return <>{value}{note && <> <span className={warn ? "sns-value-warning" : "dim"}>{note}</span></>}</>;
}

/** 주제 속성과 배달 설정 */
export function Overview({ topic, onShowRaw, target }: { topic: SnsTopic; onShowRaw: () => void; target?: SnsTopicRef }) {
  const o = topic.overview;
  const tags = Object.entries(topic.tags);
  const fifo = t.fifoValues(topic);
  const archive = t.archiveValues(topic);
  return <section className="center sns-pane" aria-label={t.OVERVIEW_LABEL}>
    <Section title={t.SECTION_GENERAL} action={<button className="btn small tone-secondary" onClick={onShowRaw}>{t.SHOW_RAW}</button>}>
      <Values rows={[["유형", <Value {...t.kindValue(topic.fifo)} />], ["구독", t.subscriptionValue(o.confirmedCount, o.pendingCount, o.deletedCount)], ...(o.displayName ? [["표시 이름", <>{o.displayName} <span className="dim">SMS·이메일 발신자 이름으로 쓰여요</span></>] as [string, ReactNode]] : [])]} />
    </Section>
    <Section title={t.SECTION_ENCRYPTION}><Values rows={[["서버 측 암호화", <Value {...t.encryptionValue(topic)} />]]} /></Section>
    {topic.fifo && <>
      <Section title={t.SECTION_FIFO}><Values rows={[["내용 기반 중복 제거", <Value {...fifo[0]} />], ["처리량 범위", <Value {...fifo[1]} />]]} /></Section>
      <Section title={t.SECTION_ARCHIVE} action={target && <ArchiveEditor topic={topic} target={target} />}>
        <Values rows={[["보존 기간", archive[0]], ...(archive[1] ? [["보관 시작", archive[1]] as [string, ReactNode]] : [])]} />
      </Section>
    </>}
    <Section title={t.SECTION_SECURITY}><Values rows={[["서명", <Value {...t.signatureValue(o.signatureVersion)} />], ["X-Ray 추적", <Value {...t.tracingValue(o.tracing)} />]]} /></Section>
    <Section title={t.SECTION_LOGGING} action={target && <LoggingEdit target={target} logging={o.deliveryLogging} />}>
      <table className="sns-table" aria-label={t.SECTION_LOGGING}>
        <thead><tr>{["프로토콜", "성공 로그 역할", "실패 로그 역할", "표본 비율"].map((label) => <th scope="col" className="nosort" key={label}>{label}</th>)}</tr></thead>
        <tbody>{o.deliveryLogging.map((logging) => <tr key={logging.protocol}>
          <td>{t.loggingSentence(logging).protocol}</td>
          <td className={logging.successRole ? "mono" : "dim"} title={logging.successRole ?? undefined}>{logging.successRole?.split("/").pop() ?? "꺼짐"}</td>
          <td className={logging.failureRole ? "mono" : "dim"} title={logging.failureRole ?? undefined}>{logging.failureRole?.split("/").pop() ?? "꺼짐"}</td>
          <td>{logging.sampleRate === null ? "–" : `${logging.sampleRate}%`}</td>
        </tr>)}</tbody>
      </table>
    </Section>
    <Section title={t.SECTION_HTTP}>
      {o.httpDeliveryPolicy.length === 0 ? <p className="sns-note dim">{t.HTTP_POLICY_EMPTY}</p> : <table className="sns-table" aria-label={t.SECTION_HTTP}>
        <thead><tr><th scope="col" className="nosort">{t.HTTP_POLICY_COLS.item}</th><th scope="col" className="nosort">{t.HTTP_POLICY_COLS.value}</th></tr></thead>
        <tbody>{o.httpDeliveryPolicy.map((row) => <tr key={row.key} title={row.key}><td>{t.httpPolicyLabel(row)}</td><td className="mono">{row.value}</td></tr>)}</tbody>
      </table>}
      {target && <TopicDeliveryEdit target={target} topic={topic} />}
    </Section>
    <Section title={t.SECTION_DATA_PROTECTION}><p className="sns-note">{topic.dataProtectionPolicy ? t.dataProtectionSentence(topic.dataProtectionPolicy) : topic.fifo ? t.DATA_PROTECTION_FIFO : t.DATA_PROTECTION_NONE}</p></Section>
    <Section title={t.SECTION_TAGS}>{tags.length === 0 ? <p className="sns-note dim">{t.NO_TAGS}</p> : <div className="sns-tag-list">{tags.map(([key, value]) => <span className="tag" key={key}>{key}={value}</span>)}</div>}</Section>
  </section>;
}
