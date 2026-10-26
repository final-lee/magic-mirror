import { useQueryClient } from "@tanstack/react-query";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../api/errors";
import { useS3Objects } from "../api/queries";
import type { ServiceInfo } from "../api/types";
import type { S3Location } from "../lib/s3";
import { explorerApi } from "./api";
import { ConfirmDialog, type DialogAction } from "./ConfirmDialog";
import { LocalPane } from "./LocalPane";
import { useLocalHome, useLocalList } from "./queries";
import { S3Pane } from "./S3Pane";
import { compareTargets, type SelectionState } from "./selection";
import { TransferQueue } from "./TransferQueue";
import type { FileRef, TransferRequest } from "./types";
import { paneAt, usePaneDrag, type Pane } from "./usePaneDrag";
import type { Transfers } from "./useTransfers";

interface Props {
  profile: string | null;
  region: string;
  s3Service: ServiceInfo | undefined;
  filter: string;
  active: boolean;
  initialLocalPath: string | null;
  onLocalPathChange: (path: string) => void;
  transfers: Transfers;
  onOpenDiff: (left: FileRef, right: FileRef) => void;
  onRefresh: () => void;
  initialLocation?: S3Location | null;
}

interface DialogInput {
  title: string;
  message?: string;
  details?: string[];
  input?: { label: string; initial: string };
  error?: string | null;
  actions: DialogAction[];
  onResult: (value: string | null, text: string) => void | Promise<void>;
}

interface DialogState extends DialogInput {
  id: number;
}

const DIALOG_BUSY = "확인 창을 먼저 닫아 주세요";
const EMPTY: SelectionState = { selected: [], anchor: null };
const sameLoc = (a: S3Location | null, b: S3Location | null) =>
  a === b || (!!a && !!b && a.bucket === b.bucket && a.region === b.region && a.prefix === b.prefix);
const lastName = (p: string) => p.replace(/\/+$/, "").split("/").pop() ?? p;

