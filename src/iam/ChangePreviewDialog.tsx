import { useEffect, useRef, useState } from "react";
import { KIND_LABEL, LEVEL_LABEL } from "./labels";
import type { ChangePreview, PermDelta } from "./types";
import { applyGate, type PendingChange } from "./useIamChange";
import { useModal } from "./useModal";

const MAX_IMPACTS = 30;

const WARN_LEVELS = ["block", "confirm", "warn"] as const;
const WARN_TITLE: Record<(typeof WARN_LEVELS)[number], string> = {
  block: "막혀서 적용할 수 없어요",
  confirm: "확인이 필요해요",
  warn: "주의하세요",
};

const GATE_HINT = {
  blocked: "막힘 경고가 있어서 적용할 수 없어요",
  noText: "확인 문구를 받지 못해서 적용할 수 없어요",
} as const;

interface Props {
  pending: PendingChange;
  /** 적용을 누르면 입력한 확인 문구와 함께 부른다. 적용 가능 여부는 여기서도 훅에서도 따로 확인한다 */
  onApply: (typed: string) => void;
  onRetry: () => void;
  onCancel: () => void;
}

/**
 * 변경 미리보기 창. 호출할 API, 권한 증감, 경고를 보여 주고, 막힘이면 적용을 끄며 확인 문구를 정확히 입력해야 적용할 수 있다.
 * ConfirmDialog와 같은 규칙: 처음 초점은 [취소], Esc는 취소, Enter로는 위험한 동작이 실행되지 않는다.
 */
export function ChangePreviewDialog(props: Props) {
  // 미리보기를 새로 받으면(rev가 바뀌면) 창을 새로 열어서 입력해 둔 확인 문구를 버린다
  return <Sheet key={props.pending.rev} {...props} />;
}

