import { useCallback, useState } from "react";

const NONE: string[] = [];

interface Stored {
  profile: string;
  arns: string[];
}

/**
 * 할당 표에서 [열 추가]로 더한 정책의 ARN을 더한 순서대로 들고 있다.
 * 장바구니(useAssignmentDraft)와 수명이 같다. IamTab이 들고 있어서 IAM 안의 다른 화면을 보고 돌아와도 남고,
 * 프로필이 바뀌면 비워진다. 비우는 일은 렌더 중에 끝내므로 다른 프로필의 목록은 한 번도 그려지지 않는다.
 */
export function useAddedColumns(profile: string) {
  const [stored, setStored] = useState<Stored>({ profile, arns: NONE });
  if (stored.profile !== profile) setStored({ profile, arns: NONE });
  const arns = stored.profile === profile ? stored.arns : NONE;

  // 다른 프로필로 넘어간 뒤에 늦게 불린 옛 콜백은 새 프로필의 목록을 건드리지 않는다
  const add = useCallback(
    (arn: string) =>
      setStored((cur) => {
        if (cur.profile !== profile || cur.arns.includes(arn)) return cur;
        return { profile, arns: [...cur.arns, arn] };
      }),
    [profile],
  );

  return { arns, add };
}