export function ExplorerTab(p: Props) {
  const qc = useQueryClient();
  const home = useLocalHome();
  const [localPath, setLocalPath] = useState<string | null>(p.initialLocalPath);
  const [location, setLocation] = useState<S3Location | null>(p.initialLocation ?? null);
  const [localSel, setLocalSel] = useState<SelectionState>(EMPTY);
  const [s3Sel, setS3Sel] = useState<SelectionState>(EMPTY);
  const [focused, setFocused] = useState<Pane>("local");
  const [dialog, setDialogState] = useState<DialogState | null>(null);
  const dialogRef = useRef<DialogState | null>(null);
  const dialogSeq = useRef(0);
  // 대화상자마다 고유 id를 붙이고 ref도 즉시 갱신해, 드롭 리스너가 항상 최신 상태를 본다.
  const setDialog = (d: DialogInput | null) => {
    const next = d ? { ...d, id: ++dialogSeq.current } : null;
    dialogRef.current = next;
    setDialogState(next);
  };
  const [notice, setNotice] = useState<string | null>(null);
  const [finderOver, setFinderOver] = useState(false);

  useEffect(() => {
    if (!localPath && home.data) setLocalPath(home.data);
  }, [localPath, home.data]);
  const prevProfile = useRef(p.profile);
  useEffect(() => {
    // 마운트 직후에는 initialLocation을 지우지 않고, 프로필이 실제로 바뀔 때만 초기화한다.
    if (prevProfile.current === p.profile) return;
    prevProfile.current = p.profile;
    setLocation(null);
    s3History.current = { back: [], fwd: [] };
    setS3Sel(EMPTY);
    setLocalSel(EMPTY);
    setDialog(null);
  }, [p.profile]);

  const localList = useLocalList(localPath);
  const s3Objects = useS3Objects(p.profile ?? "", location?.region ?? "", location?.bucket ?? "", location?.prefix ?? "", !!location && !!p.profile);
  const localEntries = (localList.data ?? []).filter((e) => localSel.selected.includes(e.path));
  const s3Entries = location ? (s3Objects.data?.pages.flatMap((pg) => pg.entries) ?? []).filter((e) => s3Sel.selected.includes(e.key)) : [];
  const targets = compareTargets({ local: localEntries, s3: s3Entries, s3Location: location, focused });

  // 패널별 탐색 기록 (뒤로/앞으로)
  const localHistory = useRef<{ back: string[]; fwd: string[] }>({ back: [], fwd: [] });
  const s3History = useRef<{ back: (S3Location | null)[]; fwd: (S3Location | null)[] }>({ back: [], fwd: [] });
  const applyLocalPath = (path: string) => {
    setLocalPath(path);
    setLocalSel(EMPTY);
    p.onLocalPathChange(path);
  };
  const applyLocation = (loc: S3Location | null) => {
    setLocation(loc);
    setS3Sel(EMPTY);
  };
  const changeLocalPath = (path: string) => {
    if (localPath && path !== localPath) {
      localHistory.current.back.push(localPath);
      localHistory.current.fwd = [];
    }
    applyLocalPath(path);
  };
  const changeLocation = (loc: S3Location | null) => {
    if (!sameLoc(loc, location)) {
      s3History.current.back.push(location);
      s3History.current.fwd = [];
    }
    applyLocation(loc);
  };
  const go = (pane: Pane, dir: "back" | "fwd") => {
    const from = dir;
    const to = dir === "back" ? "fwd" : "back";
    if (pane === "local") {
      const h = localHistory.current;
      if (!localPath || h[from].length === 0) return;
      const target = h[from].pop() as string;
      h[to].push(localPath);
      applyLocalPath(target);
    } else {
      const h = s3History.current;
      if (h[from].length === 0) return;
      const target = h[from].pop() as S3Location | null;
      h[to].push(location);
      applyLocation(target);
    }
  };
  const invalidateS3 = () => {
    if (location) void qc.invalidateQueries({ queryKey: ["s3", p.profile, location.bucket] });
  };
  // 이름 변경/삭제 뒤에는 열려 있는 비교 탭의 결과도 낡았으니 함께 무효화한다.
  const invalidateAfterMutation = () => {
    invalidateS3();
    void qc.invalidateQueries({ queryKey: ["diff"] });
  };

  const confirmAndEnqueue = useCallback(
    async (requests: TransferRequest[]) => {
      if (!p.profile || requests.length === 0) return;
      const conflicts = await explorerApi.findConflicts(p.profile, requests);
      if (conflicts.length === 0) {
        await p.transfers.enqueue(requests);
        return;
      }
      const names = requests.filter((r) => conflicts.includes(r.id)).map((r) => (r.direction === "upload" ? r.key : r.localPath));
      setDialog({
        title: "덮어쓸까요?",
        message: `같은 이름의 파일이 ${conflicts.length}개 있어요.`,
        details: names,
        actions: [
          { label: "모두 덮어쓰기", value: "overwrite", danger: true },
          { label: "충돌 건너뛰기", value: "skip", primary: true },
        ],
        onResult: async (value) => {
          setDialog(null);
          if (value === "overwrite") await p.transfers.enqueue(requests);
          if (value === "skip") await p.transfers.enqueue(requests.filter((r) => !conflicts.includes(r.id)));
        },
      });
    },
    [p.profile, p.transfers],
  );

  const run = (fn: () => Promise<void>) => {
    setNotice(null);
    fn().catch((e) => setNotice(errorMessage(e)));
  };

  const uploadPaths = (paths: string[]) =>
    run(async () => {
      if (!location) {
        setNotice("버킷을 먼저 여세요");
        return;
      }
      await confirmAndEnqueue(await explorerApi.planUpload(paths, location.bucket, location.region, location.prefix));
    });

  const downloadKeys = (keys: string[]) =>
    run(async () => {
      if (!location || !p.profile || !localPath) return;
      await confirmAndEnqueue(await explorerApi.planDownload(p.profile, location.bucket, location.region, keys, localPath));
    });

  const newFolder = () => {
    if (!location || !p.profile) return;
    const profile = p.profile;
    const ask = (error: string | null, initial: string) =>
      setDialog({
        title: "새 폴더",
        input: { label: "폴더 이름", initial },
        error,
        actions: [{ label: "만들기", value: "ok", primary: true }],
        onResult: async (value, text) => {
          if (value === null) return setDialog(null);
          try {
            await explorerApi.s3CreateFolder(profile, location.bucket, location.region, location.prefix, text);
            setDialog(null);
            invalidateS3();
          } catch (e) {
            ask(errorMessage(e), text);
          }
        },
      });
    ask(null, "");
  };

  const rename = () => {
    if (!location || !p.profile || s3Sel.selected.length !== 1) return;
    const profile = p.profile;
    const from = s3Sel.selected[0];
    const doRename = async (name: string, overwrite: boolean) => {
      const res = await explorerApi.s3Rename(profile, location.bucket, location.region, from, name, overwrite);
      if (res.kind === "conflict") {
        setDialog({
          title: "덮어쓸까요?",
          message: `${res.target}이(가) 이미 있어요.`,
          actions: [{ label: "덮어쓰기", value: "overwrite", danger: true }],
          onResult: async (value) => {
            setDialog(null);
            if (value === "overwrite") run(() => doRename(name, true));
          },
        });
        return;
      }
      setDialog(null);
      setS3Sel(EMPTY);
      invalidateAfterMutation();
    };
    const ask = (error: string | null, initial: string) =>
      setDialog({
        title: "이름 변경",
        input: { label: "새 이름", initial },
        error,
        actions: [{ label: "바꾸기", value: "ok", primary: true }],
        onResult: async (value, text) => {
          if (value === null) return setDialog(null);
          try {
            await doRename(text, false);
          } catch (e) {
            ask(errorMessage(e), text);
          }
        },
      });
    ask(null, lastName(from));
  };

  const remove = () =>
    run(async () => {
      if (!location || !p.profile || s3Sel.selected.length === 0) return;
      const profile = p.profile;
      const keys = s3Sel.selected;
      const count = await explorerApi.s3CountUnder(profile, location.bucket, location.region, keys);
      setDialog({
        title: "삭제",
        message: `객체 ${count}개를 삭제할까요? 되돌릴 수 없어요.`,
        details: keys,
        actions: [{ label: "삭제하기", value: "delete", danger: true }],
        onResult: async (value) => {
          setDialog(null);
          if (value !== "delete") return;
          run(async () => {
            await explorerApi.s3Delete(profile, location.bucket, location.region, keys);
            setS3Sel(EMPTY);
            invalidateAfterMutation();
          });
        },
      });
    });

  const compare = () => {
    if (targets) p.onOpenDiff(targets[0], targets[1]);
  };

  const { drag, start } = usePaneDrag((from, to, ids) => {
    if (dialogRef.current) {
      setNotice(DIALOG_BUSY);
      return;
    }
    if (from === "local" && to === "s3") uploadPaths(ids);
    if (from === "s3" && to === "local") downloadKeys(ids);
  });

  // 최신 콜백을 Finder 드롭/단축키 리스너에서 쓰기 위한 ref
  const handlers = useRef({ uploadPaths, compare, remove, go });
  handlers.current = { uploadPaths, compare, remove, go };

  // 마우스 뒤로(3)/앞으로(4) 버튼: 포인터가 있는 패널에 적용
  useEffect(() => {
    if (!p.active) return;
    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      const el = (e.target as Element | null)?.closest?.("[data-pane]");
      const pane = el?.getAttribute("data-pane");
      if (pane !== "local" && pane !== "s3") return;
      e.preventDefault();
      if (dialogRef.current) return;
      setFocused(pane);
      handlers.current.go(pane, e.button === 3 ? "back" : "fwd");
    };
    window.addEventListener("mouseup", onMouseUp);
    return () => window.removeEventListener("mouseup", onMouseUp);
  }, [p.active]);

  useEffect(() => {
    if (!p.active) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload as { type: string; paths?: string[]; position?: { x: number; y: number } };
        const ratio = window.devicePixelRatio || 1;
        const pos = payload.position;
        const overS3 = pos ? paneAt(pos.x / ratio, pos.y / ratio) === "s3" : false;
        if (payload.type === "over" || payload.type === "enter") setFinderOver(overS3);
        else if (payload.type === "leave") setFinderOver(false);
        else if (payload.type === "drop") {
          setFinderOver(false);
          if (!overS3 || !payload.paths?.length) return;
          if (dialogRef.current) setNotice(DIALOG_BUSY);
          else handlers.current.uploadPaths(payload.paths);
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // Finder 드롭 리스너를 못 붙여도 앱 내 드래그는 동작한다
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [p.active]);

  useEffect(() => {
    if (!p.active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (dialog) return;
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Tab") {
        const el = document.activeElement as HTMLElement | null;
        const inTable = !!el?.closest("[data-pane] table");
        if (el && el !== document.body && !inTable) return;
        e.preventDefault();
        setFocused((f) => (f === "local" ? "s3" : "local"));
      } else if (e.metaKey && (e.key === "[" || e.key === "]")) {
        e.preventDefault();
        handlers.current.go(focused, e.key === "[" ? "back" : "fwd");
      } else if (e.metaKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        handlers.current.compare();
      } else if (e.metaKey && e.key === "Backspace" && focused === "s3") {
        e.preventDefault();
        handlers.current.remove();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [p.active, dialog, focused]);

  if (!p.profile || !p.s3Service) return <div className="empty">프로필을 고르세요</div>;

  return (
    <div className="explorer">
      <div className="panes">
        {localPath ? (
          <LocalPane
            path={localPath}
            onPathChange={changeLocalPath}
            filter={focused === "local" ? p.filter : ""}
            selection={localSel}
            onSelectionChange={setLocalSel}
            focused={focused === "local"}
            onFocus={() => setFocused("local")}
            onDragStart={(ids, pt) => start("local", ids, pt)}
            dropActive={drag?.from === "s3" && drag.over === "local"}
          />
        ) : (
          <section className="pane" data-pane="local">
            <div className="empty">불러오는 중…</div>
          </section>
        )}
        <S3Pane
          profile={p.profile}
          region={p.region}
          s3Service={p.s3Service}
          location={location}
          onLocationChange={changeLocation}
          filter={focused === "s3" ? p.filter : ""}
          selection={s3Sel}
          onSelectionChange={setS3Sel}
          focused={focused === "s3"}
          onFocus={() => setFocused("s3")}
          onDragStart={(ids, pt) => start("s3", ids, pt)}
          dropActive={finderOver || (drag?.from === "local" && drag.over === "s3")}
          onNewFolder={newFolder}
          onRename={rename}
          onDelete={remove}
          onRefresh={p.onRefresh}
        />
      </div>
      <div className="actions">
        <button className="btn small" disabled={!location || localSel.selected.length === 0} onClick={() => uploadPaths(localSel.selected)}>
          복사 →
        </button>
        <button className="btn small" disabled={!location || s3Sel.selected.length === 0} onClick={() => downloadKeys(s3Sel.selected)}>
          ← 복사
        </button>
        <button className="btn small primary" disabled={!targets} onClick={compare}>
          비교 ⌘D
        </button>
        {notice && <span className="err">{notice}</span>}
      </div>
      <TransferQueue items={p.transfers.items} onRetry={(id) => void p.transfers.retry(id)} onClear={p.transfers.clearFinished} />
      {drag && (
        <div className="drag-chip" style={{ left: drag.x + 12, top: drag.y + 12 }}>
          {drag.ids.length === 1 ? lastName(drag.ids[0]) : `${drag.ids.length}개`} {drag.from === "local" ? "→ S3" : "→ 로컬"}
        </div>
      )}
      {dialog && <ConfirmDialog key={dialog.id} {...dialog} onResult={(v, t) => void dialog.onResult(v, t)} />}
    </div>
  );
}
