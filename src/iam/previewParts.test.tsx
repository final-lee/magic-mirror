import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ConfirmField, DELTA, objectParticle, useSheetFocus } from "./previewParts";

describe("objectParticle", () => {
  test("a Hangul syllable with a final consonant takes 을", () => {
    expect(objectParticle("적용")).toBe("을"); // ㅇ
    expect(objectParticle("변경 3개 적용")).toBe("을");
    expect(objectParticle("한글")).toBe("을"); // ㄹ
    expect(objectParticle("값")).toBe("을"); // ㅄ
    expect(objectParticle("각")).toBe("을");
    expect(objectParticle("힣")).toBe("을"); // 마지막 한글 음절
  });

  test("a Hangul syllable without a final consonant takes 를", () => {
    expect(objectParticle("사과")).toBe("를");
    expect(objectParticle("변경 3개")).toBe("를");
    expect(objectParticle("가")).toBe("를"); // 첫 한글 음절
  });

  test("anything that does not end in a Hangul syllable takes 를: Latin names, key ids, digits, empty", () => {
    expect(objectParticle("bob")).toBe("를");
    expect(objectParticle("AKIAIOSFODNN7EXAMPLE")).toBe("를");
    expect(objectParticle("ci-bot")).toBe("를");
    expect(objectParticle("변경 3")).toBe("를");
    expect(objectParticle("")).toBe("를");
  });

  test("only the last character counts", () => {
    expect(objectParticle("bob이")).toBe("를"); // 이: 받침 없음
    expect(objectParticle("적용bob")).toBe("를");
    expect(objectParticle("bob적용")).toBe("을");
  });

  test("a lone jamo is not a syllable", () => {
    expect(objectParticle("ㄱ")).toBe("를");
    expect(objectParticle("ㅏ")).toBe("를");
  });
});

describe("DELTA", () => {
  test("the class, label and sign of each direction, which the PostgreSQL preview shares", () => {
    expect(DELTA).toEqual({
      gained: { className: "cp-gain", label: "얻는 권한", sign: "＋" },
      lost: { className: "cp-lose", label: "잃는 권한", sign: "－" },
      restricted: { className: "cp-cond", label: "조건부로 바뀜", sign: "～" },
    });
  });
});

