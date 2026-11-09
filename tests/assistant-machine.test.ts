import { describe, expect, it } from "vitest";
import { UNDO_WINDOW_MS, canUndo, pendingOutcome, undoUntilFor, type PromptFacts } from "../src/lib/machines/assistant";
import { promptFacts } from "../src/lib/assistant";

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

const prompt = (facts: Partial<PromptFacts>): PromptFacts => ({ yesOrNo: false, paymentWording: false, hasNumber: false, ownSubject: false, namesOpenDebt: false, ...facts });

describe("pending follow-up outcome", () => {
  it("does nothing when no question is pending", () => {
    expect(pendingOutcome(null, prompt({ hasNumber: true }))).toBe("none");
  });

  it("answers a pending repayment amount with a bare amount", () => {
    expect(pendingOutcome("repayment_amount", prompt({ hasNumber: true }))).toBe("answer");
  });

  it("replaces a pending repayment or income question with a complete unrelated request", () => {
    expect(pendingOutcome("repayment_amount", prompt({ hasNumber: true, ownSubject: true }))).toBe("replace");
    expect(pendingOutcome("repayment_payer", prompt({ hasNumber: true, ownSubject: true }))).toBe("replace");
    expect(pendingOutcome("ordinary_income", prompt({ hasNumber: true, ownSubject: true }))).toBe("replace");
  });

  it("answers a pending payer question when the reply names a person with an open debt", () => {
    expect(pendingOutcome("repayment_payer", prompt({ hasNumber: true, ownSubject: true, namesOpenDebt: true }))).toBe("answer");
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

describe("pending follow-up outcome for real prompt wording", () => {
  const pendingQuestions = ["repayment_amount", "repayment_payer", "ordinary_income"] as const;
  const outcomeFor = (pending: (typeof pendingQuestions)[number], prompt: string, openCounterparties: string[] = []) =>
    pendingOutcome(pending, promptFacts(prompt, openCounterparties));

  const amountAnswers = ["500", "P500", "p500", "P 500", "PHP 500", "Php500", "₱500", "₱ 1,000", "500 pesos", "500 peso", "500 po", "500 pesos po", "it was 500", "It's P500", "about 500", "1,000.50", "P1,000.50", "500.", "just 500"];
  for (const answer of amountAnswers) {
    it(`treats "${answer}" as an answer to every pending question`, () => {
      for (const pending of pendingQuestions) expect(outcomeFor(pending, answer)).toBe("answer");
    });
  }

  const ownRequests = ["Coffee 120", "Coffee 120 from Missing", "Jollibee lunch 250", "Taxi P85", "lunch 250 yesterday", "Grab 1,200.50"];
  for (const request of ownRequests) {
    it(`replaces every pending question with the complete request "${request}"`, () => {
      for (const pending of pendingQuestions) expect(outcomeFor(pending, request)).toBe("replace");
    });
  }

  it("still answers with wording that is not an amount-only reply", () => {
    for (const pending of pendingQuestions) {
      expect(outcomeFor(pending, "Coffee")).toBe("answer");
      expect(outcomeFor(pending, "yes")).toBe("answer");
      expect(outcomeFor(pending, "Ana paid me 500")).toBe("answer");
    }
    expect(outcomeFor("repayment_payer", "Ana 500", ["Ana"])).toBe("answer");
  });
});
