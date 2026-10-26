import { useState } from "react";
import { errorMessage } from "../api/errors";
import { S3_COLUMNS } from "../lib/s3";
import { explorerApi } from "./api";
import { FileTable } from "./FileTable";
import { parentDir, useLocalList } from "./queries";
import { localEntryToRow } from "./rows";
import type { SelectionState } from "./selection";

interface Props {
  path: string;
  onPathChange: (path: string) => void;
  filter: string;
  selection: SelectionState;
  onSelectionChange: (s: SelectionState) => void;
  focused: boolean;
  onFocus: () => void;
  onDragStart: (ids: string[], point: { clientX: number; clientY: number }) => void;
  dropActive: boolean;
}

export function LocalPane({ path, onPathChange, filter, selection, onSelectionChange, focused, onFocus, onDragStart, dropActive }: Props) {
  const q = useLocalList(path);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(path);
  const entries = q.data ?? [];

  const open = (id: string) => {
    const entry = entries.find((e) => e.path === id);
    if (entry?.isDir) onPathChange(entry.path);
  };

  return (
    <section
      className={`pane${focused ? " focus" : ""}${dropActive ? " drop" : ""}`}
      data-pane="local"
      data-testid="pane-local"
      onMouseDown={onFocus}
    >
      <div className="pane-head">
        <span>💻</span>
        {editing ? (
          <input
            className="path-input"
            aria-label="경로"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setEditing(false);
                onPathChange(draft);
              } else if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <button className="link path" aria-label="경로 입력" onClick={() => (setDraft(path), setEditing(true))}>
            <b>{path}</b>
          </button>
        )}
        <span className="sp">
          <button className="icon" aria-label="상위 폴더" title="상위 폴더" onClick={() => onPathChange(parentDir(path))}>
            ↑
          </button>
        </span>
      </div>
      {q.isError ? (
        <div className="empty">
          <div>
            <p className="err">{errorMessage(q.error)}</p>
            <button className="btn" onClick={() => void explorerApi.localHome().then(onPathChange)}>
              홈으로
            </button>
          </div>
        </div>
      ) : q.isPending ? (
        <div className="empty">불러오는 중…</div>
      ) : (
        <FileTable
          columns={S3_COLUMNS}
          rows={entries.map(localEntryToRow)}
          filter={filter}
          selection={selection}
          onSelectionChange={onSelectionChange}
          onOpen={open}
          onBack={() => onPathChange(parentDir(path))}
          onDragStart={onDragStart}
          emptyText="빈 폴더예요"
        />
      )}
    </section>
  );
}
