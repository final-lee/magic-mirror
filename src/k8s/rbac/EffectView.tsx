import { SubjectName } from "../access/paths";
import type { Subject } from "../access/types";
import * as t from "./text";
import type { RbacCapability, RbacEffect, RbacSubjectEffect } from "./types";

const sameSubject = (a: Subject, b: Subject) => a.kind === b.kind && a.name === b.name && a.namespace === b.namespace;

function Capabilities({ items, sign, cls }: { items: RbacCapability[]; sign: string; cls: string }) {
  if (items.length === 0) return null;
  return (
    <ul className={cls}>
      {items.map((c, i) => (
        <li key={i}>
          <span className="cp-sign">{sign}</span>
          <span className="mono">{t.capabilityText(c.verbs, c.resource, c.group, c.namespace)}</span>
        </li>
      ))}
    </ul>
  );
}

function UrlCapabilities({ items, sign, cls }: { items: { url: string; verbs: string[] }[]; sign: string; cls: string }) {
  if (items.length === 0) return null;
  return (
    <ul className={cls}>
      {items.map((c) => (
        <li key={c.url}>
          <span className="cp-sign">{sign}</span>
          <span className="mono">{`${c.verbs.join(", ")} ${c.url}`}</span>
        </li>
      ))}
    </ul>
  );
}

function SubjectRow({ entry, escalated, own }: { entry: RbacSubjectEffect; escalated: boolean; own: boolean }) {
  return (
    <li className="rbac-effect-row">
      <div className="cp-who">
        <SubjectName subject={entry.subject} />
        {escalated && <span className="acc-badge warn">{t.EFFECT_ESCALATED_BADGE}</span>}
        {own && <span className="acc-badge warn">{t.EFFECT_OWN_BADGE}</span>}
      </div>
      <Capabilities items={entry.gained} sign="+" cls="cp-gain" />
      <UrlCapabilities items={entry.gainedUrls} sign="+" cls="cp-gain" />
      <Capabilities items={entry.lost} sign="−" cls="cp-lose" />
      <UrlCapabilities items={entry.lostUrls} sign="−" cls="cp-lose" />
    </li>
  );
}

interface Props {
  effect: RbacEffect;
  /** 여러 변경 미리보기 안에서는 목록을 접어 둔다 */
  compact?: boolean;
  title?: string;
}

/** 실효 권한 엔진이 본 "누가 무엇을 얻고 잃는지". 권한 상승과 이 앱의 신원이 잃는 권한은 따로 알린다. */
export function EffectView({ effect, compact = false, title = t.EFFECT_TITLE }: Props) {
  const rows = (
    <>
      <ul className="cp-impacts rbac-effect-list" aria-label={title}>
        {effect.subjects.map((entry) => (
          <SubjectRow key={`${entry.subject.kind}|${entry.subject.namespace}|${entry.subject.name}`} entry={entry} escalated={effect.escalated.some((s) => sameSubject(s, entry.subject))} own={effect.own !== null && sameSubject(effect.own, entry.subject)} />
        ))}
      </ul>
      {effect.total > effect.subjects.length && <p className="dim">{t.effectMore(effect.subjects.length, effect.total)}</p>}
    </>
  );
  return (
    <section className="rbac-effect" aria-label={title}>
      <h4>
        {title} <span className="dim">{t.effectCount(effect.total)}</span>
      </h4>
      {effect.escalated.length > 0 && <p className="err">{t.EFFECT_ESCALATED}</p>}
      {effect.losesOwnAccess && <p className="err">{t.EFFECT_OWN}</p>}
      {effect.unavailable && <p className="err">{t.EFFECT_UNAVAILABLE(effect.unavailable)}</p>}
      {effect.subjects.length === 0 ? (
        <p className="dim">{t.EFFECT_NONE}</p>
      ) : compact ? (
        <details>
          <summary>{t.EFFECT_DETAIL}</summary>
          {rows}
        </details>
      ) : (
        rows
      )}
    </section>
  );
}
