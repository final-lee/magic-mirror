const WIDTH = 120;
const HEIGHT = 30;

/** 값이 null인 곳(읽지 못한 때, 관측이 없던 때)에서 끊어 이은 선들 */
export function segments(values: (number | null)[]): number[][][] {
  const parts: number[][][] = [];
  let current: number[][] = [];
  values.forEach((value, i) => {
    if (value === null) {
      if (current.length) parts.push(current);
      current = [];
    } else {
      current.push([i, value]);
    }
  });
  if (current.length) parts.push(current);
  return parts;
}

/** 작은 꺾은선. 값이 둘 미만이면 점 하나로 그린다. 세로 축은 0부터 최댓값까지 */
export function Spark({ values, label, color = "var(--log-c1)" }: { values: (number | null)[]; label: string; color?: string }) {
  const known = values.filter((v): v is number => v !== null);
  const max = Math.max(1e-12, ...known);
  const x = (i: number) => (values.length <= 1 ? WIDTH / 2 : (i / (values.length - 1)) * WIDTH);
  const y = (v: number) => HEIGHT - 2 - (Math.max(0, v) / max) * (HEIGHT - 4);
  return (
    <svg className="argo-spark" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <line className="argo-spark-base" x1="0" x2={WIDTH} y1={HEIGHT - 1} y2={HEIGHT - 1} />
      {segments(values).map((part, i) =>
        part.length === 1 ? (
          <circle key={i} cx={x(part[0][0])} cy={y(part[0][1])} r="2" fill={color} />
        ) : (
          <polyline key={i} points={part.map(([index, value]) => `${x(index)},${y(value)}`).join(" ")} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        ),
      )}
    </svg>
  );
}
