import { memo, useEffect, useRef, useState } from "react";
import { errorMessage } from "../api/errors";
import { iamApi } from "./api";
import { CallList, ConfirmField, GATE_HINT, ImpactList, PreviewAlerts, ReversibleNote, useSheetFocus, WarningList } from "./previewParts";
import type { BatchItem, BatchPreview, BatchResult, IamChange } from "./types";
import { batchGate, batchWarnings, stopMessage, type PendingBatch } from "./useIamBatch";

interface Props {
  pending: PendingBatch;
  /** 적용을 누르면 입력한 확인 문구와 함께 부른다. 적용 가능 여부는 여기서도 훅에서도 따로 확인한다 */
  onApply: (typed: string) => void;
  onRetry: () => void;
  /** 취소, 결과 창에서는 닫기 */
  onCancel: () => void;
  /** 결과 창의 [적용된 k개 되돌리기]: 되돌리는 묶음을 같은 흐름으로 다시 미리보기에 올린다 */
  onStart: (changes: IamChange[], opts: { undoOf: string[] }) => void;
}

/**
 * 묶음 미리보기 창. 적용 순서대로 변경마다 요약, 호출, 경고를 보여 주고 묶음 전체의 경고와 권한 증감을 함께 보여 준다.
 * ChangePreviewDialog와 같은 규칙: 처음 초점은 [취소], Esc는 취소, Enter로는 위험한 동작이 실행되지 않고, 막힘이면 적용을 끄며
 * 확인 문구를 정확히 입력해야 적용할 수 있다.
 * 적용이 중간에 멈추면 같은 창이 결과로 바뀐다: 어디서 왜 멈췄는지와 [적용된 k개 되돌리기].
 */
export function BatchPreviewDialog(props: Props) {
  // 미리보기를 새로 받으면(rev가 바뀌면) 창을 새로 열어서 입력해 둔 확인 문구를 버린다
  return <Sheet key={props.pending.rev} {...props} />;
}

