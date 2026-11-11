import { useMemo, useRef, useState } from "react";
import { ErrorState } from "../../components/ErrorState";
import { RecordList } from "./RecordList";
import { RecordsToolbar } from "./RecordsToolbar";
import { ALL_EVENTS, toggleKind, visibleRecords } from "./records";
import * as t from "./text";
import type { StartFrom } from "./types";
import { useStreamSession } from "./useStreamSession";

interface Props {
  profile: string;
  region: string;
  table: string;
  active: boolean;
}

/**
 * 일시정지 동안 보이는 값을 붙잡아 둔다. 읽기는 멈추지 않으므로 반복자가 낡지 않고,
 * 재개하면 그동안 읽은 레코드가 한꺼번에 나타난다.
 */
function useHeldWhile<T>(hold: boolean, value: T): T {
  const held = useRef(value);
  if (!hold) held.current = value;
  return held.current;
}

/** 실시간 레코드 카드: 읽기 제어, 필터, 레코드 목록 */
export function LiveRecords({ profile, region, table, active }: Props) {
  const session = useStreamSession({ profile, region, table, active });
  const [from, setFrom] = useState<StartFrom>("LATEST");
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");
  const [kinds, setKinds] = useState<string[]>(ALL_EVENTS);

  const shown = useHeldWhile(paused && session.running, session.records);
  const records = useMemo(() => visibleRecords(shown, kinds, filter), [shown, kinds, filter]);

  const start = () => {
    setPaused(false);
    session.start(from);
  };

  return (
    <section className="ddb-card">
      <h4>{t.LIVE}</h4>
      <RecordsToolbar
        running={session.running}
        paused={paused}
        from={from}
        shards={session.shards}
        behind={session.behind}
        filter={filter}
        kinds={kinds}
        onFrom={setFrom}
        onStart={start}
        onStop={session.stop}
        onPause={setPaused}
        onFilter={setFilter}
        onToggleKind={(kind) => setKinds((current) => toggleKind(current, kind))}
      />
      {session.error && <ErrorState compact error={session.error} profile={profile} onRetry={start} />}
      <RecordList records={records} />
    </section>
  );
}
