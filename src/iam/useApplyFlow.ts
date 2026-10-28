// 변경 하나짜리 흐름(useIamChange)과 묶음 흐름(useIamBatch)이 함께 쓰는 조각:
// 완료 안내, 적용 뒤 IAM 다시 읽기, 열려 있는 흐름 하나를 들고 있는 뼈대.
// 두 흐름이 안내를 띄우는 규칙이나 다시 읽는 때가 어긋나지 않도록, 이 규칙들은 여기에만 둔다.
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { iamKeys, refreshIam } from "./queries";

/** 적용한 뒤 IAM이 반영될 때까지 기다렸다가 한 번 더 읽는 시간 */
export const REFRESH_DELAY_MS = 3_000;
/** 완료 안내가 저절로 사라지는 시간. 함께 알릴 일(notes)이 있는 안내는 닫을 때까지 남는다 */
export const NOTICE_MS = 10_000;

/** 적용을 마친 뒤의 안내 하나 */
export interface ApplyNotice {
  id: number;
  summary: string;
  /** IAM은 바꿨지만 하지 못한 일(변경 기록을 저장하지 못함 등). 있으면 사용자가 닫을 때까지 남기고, 다음 성공 안내가 덮지 않는다 */
  notes: string[];
}

/**
 * 완료 안내 목록. 안내는 NOTICE_MS 뒤에 사라지지만, 백엔드가 함께 알린 일(notes)이 있으면 닫을 때까지 남는다.
 * 새 안내는 알릴 일이 남은 안내를 덮지 않고, 그렇지 않은 이전 안내만 바꾼다.
 */
export function useApplyNotices() {
  const [notices, setNotices] = useState<ApplyNotice[]>([]);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const dismissNotice = useCallback((id: number) => {
    setNotices((all) => all.filter((n) => n.id !== id));
  }, []);

  /**
   * 안내를 띄우고 그 id를 돌려준다. 알릴 일이 남은 안내는 그대로 두고, 그렇지 않은 이전 안내만 새 안내로 바꾼다.
   * replaces에 앞서 띄운 안내의 id를 주면 그 안내도(알릴 일이 있어도) 이 안내로 바꾼다. 안내를 띄운 뒤에 알릴 일이 생겼을 때(적용은 했는데
   * 화면을 다시 읽지 못함 등) 같은 안내에 그 일을 더해 다시 띄우는 데 쓴다. 그 안내가 이미 사라졌어도(저절로, 또는 닫혀서) 새 안내를 띄운다.
   */
  const announce = useCallback((summary: string, notes: string[], replaces?: number): number => {
    const id = ++seq.current;
    clearTimeout(timer.current);
    setNotices((all) => [...all.filter((n) => n.id !== replaces && n.notes.length > 0), { id, summary, notes }]);
    if (notes.length === 0) {
      timer.current = setTimeout(() => setNotices((all) => all.filter((n) => n.id !== id)), NOTICE_MS);
    }
    return id;
  }, []);

  return { notices, announce, dismissNotice };
}

/**
 * 적용한 뒤 IAM 화면을 다시 읽는 일.
 * - invalidate: 그 프로필의 IAM 쿼리와 변경 기록을 낡은 것으로 표시해 바로 다시 읽게 한다.
 * - refreshLater: 3초 뒤에 overview를 force=true로 한 번 더 읽는다(IAM 반영 지연). 훅이 사라지면 아직 안 돈 예약은 취소한다.
 */
export function useIamRefresh() {
  const qc = useQueryClient();
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
    },
    [],
  );

  const invalidate = useCallback(
    (profile: string) => {
      void qc.invalidateQueries({ queryKey: iamKeys.root(profile) });
      void qc.invalidateQueries({ queryKey: iamKeys.changeLog });
    },
    [qc],
  );

  const refreshLater = useCallback(
    (profile: string) => {
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        void refreshIam(qc, profile);
      }, REFRESH_DELAY_MS);
      timers.current.add(timer);
    },
    [qc],
  );

  return { invalidate, refreshLater };
}

/**
 * 열려 있는 흐름 하나(변경 또는 묶음)를 들고 있는 뼈대. P는 phase를 가진 그 흐름의 상태이고, Done은 적용에 성공했을 때 부르는 콜백이다.
 * - pending과 같은 값을 ref에도 바로 반영한다(commit): 여러 이벤트가 같은 렌더 안에서 연달아 와도 판단이 맞게.
 * - 탭이 닫힌 뒤에는 commit이 아무것도 하지 않는다: 늦게 온 응답이 닫힌 탭의 상태를 바꾸지 못한다. 응답을 받은 쪽은 alive로 탭이 아직 열려 있는지 묻고,
 *   안내를 띄우고 장바구니를 비우고 화면을 다시 읽는 일은 열려 있을 때만 한다.
 * - cancel은 적용 중이 아닐 때만 흐름을 닫는다. 이미 보낸 요청은 되돌릴 수 없다.
 * - 프로필이 바뀌면 열려 있던 흐름을 버린다: 다른 계정에 낡은 미리보기를 적용하면 안 된다. 적용 중인 요청은 거둘 수 없어서 그대로 둔다.
 * 요청을 만드는 쪽(load, start, apply)은 각 훅이 맡는다. seq는 미리보기를 받을 때마다 오르는 번호이고, inFlight는 적용 요청이 나가 있는 동안 켜 둔다.
 */
export function usePendingFlow<P extends { phase: string }, Done>(profile: string) {
  const [pending, setPending] = useState<P | null>(null);
  // 여러 이벤트가 같은 렌더 안에서 연달아 와도 판단이 맞도록, 상태와 같은 값을 ref에도 바로 반영한다.
  const pendingRef = useRef<P | null>(null);
  const profileRef = useRef(profile);
  profileRef.current = profile;
  const seq = useRef(0);
  const inFlight = useRef(false);
  const onApplied: MutableRefObject<Done | undefined> = useRef<Done | undefined>(undefined);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const commit = useCallback((next: P | null) => {
    if (!alive.current) return;
    pendingRef.current = next;
    setPending(next);
  }, []);

  const cancel = useCallback(() => {
    if (pendingRef.current?.phase === "applying") return; // 이미 보낸 요청은 되돌릴 수 없다
    seq.current++;
    onApplied.current = undefined;
    commit(null);
  }, [commit]);

  useEffect(() => {
    seq.current++;
    onApplied.current = undefined;
    if (pendingRef.current?.phase !== "applying") commit(null);
  }, [profile, commit]);

  return { pending, pendingRef, profileRef, seq, inFlight, onApplied, alive, commit, cancel };
}
