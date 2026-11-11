export interface AttributeChange {
  name: string;
  /** 이전 이미지의 값. 이미지에 속성이 없으면 undefined */
  before: unknown;
  after: unknown;
  changed: boolean;
}

/** 이전·새 이미지를 속성 이름 순으로 맞대 보인다. 한쪽에만 있거나 값이 다르면 바뀐 것이다. 두 이미지가 모두 없으면 빈 목록 */
export function diffImages(beforeImage: Record<string, unknown> | null | undefined, afterImage: Record<string, unknown> | null | undefined): AttributeChange[] {
  const before = beforeImage ?? {};
  const after = afterImage ?? {};
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return names.map((name) => ({
    name,
    before: before[name],
    after: after[name],
    changed: JSON.stringify(before[name]) !== JSON.stringify(after[name]),
  }));
}
