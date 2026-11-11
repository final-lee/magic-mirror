import { useState } from "react";
import { ErrorState } from "../components/ErrorState";
import * as t from "./editText";
import { FormSheet } from "./FormSheet";
import { useSnsLoggingRoles } from "./queries";
import type { SnsTopicRef } from "./targets";
import type { DeliveryLogging, SnsChangeRequest, SnsLoggingProtocol, SnsRole } from "./types";

interface Props {
  target: SnsTopicRef;
  logging: DeliveryLogging;
  protocols?: DeliveryLogging[];
  /** [미리 보기…]: 입력으로 변경 대화창을 연다 */
  onPreview: (request: SnsChangeRequest) => void;
  onClose: () => void;
}

/** 목록에 없는 현재 역할(다른 방법으로 붙인 역할)도 고른 채로 보이게 한다 */
function withCurrent(roles: SnsRole[], current: string | null): SnsRole[] {
  if (!current || roles.some((r) => r.arn === current)) return roles;
  return [{ name: current.split("/").pop() ?? current, arn: current }, ...roles];
}

/**
 * 배달 상태 로깅 편집: 프로토콜 하나의 성공·실패 로그 역할(기존 IAM 역할 중에서만 고른다. 역할은 만들지 않는다)과 성공 로그 표본 비율.
 * 고르는 것만 하고 아무것도 바꾸지 않는다: [미리 보기…]가 변경 대화창으로 이어진다.
 */
export function LoggingForm({ target, logging: initial, protocols, onPreview, onClose }: Props) {
  const [logging, setLogging] = useState(initial);
  const roles = useSnsLoggingRoles(target.profile, target.region);
  const [success, setSuccess] = useState(logging.successRole ?? "");
  const [failure, setFailure] = useState(logging.failureRole ?? "");
  const [rate, setRate] = useState(String(logging.sampleRate ?? 0));
  const rateNumber = Number(rate);
  const rateOk = rate.trim() !== "" && Number.isInteger(rateNumber) && rateNumber >= 0 && rateNumber <= 100;
  const blocked = !rateOk ? t.LOGGING_BAD_RATE : null;
  const protocol = logging.protocol as SnsLoggingProtocol;

  const select = (label: string, value: string, onChange: (v: string) => void, current: string | null) => (
    <label className="field">
      {label}
      <select className="field-input" aria-label={label} value={value} disabled={!roles.data} onChange={(e) => onChange(e.target.value)}>
        <option value="">{roles.data ? t.LOGGING_NO_ROLE : t.LOGGING_ROLES_LOADING}</option>
        {withCurrent(roles.data ?? [], current).map((r) => (
          <option key={r.arn} value={r.arn}>
            {r.name}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <FormSheet
      title={t.LOGGING_TITLE(logging.protocol)}
      onClose={onClose}
      blocked={blocked}
      onPreview={() => onPreview({ kind: "deliveryLogging", topicArn: target.topicArn, protocol, successRoleArn: success || null, failureRoleArn: failure || null, sampleRate: rateNumber })}
    >
      {protocols && <label className="field">
        프로토콜
        <select className="field-input" aria-label="프로토콜" value={logging.protocol} onChange={(e) => {
          const next = protocols.find((item) => item.protocol === e.target.value);
          if (!next) return;
          setLogging(next);
          setSuccess(next.successRole ?? "");
          setFailure(next.failureRole ?? "");
          setRate(String(next.sampleRate ?? 0));
        }}>
          {protocols.map((item) => <option key={item.protocol} value={item.protocol}>{item.protocol}</option>)}
        </select>
      </label>}
      {roles.isError && <ErrorState compact error={roles.error} profile={target.profile} onRetry={() => void roles.refetch()} />}
      <p className="sns-note dim">{t.LOGGING_ROLES_NOTE}</p>
      {roles.data && roles.data.length === 0 && <p className="sns-note">{t.LOGGING_ROLES_EMPTY}</p>}
      {select(t.LOGGING_SUCCESS, success, setSuccess, logging.successRole)}
      {select(t.LOGGING_FAILURE, failure, setFailure, logging.failureRole)}
      <label className="field">
        {t.LOGGING_RATE}
        <input className="field-input" type="number" min={0} max={100} step={1} aria-label={t.LOGGING_RATE} value={rate} onChange={(e) => setRate(e.target.value)} />
      </label>
    </FormSheet>
  );
}