function Sheet({ pending, onApply, onRetry, onCancel, onStart }: Props) {
  const { preview, phase, error, stale, result } = pending;
  const applying = phase === "applying";
  const failed = phase === "result" ? (result?.failed ?? null) : null;
  const [typed, setTyped] = useState("");
  const { sheetRef, trapTab, cancelRef, retryRef } = useSheetFocus(phase, onCancel);

  const undo = useUndoApplied(result, onStart);

  const gate = preview ? batchGate(preview, typed) : null;
  const canApply = !!preview && gate?.ok === true && phase === "ready" && !stale;
  const needsRetry = (error?.kind === "preview" || stale) && !applying;
  const danger = !!preview && (!!preview.confirmText || batchWarnings(preview).some((w) => w.level !== "block"));
  const count = preview?.changes.length ?? pending.changes.length;
  const title = `변경 ${count}개 미리보기`;
  const hint = gate && !gate.ok && gate.reason !== "text" ? GATE_HINT[gate.reason] : null;
  // 되돌릴 수 있는 것은 기록에 남은 변경뿐이다. 적용한 수(failed.index)와 다를 수 있다(기록을 저장하지 못해 멈춘 경우)
  const undoable = result?.logIds.length ?? 0;

  return (
    <div className="modal">
      <div className="sheet wide cp" role="dialog" aria-modal="true" aria-label={title} ref={sheetRef} onKeyDown={trapTab}>
        <div className="cp-body">
          <h3>{title}</h3>
          {failed && result ? (
            <Stopped total={count} failed={failed} notes={result.notes ?? []} />
          ) : (
            <>
              {phase === "loading" && <p>미리보기를 불러오는 중이에요…</p>}
              {preview && <BatchDetails preview={preview} />}
              {preview?.confirmText && (
                <ConfirmField required={preview.confirmText} typed={typed} onTyped={setTyped} locked={applying} mismatchHint="입력한 문구가 달라요" />
              )}
            </>
          )}
          {undo.error && (
            <div className="cp-error" role="alert">
              <div>{undo.error}</div>
            </div>
          )}
        </div>
        {/* 오류는 스크롤되는 본문 밖, 버튼 바로 위에 둔다: 미리보기가 길어도 가려지지 않는다 */}
        <PreviewAlerts error={error} stale={stale} />
        <div className="foot">
          {hint && <span className="cp-hint">{hint}</span>}
          <button ref={cancelRef} className="btn plain" disabled={applying} onClick={onCancel}>
            {failed ? "닫기" : "취소"}
          </button>
          {needsRetry && (
            <button ref={retryRef} className="btn" onClick={onRetry}>
              미리보기 다시 받기
            </button>
          )}
          {failed ? (
            undoable > 0 && (
              <button className="btn" disabled={undo.busy} onClick={() => void undo.run()}>
                {undo.busy ? "준비 중…" : `적용된 ${undoable}개 되돌리기`}
              </button>
            )
          ) : (
            <button className={`btn ${danger ? "danger" : "primary"}`} disabled={!canApply} onClick={() => onApply(typed)}>
              {applying ? "적용 중…" : "적용"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 결과 창의 [적용된 k개 되돌리기]: 이 묶음의 역변경을 받아 같은 흐름(onStart)으로 미리보기에 올린다.
 * 받는 동안에는 한 번만 묻고, 그 사이에 창을 닫았으면 받은 뒤에도 되돌리기를 시작하지 않는다.
 */
function useUndoApplied(result: BatchResult | null, onStart: Props["onStart"]) {
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const asking = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = async () => {
    if (!result || asking.current) return;
    asking.current = true;
    setState({ busy: true, error: null });
    try {
      const inverse = await iamApi.undoBatch(result.batchId);
      if (!mounted.current) return;
      onStart(inverse.changes, { undoOf: inverse.undoOf });
      setState({ busy: false, error: null });
    } catch (e) {
      if (mounted.current) setState({ busy: false, error: errorMessage(e) });
    } finally {
      asking.current = false;
    }
  };

  return { ...state, run };
}

/** 중간에 멈춘 결과: 어디서 왜 멈췄는지, 그리고 이미 바꿔 놓고 하지 못한 일(notes) */
function Stopped({ total, failed, notes }: { total: number; failed: NonNullable<BatchResult["failed"]>; notes: string[] }) {
  return (
    <>
      <div className="cp-error" role="alert">
        <div>{stopMessage(total, failed)}</div>
      </div>
      <WarningList warnings={notes.map((message) => ({ level: "warn" as const, message }))} />
    </>
  );
}

/**
 * 미리보기 본문: 묶음 전체의 경고, 적용 순서대로 변경 목록, 영향받는 주체, 되돌릴 수 있는지.
 * 변경이 많아도 확인 문구를 한 글자씩 입력할 때마다 다시 그리지 않도록 미리보기가 바뀔 때만 그린다.
 */
const BatchDetails = memo(function BatchDetails({ preview }: { preview: BatchPreview }) {
  return (
    <>
      <WarningList warnings={preview.warnings} />

      {preview.changes.length > 0 && (
        <>
          <h4>
            변경 <span className="dim">{preview.changes.length}</span>
          </h4>
          <ol className="cp-items" aria-label="변경 목록">
            {preview.changes.map((item, i) => (
              <BatchItemRow key={i} no={i + 1} item={item} />
            ))}
          </ol>
        </>
      )}

      <ImpactList impacts={preview.impacts} omitted={preview.impactsOmitted ?? 0} />

      <ReversibleNote reversible={preview.reversible} />
    </>
  );
});

/** 변경 하나: 요약과 이 변경의 경고. 호출은 길어서 접어 두고, 누르면 펼친다 */
function BatchItemRow({ no, item }: { no: number; item: BatchItem }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="cp-item">
      <div className="cp-item-head">
        <span className="cp-item-no dim">{no}</span>
        <span className="cp-item-sum">{item.summary}</span>
      </div>
      <WarningList warnings={item.warnings} />
      {item.calls.length > 0 && (
        <>
          <button className="link cp-item-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <span aria-hidden="true">{open ? "▾" : "▸"}</span> 호출할 API {item.calls.length}개
          </button>
          {open && <CallList calls={item.calls} />}
        </>
      )}
    </li>
  );
}
