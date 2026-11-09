import { describe, expect, it } from "vitest";
import { UNDO_WINDOW_MS, canUndo, pendingOutcome, undoUntilFor, type PromptFacts } from "../src/lib/machines/assistant";

const now = Date.parse("2026-10-09T08:00:00.000Z");

describe("assistant undo window", () => {
  it("gives an assistant-saved transaction ten seconds of Undo", () => {
    expect(UNDO_WINDOW_MS).toBe(10_000);
    expect(Date.parse(undoUntilFor("assistant", now)!) - now).toBe(10_000);
  });

  it("gives a manual transaction no Undo window", () => {
    expect(undoUntilFor("manual", now)).toBeNull();
  });

  it("allows Undo for an assistant transaction up to and including the window end", () => {
    const undoUntil = undoUntilFor("assistant", now);
    expect(canUndo({ source: "assistant", undoUntil }, now)).toBe(true);
    expect(canUndo({ source: "assistant", undoUntil }, now + 10_000)).toBe(true);
    expect(canUndo({ source: "assistant", undoUntil }, now + 10_001)).toBe(false);
  });

  it("refuses Undo for a manual transaction or one with no window", () => {
    expect(canUndo({ source: "manual", undoUntil: undoUntilFor("assistant", now) }, now)).toBe(false);
    expect(canUndo({ source: "assistant", undoUntil: null }, now)).toBe(false);
  });
});

const prompt = (facts: Partial<PromptFacts>): PromptFacts => ({ bareAmount: false, yesOrNo: false, paymentWording: false, hasNumber: false, namesOpenDebt: false, ...facts });

describe("pending follow-up outcome", () => {
  it("does nothing when no question is pending", () => {
    expect(pendingOutcome(null, prompt({ hasNumber: true }))).toBe("none");
  });

  it("answers a pending repayment amount with a bare amount", () => {
    expect(pendingOutcome("repayment_amount", prompt({ bareAmount: true, hasNumber: true }))).toBe("answer");
  });

  it("replaces a pending repayment or income question with a complete unrelated request", () => {
    expect(pendingOutcome("repayment_amount", prompt({ hasNumber: true }))).toBe("replace");
    expect(pendingOutcome("repayment_payer", prompt({ hasNumber: true }))).toBe("replace");
    expect(pendingOutcome("ordinary_income", prompt({ hasNumber: true }))).toBe("replace");
  });

  it("answers a pending payer question when the reply names a person with an open debt", () => {
    expect(pendingOutcome("repayment_payer", prompt({ hasNumber: true, namesOpenDebt: true }))).toBe("answer");
  });

  it("answers with payment wording, yes or no, or no amount", () => {
    expect(pendingOutcome("repayment_amount", prompt({ paymentWording: true, hasNumber: true }))).toBe("answer");
    expect(pendingOutcome("ordinary_income", prompt({ yesOrNo: true, hasNumber: true }))).toBe("answer");
    expect(pendingOutcome("repayment_amount", prompt({}))).toBe("answer");
  });

  it("keeps answering the other pending questions, which the code resolves from context", () => {
    expect(pendingOutcome("clarification", prompt({ hasNumber: true }))).toBe("answer");
    expect(pendingOutcome("account_or_date", prompt({ hasNumber: true }))).toBe("answer");
  });
});
