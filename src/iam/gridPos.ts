/** 표 안의 자리. r: 데이터 행(-1이면 열 머리 행), c: 열(-1이면 행 머리 열) */
export interface Pos {
  r: number;
  c: number;
}

export const posKey = (r: number, c: number) => `${r}:${c}`;

export function parsePos(key: string): Pos {
  const [r, c] = key.split(":").map(Number);
  return { r, c };
}

/**
 * from에서 to까지 격자 위의 곧은 선이 지나는 칸을 지나는 차례대로 돌려준다. from은 빼고 to는 넣는다.
 * 더 많이 움직이는 쪽으로 한 칸씩 나아가고 다른 쪽은 선을 따라 반올림해서, 이어지는 두 칸은 늘 이웃이다(건너뛰는 칸이 없다).
 * 같은 행이나 같은 열이면 사이의 칸이 전부, 비스듬하면 대각선에 걸리는 칸이 나온다.
 */
export function cellsBetween(from: Pos, to: Pos): Pos[] {
  const dr = to.r - from.r;
  const dc = to.c - from.c;
  const steps = Math.max(Math.abs(dr), Math.abs(dc));
  const cells: Pos[] = [];
  for (let i = 1; i <= steps; i++) cells.push({ r: from.r + Math.round((dr * i) / steps), c: from.c + Math.round((dc * i) / steps) });
  return cells;
}
