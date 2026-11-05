import { useEffect, useMemo, useState } from "react";
import { CodeEditor } from "../../components/CodeEditor";
import { useModal } from "../../iam/useModal";
import { ChangeSheet } from "../change/ChangeSheet";
import type { ArgoAppRow } from "../types";
import { appTemplate, destinationsOf, gateCreate, projectsOf, withDestination, withProject } from "./newApp";
import { MANAGE_CANCEL, MANAGE_CREATE, MANAGE_CREATE_DEST, MANAGE_CREATE_HINT, MANAGE_CREATE_LABEL, MANAGE_CREATE_PICK, MANAGE_CREATE_PROJECT, MANAGE_CREATE_TITLE, MANAGE_PREVIEW } from "./text";

interface Props {
  url: string;
  /** 지금 목록의 앱. 프로젝트·대상 후보를 여기서 뽑는다 */
  rows: ArgoAppRow[];
  onDone: (message: string) => void;
}

/** 목록 도구줄의 "앱 만들기": YAML 틀을 채워 미리 보기(ChangeSheet)로 넘긴다 */
export function CreateApp({ url, rows, onDone }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn small tone-primary" onClick={() => setOpen(true)}>
        {MANAGE_CREATE}
      </button>
      {open && <CreateSheet url={url} rows={rows} onClose={() => setOpen(false)} onDone={onDone} />}
    </>
  );
}

function CreateSheet({ url, rows, onClose, onDone }: Props & { onClose: () => void }) {
  const [text, setText] = useState(() => appTemplate(rows));
  // 편집기는 처음 값으로만 채우므로, 고르기 도우미가 글을 고치면 편집기를 다시 만든다
  const [round, setRound] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  const { sheetRef, trapTab } = useModal(onClose);
  useEffect(() => {
    sheetRef.current?.focus();
  }, [sheetRef]);
  const gate = useMemo(() => gateCreate(text, rows), [text, rows]);
  const projects = useMemo(() => projectsOf(rows), [rows]);
  const destinations = useMemo(() => destinationsOf(rows), [rows]);
  const change = useMemo(() => ({ kind: "appCreate", yaml: text, upsert: false }) as const, [text]);
  const rewrite = (next: string) => {
    setText(next);
    setRound((n) => n + 1);
  };

  if (previewing && gate.target) {
    return (
      <ChangeSheet
        url={url}
        target={gate.target}
        change={change}
        onClose={() => setPreviewing(false)}
        onDone={(message) => {
          onClose();
          onDone(message);
        }}
      />
    );
  }

  return (
    <div className="modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet wide" role="dialog" aria-modal="true" aria-label={MANAGE_CREATE_TITLE} ref={sheetRef} tabIndex={-1} onKeyDown={trapTab}>
        <h3>{MANAGE_CREATE_TITLE}</h3>
        <p>{MANAGE_CREATE_HINT}</p>
        <div className="mg-row">
          <label className="mg-pick">
            {MANAGE_CREATE_PROJECT}
            <select value="" onChange={(e) => e.target.value && rewrite(withProject(text, e.target.value))}>
              <option value="">{MANAGE_CREATE_PICK}</option>
              {projects.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="mg-pick">
            {MANAGE_CREATE_DEST}
            <select
              value=""
              onChange={(e) => {
                const choice = destinations[Number(e.target.value)];
                if (e.target.value !== "" && choice) rewrite(withDestination(text, choice));
              }}
            >
              <option value="">{MANAGE_CREATE_PICK}</option>
              {destinations.map((d, i) => (
                <option key={`${d.cluster}/${d.namespace}`} value={i}>
                  {[d.cluster, d.namespace].filter(Boolean).join(" / ")}
                </option>
              ))}
            </select>
          </label>
        </div>
        <CodeEditor key={round} value={text} onChange={setText} label={MANAGE_CREATE_LABEL} minHeight="320px" />
        {gate.reason && (
          <p className="err" role="alert">
            {gate.reason}
          </p>
        )}
        <div className="foot">
          <button className="btn plain tone-ghost" onClick={onClose}>
            {MANAGE_CANCEL}
          </button>
          <button className="btn plain tone-primary" disabled={!gate.ok} onClick={() => setPreviewing(true)}>
            {MANAGE_PREVIEW}
          </button>
        </div>
      </div>
    </div>
  );
}
