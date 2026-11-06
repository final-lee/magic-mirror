import { useState } from "react";
import { errorMessage } from "../api/errors";
import { useModal } from "../iam/useModal";
import { devicesApi } from "./api";
import type { Preview, ResultItem } from "./devicesApi";
import * as text from "./devicesText";

export function DeviceChange({ tailnet, preview, onClose, onDone }: {
  tailnet: string;
  preview: Preview;
  onClose: () => void;
  onDone: () => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [result, setResult] = useState<ResultItem[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const deleting = preview.items.some((item) => item.action === "delete");
  const expected = preview.items.length === 1 ? preview.items[0].device.name : text.selectedDevices(preview.items.length);
  // 보내는 중에는 닫지 않는다(Esc·바깥 누르기·취소 모두)
  const cancel = () => {
    if (!busy) onClose();
  };
  const { sheetRef, trapTab } = useModal(cancel);

  async function apply() {
    setBusy(true);
    setError("");
    try {
      setResult(await devicesApi.apply(tailnet, preview, deleting ? confirmation : null));
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal" onClick={(e) => { if (e.target === e.currentTarget) cancel(); }}>
      <div
        className="sheet wide"
        role="dialog"
        aria-modal="true"
        aria-label={result ? text.RESULT : text.CONFIRM_REQUEST}
        ref={sheetRef}
        onKeyDown={trapTab}
      >
      <h3>{result ? text.RESULT : text.CONFIRM_REQUEST}</h3>
      {!result && (
        <>
          <p>{text.REQUEST_WARNING}</p>
          <div className="argowf-table-wrap"><table className="argowf-table">
            <thead><tr><th>{text.DEVICE}</th><th>{text.REQUEST}</th><th>{text.BODY}</th></tr></thead>
            <tbody>
              {preview.items.map((item) => (
                <tr key={item.device.id}>
                  <td>{item.device.name}</td>
                  <td><code>{item.method} {item.path}</code></td>
                  <td><code>{item.body === null ? text.NONE : JSON.stringify(item.body)}</code></td>
                </tr>
              ))}
            </tbody>
          </table></div>
          {deleting && (
            <label>
              {text.DELETE_PREFIX} <strong>{expected}</strong>{text.DELETE_SUFFIX}{" "}
              <input value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
            </label>
          )}
          <div className="foot">
            <button
              className={`btn ${deleting ? "danger" : "primary"}`}
              disabled={busy || (deleting && confirmation !== expected)}
              onClick={() => void apply()}
            >
              {text.APPLY}
            </button>{" "}
            <button className="btn" disabled={busy} onClick={cancel}>{text.CANCEL}</button>
          </div>
        </>
      )}
      {result && (
        <>
          <div className="argowf-table-wrap"><table className="argowf-table">
            <thead><tr><th>{text.DEVICE}</th><th>{text.RESULT_COLUMN}</th></tr></thead>
            <tbody>
              {result.map((item) => (
                <tr key={item.id}><td>{item.name}</td><td>{item.ok ? text.DONE : item.error}</td></tr>
              ))}
            </tbody>
          </table></div>
          <div className="foot"><button className="btn primary" onClick={onClose}>{text.CLOSE}</button></div>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      </div>
    </div>
  );
}