function Sheet({ pending, onApply, onRetry, onCancel }: Props) {
  const { preview, phase, error, stale, undoOf } = pending;
  const applying = phase === "applying";
  const [typed, setTyped] = useState("");
  const cancelRef = useRef<HTMLButtonElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const wasApplying = useRef(false);
  const { sheetRef, trapTab } = useModal(() => {
    if (!applying) onCancel();
  });
  useEffect(() => cancelRef.current?.focus(), []);
  // 적용 중에는 버튼이 잠겨 초점이 사라진다. 실패해서 돌아오면 안전한 버튼(다시 받기, 없으면 취소)으로 초점을 돌려준다.
  useEffect(() => {
    if (phase === "applying") wasApplying.current = true;
    else if (wasApplying.current) {
      wasApplying.current = false;
      (retryRef.current ?? cancelRef.current)?.focus();
    }
  }, [phase]);

  const gate = preview ? applyGate(preview, typed) : null;
  const canApply = !!preview && gate?.ok === true && phase === "ready" && !stale;
  const needsRetry = (error?.kind === "preview" || stale) && !applying;
  const danger = !!preview && (!!preview.confirmText || preview.warnings.some((w) => w.level !== "block"));
  const title = undoOf ? "되돌리기 미리보기" : "변경 미리보기";
  const hint = gate && !gate.ok && gate.reason !== "text" ? GATE_HINT[gate.reason] : null;

  return (
    <div className="modal">
      <div className="sheet wide cp" role="dialog" aria-modal="true" aria-label={title} ref={sheetRef} onKeyDown={trapTab}>
        <div className="cp-body">
          <h3>{title}</h3>
          {phase === "loading" && <p>미리보기를 불러오는 중이에요…</p>}
          {preview && <PreviewBody preview={preview} typed={typed} onTyped={setTyped} locked={applying} />}
        </div>
        {/* 오류는 스크롤되는 본문 밖, 버튼 바로 위에 둔다: 미리보기가 길어도 가려지지 않는다 */}
        {(error || stale) && (
          <div className="cp-alerts">
            {error && (
              <div className="cp-error" role="alert">
                <div>{error.kind === "preview" ? "미리보기를 만들지 못했어요" : "적용하지 못했어요"}</div>
                <div>{error.message}</div>
              </div>
            )}
            {stale && <p className="cp-stale">적용에 실패했어요. 상태가 바뀌었을 수 있어서 미리보기를 다시 받은 뒤에 적용할 수 있어요</p>}
          </div>
        )}
        <div className="foot">
          {hint && <span className="cp-hint">{hint}</span>}
          <button ref={cancelRef} className="btn plain" disabled={applying} onClick={onCancel}>
            취소
          </button>
          {needsRetry && (
            <button ref={retryRef} className="btn" onClick={onRetry}>
              미리보기 다시 받기
            </button>
          )}
          <button className={`btn ${danger ? "danger" : "primary"}`} disabled={!canApply} onClick={() => onApply(typed)}>
            {applying ? "적용 중…" : "적용"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PreviewBody({ preview, typed, onTyped, locked }: { preview: ChangePreview; typed: string; onTyped: (v: string) => void; locked: boolean }) {
  const required = preview.confirmText;
  const shown = preview.impacts.slice(0, MAX_IMPACTS);
  return (
    <>
      <p className="cp-sum">{preview.summary}</p>

      {WARN_LEVELS.map((level) => {
        const items = preview.warnings.filter((w) => w.level === level);
        if (items.length === 0) return null;
        return (
          <div key={level} className={`cp-warn ${level}`} data-level={level} data-testid="cp-warnings" role={level === "block" ? "alert" : undefined}>
            <div className="cp-warn-title">{WARN_TITLE[level]}</div>
            <ul>
              {items.map((w, i) => (
                <li key={i}>{w.message}</li>
              ))}
            </ul>
          </div>
        );
      })}

      {preview.calls.length > 0 && (
        <>
          <h4>호출할 API</h4>
          <ul className="cp-calls" aria-label="호출할 API">
            {preview.calls.map((c, i) => (
              <li key={i}>
                <b className="mono">{c.api}</b>
                {Object.entries(c.params).map(([k, v]) => (
                  <div className="cp-param" key={k}>
                    <span className="dim">{k}</span>
                    <span className="cp-val mono">{v}</span>
                  </div>
                ))}
              </li>
            ))}
          </ul>
        </>
      )}

      <h4>
        영향받는 주체 <span className="dim">{preview.impacts.length}</span>
      </h4>
      {preview.impacts.length === 0 ? (
        <p className="cp-none">권한이 달라지는 주체가 없어요</p>
      ) : (
        <ul className="cp-impacts" aria-label="영향받는 주체">
          {shown.map((impact) => (
            <li key={impact.principal.arn} data-testid={`impact-${impact.principal.arn}`}>
              <div className="cp-who">
                <b>{impact.principal.name}</b> <span className="iam-kind">{KIND_LABEL[impact.principal.kind]}</span>
              </div>
              {impact.gained.length > 0 && <Deltas kind="gained" deltas={impact.gained} />}
              {impact.lost.length > 0 && <Deltas kind="lost" deltas={impact.lost} />}
              {impact.gained.length === 0 && impact.lost.length === 0 && <div className="dim">권한 변화 없음</div>}
            </li>
          ))}
          {preview.impacts.length > shown.length && <li className="dim">외 {preview.impacts.length - shown.length}명</li>}
        </ul>
      )}

      <p className={`cp-rev${preview.reversible ? "" : " no"}`}>
        {preview.reversible ? "되돌릴 수 있어요" : "되돌릴 수 없어요. 적용하면 변경 기록에서도 되돌릴 수 없어요"}
      </p>

      {required && (
        <label className="field cp-confirm">
          <span>확인하려면 {required}를 입력하세요</span>
          <input
            aria-label={`확인하려면 ${required}를 입력하세요`}
            value={typed}
            disabled={locked}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(e) => onTyped(e.target.value)}
            // Enter로는 아무것도 실행하지 않는다: 위험한 변경은 버튼을 직접 눌러야 한다
            onKeyDown={(e) => {
              if (e.key === "Enter") e.preventDefault();
            }}
          />
          {typed !== "" && typed !== required && <span className="err">입력한 이름이 달라요</span>}
        </label>
      )}
    </>
  );
}

function Deltas({ kind, deltas }: { kind: "gained" | "lost"; deltas: PermDelta[] }) {
  const gained = kind === "gained";
  return (
    <ul className={gained ? "cp-gain" : "cp-lose"} data-testid={kind} aria-label={gained ? "얻는 권한" : "잃는 권한"}>
      {deltas.map((d) => (
        <li key={`${d.prefix}|${d.level}`}>
          <span className="cp-sign" aria-hidden="true">
            {gained ? "＋" : "－"}
          </span>
          <b>{d.prefix}</b> · {LEVEL_LABEL[d.level]} {d.count}개
          {d.sample.length > 0 && <span className="mono dim"> {d.sample.join(", ")}</span>}
          {d.count > d.sample.length && <span className="dim"> 외 {d.count - d.sample.length}개</span>}
        </li>
      ))}
    </ul>
  );
}
