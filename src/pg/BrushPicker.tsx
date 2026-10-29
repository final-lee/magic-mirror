import { Fragment, useId } from "react";
import { BRUSHES, type BrushId } from "./brush";

interface Props {
  value: BrushId;
  onChange: (id: BrushId) => void;
}

/**
 * "칠할 권한": 권한 표를 바꾸기 모드로 쓸 때 칸을 눌러 담을 권한 하나를 고른다. 늘 하나가 골라져 있다(라디오).
 * 앞의 넷(사용·만들기·읽기·쓰기)은 스키마 칸에, 뒤의 셋(CONNECT·CREATE·TEMP)은 데이터베이스 열의 칸에 칠한다. 열 머리의 안내와 같은 이름, 같은 차례다.
 */
export function BrushPicker({ value, onChange }: Props) {
  const name = useId();
  return (
    <div className="pg-brushes" role="group" aria-label="칠할 권한">
      {BRUSHES.map((brush, i) => (
        <Fragment key={brush.id}>
          {i > 0 && BRUSHES[i - 1].scope !== brush.scope && <span className="pg-brush-sep" aria-hidden="true" />}
          <label className={`pg-chip${brush.id === value ? " on" : ""}`}>
            <input type="radio" name={name} checked={brush.id === value} onChange={() => onChange(brush.id)} /> {brush.label}
          </label>
        </Fragment>
      ))}
    </div>
  );
}
