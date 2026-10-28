interface Props {
  notice: {
    summary: string;
    /** 바꾸기는 했지만 하지 못한 일(변경 기록 저장 등). 있으면 사용자가 닫을 때까지 남는다 */
    notes: string[];
  };
  /** 요약 뒤에 붙는 짧은 안내. IAM은 반영이 늦어진다는 말을 붙이고, 커밋하면 바로 보이는 PostgreSQL은 주지 않는다 */
  hint?: string;
  onDismiss: () => void;
}

/** 적용을 마친 뒤의 안내 한 줄. IAM 탭과 PostgreSQL 탭이 함께 쓴다. 함께 알릴 일(notes)이 있으면 사용자가 닫을 때까지 남는다 */
export function DoneNotice({ notice, hint, onDismiss }: Props) {
  return (
    <div className="iam-done" role="status">
      <span aria-hidden="true">✓</span> <span>{notice.summary}</span>
      {hint && (
        <>
          {" "}
          <span className="dim">{hint}</span>
        </>
      )}
      <button className="icon" aria-label="알림 닫기" onClick={onDismiss}>
        ✕
      </button>
      {/* 바꾸기는 했지만 하지 못한 일(변경 기록 저장 등). 이 안내는 닫을 때까지 남는다 */}
      {notice.notes.length > 0 && (
        <ul className="iam-done-notes" aria-label="함께 알릴 일">
          {/* 같은 안내가 여러 번 올 수 있고(되돌림 표시를 못 한 기록마다 같은 문구) 목록은 순서가 바뀌지 않아서, 글이 아니라 순서를 키로 쓴다 */}
          {notice.notes.map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
