import { describe, expect, it } from "vitest";
import { UNDO_WINDOW_MS, cancelHint, canUndo, pendingOutcome, undoUntilFor } from "../src/lib/machines/assistant";
import { FOLLOWUP_KINDS } from "../src/lib/assistant-followup";

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

describe("pending follow-up outcome", () => {
  it("does nothing when no question is pending, so a cancel phrase is an ordinary prompt", () => {
    for (const reply of ["cancel", "Coffee 120", "500"]) expect(pendingOutcome(null, reply)).toBe("none");
  });

  // Only an exact, normalized phrase ends a question. The whole prompt must equal one of them.
  const cancels = [
    "cancel", "Cancel", "CANCEL", "cancel.", "Cancel!", "  cancel  ", "never mind", "Never mind.", "nevermind", "never-mind", "skip", "forget it", "Forget it!", "stop", "Stop.",
    "ayoko na", "Ayoko na!", "wag na", "huwag na", "Huwag na.", "di na",
  ];
  for (const reply of cancels) {
    it(`cancels every pending question for the exact phrase "${reply}"`, () => {
      for (const pending of FOLLOWUP_KINDS) expect(pendingOutcome(pending, reply)).toBe("cancel");
    });
  }

  const answers = [
    // round 4: a category word with a real answer or payment statement
    "she paid back the food money, 500", "for the food, 500", "bayad sa food 500", "binayaran nya yung food 500", "She paid for the Transport 200",
    "He paid back the food money, 500", "She paid 500 for lunch",
    // round 4: hedge words with a category, and an account whose name holds a category word
    "I guess Food 500", "Food about 500", "siguro Food 500", "siguro Other income 500", "hindi Food 500", "to Food Wallet 500", "500 to Food Wallet",
    // earlier rounds: amount forms, hedges, details, requests of their own
    "500", "P500", "5k", "maybe 500", "not 500", "500 cash", "500 sa GCash", "about 500", "She paid 500", "mga 500", "5 hundred", "500 ata",
    "Coffee 120", "coffee 120", "lunch 250", "Grab 180", "Jollibee lunch 250", "bought coffee 120", "Coffee", "Other",
    // yes and no keep their own meaning at a pending yes or no question
    "yes", "no", "nope", "nah", "Ana paid me 500",
    // near misses of a cancel phrase
    "cancel the coffee 120", "skip 500", "stop paying me", "cancel it", "please cancel", "don't cancel", "never mind 500", "stop 500", "forget it 120", "cancelled", "canceling", "skipping", "di na 500",
    "", "   ", "!!!",
  ];
  for (const reply of answers) {
    it(`treats "${reply}" as an answer to every pending question`, () => {
      for (const pending of FOLLOWUP_KINDS) expect(pendingOutcome(pending, reply)).toBe("answer");
    });
  }
});

describe("cancel hint on a question asked again", () => {
  it("names the way out for each question the code asks again", () => {
    expect(cancelHint("repayment_amount", "repayment_amount")).toBe("Reply with the amount, or say cancel to drop this.");
    expect(cancelHint("repayment_payer", "repayment_payer")).toBe("Reply with the person's name, or say cancel to drop this.");
    for (const kind of ["ordinary_income", "account_or_date", "bill_name", "bill_amount", "bill_amount_account", "bill_start_date", "bill_end_date", "bill_dates", "bill_several", "bill_duplicate", "bill_schedule", "bill_account", "bill_details"] as const) {
      expect(cancelHint(kind, kind)).toBe("Or say cancel to drop this.");
    }
  });

  it("has no hint on a first ask, which no question preceded", () => {
    for (const kind of FOLLOWUP_KINDS) expect(cancelHint(null, kind)).toBeNull();
  });

  it("has no hint when the code asks nothing, or for a model-worded or offered question", () => {
    for (const pending of FOLLOWUP_KINDS) expect(cancelHint(pending, null)).toBeNull();
    expect(cancelHint("clarification", "clarification")).toBeNull();
    expect(cancelHint("debt_transaction", "debt_transaction")).toBeNull();
    expect(cancelHint("repayment_amount", "clarification")).toBeNull();
  });

  it("has a hint when the repayment and income questions lead to each other, and not across other kinds", () => {
    const linked = ["repayment_amount", "repayment_payer", "ordinary_income"] as const;
    for (const pending of linked) for (const asked of linked) expect(cancelHint(pending, asked)).not.toBeNull();
    expect(cancelHint("bill_name", "bill_amount")).toBeNull();
    expect(cancelHint("account_or_date", "repayment_amount")).toBeNull();
    expect(cancelHint("repayment_amount", "account_or_date")).toBeNull();
  });
});