describe("ConfirmField", () => {
  function setup(required: string, extra: { mismatchHint?: string } = {}) {
    function Host() {
      const [typed, setTyped] = useState("");
      return <ConfirmField required={required} typed={typed} onTyped={setTyped} locked={false} {...extra} />;
    }
    render(<Host />);
    return (value: string) => fireEvent.change(screen.getByRole("textbox"), { target: { value } });
  }

  test("asks for the text with the particle that fits its last letter", () => {
    const { unmount } = render(<ConfirmField required="변경 3개 적용" typed="" onTyped={() => {}} locked={false} />);
    expect(screen.getByLabelText("확인하려면 변경 3개 적용을 입력하세요")).toBeInTheDocument();
    expect(screen.getByText("확인하려면 변경 3개 적용을 입력하세요")).toBeInTheDocument();
    unmount();
    render(<ConfirmField required="bob" typed="" onTyped={() => {}} locked={false} />);
    expect(screen.getByLabelText("확인하려면 bob를 입력하세요")).toBeInTheDocument();
    expect(screen.getByText("확인하려면 bob를 입력하세요")).toBeInTheDocument();
  });

  test("a label the caller words replaces the question, on the field and for screen readers: no particle is put after the name", () => {
    render(<ConfirmField required="bob" typed="" onTyped={() => {}} locked={false} label="확인하려면 입력하세요: bob" />);
    expect(screen.getByLabelText("확인하려면 입력하세요: bob")).toBeInTheDocument();
    expect(screen.getByText("확인하려면 입력하세요: bob")).toBeInTheDocument();
    expect(screen.queryByText(/bob를|bob을/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("확인하려면 bob를 입력하세요")).not.toBeInTheDocument();
  });

  test("the label changes only the question: what has to be typed and the hint still follow `required`", () => {
    function Host() {
      const [typed, setTyped] = useState("");
      return <ConfirmField required="bob" typed={typed} onTyped={setTyped} locked={false} label="확인하려면 입력하세요: bob" />;
    }
    render(<Host />);
    const type = (value: string) => fireEvent.change(screen.getByRole("textbox"), { target: { value } });
    expect(screen.getByLabelText("확인하려면 입력하세요: bob")).toBeInTheDocument();
    type("bo");
    expect(screen.queryByText("입력한 이름이 달라요")).not.toBeInTheDocument();
    type("bx");
    expect(screen.getByText("입력한 이름이 달라요")).toBeInTheDocument();
  });

  test("tells that the name differs unless the caller words it otherwise", () => {
    const type = setup("bob");
    type("bo");
    expect(screen.queryByText("입력한 이름이 달라요")).not.toBeInTheDocument();
    type("bx");
    expect(screen.getByText("입력한 이름이 달라요")).toBeInTheDocument();
  });

  test("uses the caller's wording for the hint", () => {
    const type = setup("변경 3개 적용", { mismatchHint: "입력한 문구가 달라요" });
    type("변경 4");
    expect(screen.getByText("입력한 문구가 달라요")).toBeInTheDocument();
    expect(screen.queryByText("입력한 이름이 달라요")).not.toBeInTheDocument();
  });
});

describe("useSheetFocus", () => {
  /** 두 미리보기 창이 쓰는 뼈대만 가진 창: 취소, (있으면) 다시 받기, 적용 */
  function Sheet({ phase, onCancel, withRetry = false }: { phase: string; onCancel: () => void; withRetry?: boolean }) {
    const { sheetRef, trapTab, cancelRef, retryRef } = useSheetFocus(phase, onCancel);
    return (
      <div className="modal">
        <div ref={sheetRef} onKeyDown={trapTab} role="dialog" aria-label="시험 창">
          <button ref={cancelRef}>취소</button>
          {withRetry && <button ref={retryRef}>다시 받기</button>}
          <button>적용</button>
        </div>
      </div>
    );
  }
  const lose = () => (document.activeElement as HTMLElement).blur();

  test("the focus starts on 취소", () => {
    render(<Sheet phase="ready" onCancel={() => {}} />);
    expect(screen.getByRole("button", { name: "취소" })).toHaveFocus();
  });

  test("Escape cancels, except while applying", async () => {
    const onCancel = vi.fn();
    const { rerender } = render(<Sheet phase="ready" onCancel={onCancel} />);
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
    rerender(<Sheet phase="applying" onCancel={onCancel} />);
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("Tab goes round inside the window", async () => {
    render(<Sheet phase="ready" onCancel={() => {}} />);
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "적용" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "취소" })).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: "적용" })).toHaveFocus();
  });

  test("when an apply ends, the focus that the locked buttons lost goes back to 취소", () => {
    const { rerender } = render(<Sheet phase="ready" onCancel={() => {}} />);
    rerender(<Sheet phase="applying" onCancel={() => {}} />);
    lose();
    rerender(<Sheet phase="result" onCancel={() => {}} />);
    expect(screen.getByRole("button", { name: "취소" })).toHaveFocus();
  });

  test("or to 다시 받기 when there is one", () => {
    const { rerender } = render(<Sheet phase="ready" onCancel={() => {}} withRetry />);
    rerender(<Sheet phase="applying" onCancel={() => {}} withRetry />);
    lose();
    rerender(<Sheet phase="ready" onCancel={() => {}} withRetry />);
    expect(screen.getByRole("button", { name: "다시 받기" })).toHaveFocus();
  });

  test("a phase change that does not end an apply leaves the focus where it is", () => {
    const { rerender } = render(<Sheet phase="loading" onCancel={() => {}} />);
    lose();
    rerender(<Sheet phase="ready" onCancel={() => {}} />);
    expect(document.body).toHaveFocus();
  });
});
