export function RawModal({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  return (
    <div
      className="modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet wide" role="dialog" aria-label={`${title} 원본 데이터`}>
        <h3>{title}</h3>
        <pre className="raw">{text}</pre>
        <div className="foot">
          <button className="btn primary" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
