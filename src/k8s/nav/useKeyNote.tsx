import { useCallback, useEffect, useRef, useState } from "react";
import { KEY_NOTE_DISMISS, KEY_NOTE_LABEL } from "./text";

/** 상태 줄 안내가 보이는 시간 */
export const NOTE_MS = 4000;

/** 한 글자 키가 하지 못한 이유를 잠깐 보이는 안내 하나. 새 안내가 오면 바뀌고 일정 시간 뒤 사라진다 */
export function useKeyNote() {
  const [note, setNote] = useState<{ text: string; id: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const next = useRef(0);
  const clear = useCallback(() => {
    clearTimeout(timer.current);
    setNote(null);
  }, []);
  const show = useCallback((text: string) => {
    clearTimeout(timer.current);
    setNote({ text, id: next.current++ });
    timer.current = setTimeout(() => setNote(null), NOTE_MS);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return { note, show, clear };
}

/** 목록 상자 아래에 뜨는 상태 줄 */
export function KeyNote({ note, onDismiss }: { note: { text: string; id: number } | null; onDismiss: () => void }) {
  // 안내가 없어도 영역은 둬서 스크린리더가 바뀐 글을 읽는다
  return (
    <div className="k8s-key-note-host" role="status" aria-live="polite" aria-label={KEY_NOTE_LABEL}>
      {note && (
        <div key={note.id} className="k8s-key-note">
          <span>{note.text}</span>
          <button className="icon tone-ghost" aria-label={KEY_NOTE_DISMISS} title={KEY_NOTE_DISMISS} onClick={onDismiss}>
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
