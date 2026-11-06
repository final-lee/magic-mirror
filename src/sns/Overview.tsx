import type { ReactNode } from "react";
import type { SnsTopic } from "./types";
import * as t from "./text";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="sns-section" aria-label={title}>
      <h4 className="sns-heading">{title}</h4>
      {children}
    </section>
  );
}

const Lines = ({ lines }: { lines: string[] }) => (
  <ul className="sns-sentences">
    {lines.map((line) => (
      <li key={line}>{line}</li>
    ))}
  </ul>
);

/** 개요: 주제 속성을 풀어 쓴 문장. 암호화, FIFO, 아카이브, 서명·추적, 배달 상태 로깅, HTTP 배달 정책, 데이터 보호 정책, 태그 */
export function Overview({ topic, onShowRaw }: { topic: SnsTopic; onShowRaw: () => void }) {
  const o = topic.overview;
  const tags = Object.entries(topic.tags);
  return (
    <section className="center sns-pane" aria-label={t.OVERVIEW_LABEL}>
      <div className="sns-pane-head">
        <button className="btn small tone-secondary" onClick={onShowRaw}>
          {t.SHOW_RAW}
        </button>
      </div>

      <Section title={t.SECTION_GENERAL}>
        <Lines lines={[t.kindSentence(topic.fifo), t.subscriptionCounts(o.confirmedCount, o.pendingCount, o.deletedCount), ...(o.displayName ? [t.displayNameSentence(o.displayName)] : [])]} />
      </Section>

      <Section title={t.SECTION_ENCRYPTION}>
        <Lines lines={[t.encryptionSentence(topic)]} />
      </Section>

      {topic.fifo && (
        <>
          <Section title={t.SECTION_FIFO}>
            <Lines lines={t.fifoSentences(topic)} />
          </Section>
          <Section title={t.SECTION_ARCHIVE}>
            <Lines lines={t.archiveSentences(topic)} />
          </Section>
        </>
      )}

      <Section title={t.SECTION_SECURITY}>
        <Lines lines={[t.signatureSentence(o.signatureVersion), t.tracingSentence(o.tracing)]} />
      </Section>

      <Section title={t.SECTION_LOGGING}>
        <ul className="sns-sentences">
          {o.deliveryLogging.map((l) => {
            const s = t.loggingSentence(l);
            return (
              <li key={l.protocol}>
                <b>{s.protocol}</b>: <span className={s.on ? undefined : "dim"}>{s.text}</span>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title={t.SECTION_HTTP}>
        {o.httpDeliveryPolicy.length === 0 ? (
          <p className="sns-note dim">{t.HTTP_POLICY_EMPTY}</p>
        ) : (
          <table className="sns-table" aria-label={t.SECTION_HTTP}>
            <thead>
              <tr>
                <th scope="col" className="nosort">
                  {t.HTTP_POLICY_COLS.item}
                </th>
                <th scope="col" className="nosort">
                  {t.HTTP_POLICY_COLS.value}
                </th>
              </tr>
            </thead>
            <tbody>
              {o.httpDeliveryPolicy.map((row) => (
                <tr key={row.key} title={row.key}>
                  <td>{t.httpPolicyLabel(row)}</td>
                  <td className="mono">{row.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title={t.SECTION_DATA_PROTECTION}>
        <Lines lines={[topic.dataProtectionPolicy ? t.dataProtectionSentence(topic.dataProtectionPolicy) : t.DATA_PROTECTION_NONE]} />
      </Section>

      <Section title={t.SECTION_TAGS}>
        {tags.length === 0 ? (
          <p className="sns-note dim">{t.NO_TAGS}</p>
        ) : (
          <div>
            {tags.map(([k, v]) => (
              <span className="tag" key={k}>
                {k}={v}
              </span>
            ))}
          </div>
        )}
      </Section>
    </section>
  );
}
