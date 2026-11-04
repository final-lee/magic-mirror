import { useSheetFocus } from "../../iam/previewParts";
import { PreviewBody } from "../ChangeFlow";
import { changeTitle } from "./changes";
import { EffectView } from "./EffectView";
import * as t from "./text";
import { applicable, type RbacBatch, type RbacBatchApi } from "./useRbacBatch";

const STATUS_LABEL = { applied: t.BATCH_APPLIED, failed: t.BATCH_FAILED, skipped: t.BATCH_SKIPPED } as const;

interface Props {
  batch: RbacBatch;
  api: RbacBatchApi;
}

/**
 * 권한 변경 여러 개의 한 번에 미리보기. 맨 위에 전체를 적용했을 때 누가 무엇을 얻고 잃는지를 보이고, 변경마다 호출·필드 차이·영향·경고를 보인다.
 * 적용은 하나씩이고 첫 실패에서 멈추며, 끝나면 적용한 것을 되돌리는 미리보기를 제안한다.
 */
export function RbacBatchDialog({ batch, api }: Props) {
  const { sheetRef, trapTab, cancelRef } = useSheetFocus(batch.phase, api.cancel);
  const applying = batch.phase === "applying";
  const closed = batch.phase === "stopped" || batch.phase === "finished";
  const loading = batch.phase === "loading";
  const anyApplied = batch.items.some((item) => item.status === "applied" && item.logId);
  const unplanned = batch.items.some((item) => !item.preview && !loading);
  const ready = applicable(batch);
  const title = batch.undo ? t.BATCH_UNDO_TITLE : t.BATCH_TITLE;
  return (
    <div className="modal">
      <div className="sheet wide cp" role="dialog" aria-modal="true" aria-label={title} ref={sheetRef} onKeyDown={trapTab}>
        <div className="cp-body">
          <h3>{title}</h3>
          <p className="dim">{t.BATCH_ORDER_NOTE}</p>
          {loading && <p>{t.BATCH_LOADING}</p>}
          {batch.total && <EffectView effect={batch.total} title={t.BATCH_TOTAL_TITLE} />}
          {batch.items.map((item, index) => (
            <section key={index} className="k8s-sect" aria-label={t.batchItem(index + 1, changeTitle(item.change))}>
              <h4>
                {t.batchItem(index + 1, changeTitle(item.change))}{" "}
                {item.status !== "pending" && <span className="k8s-chip">{STATUS_LABEL[item.status]}</span>}
              </h4>
              {item.error && <p className="err">{t.BATCH_PREVIEW_FAILED}: {item.error}</p>}
              {item.preview && (
                <PreviewBody preview={item.preview} typed={item.typed} onTyped={(text) => api.typed(index, text)} locked={applying || item.status !== "pending"} compactEffect />
              )}
              {item.applyError && <p className="err">{t.BATCH_FAILED}: {item.applyError}</p>}
            </section>
          ))}
        </div>
        <div className="foot">
          {batch.notice && <span className="cp-hint err">{batch.notice}</span>}
          {batch.stale && <span className="cp-hint err">{t.BATCH_STALE}</span>}
          {batch.phase === "stopped" && <span className="cp-hint err">{t.BATCH_STOPPED}</span>}
          {batch.phase === "finished" && <span className="cp-hint">{t.BATCH_DONE}</span>}
          {batch.phase === "ready" && unplanned && <span className="cp-hint err">{t.BATCH_BLOCKED}</span>}
          <button ref={cancelRef} className="btn plain tone-ghost" disabled={applying} onClick={api.cancel}>
            {closed ? t.BATCH_CLOSE : t.BATCH_CANCEL}
          </button>
          {closed && !batch.undo && anyApplied && (
            <button className="btn tone-warn" onClick={api.undoApplied}>
              {t.BATCH_UNDO_APPLIED}
            </button>
          )}
          {!closed && (batch.stale || unplanned) && (
            <button className="btn tone-secondary" disabled={applying || loading} onClick={api.retry}>
              {t.BATCH_RETRY}
            </button>
          )}
          {!closed && (
            <button className="btn plain tone-primary" disabled={!ready || applying} onClick={api.apply}>
              {applying ? t.BATCH_APPLYING : t.BATCH_APPLY(batch.items.length)}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
