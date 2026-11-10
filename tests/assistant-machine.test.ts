import { describe, expect, it } from "vitest";
import { OPEN_RUN_LIMIT, UNDO_WINDOW_MS, cancelHint, cancelReply, canUndo, capOpenRun, followupAfterTurn, pendingOutcome, runSavedDebt, turnMayCommit, undoUntilFor } from "../src/lib/machines/assistant";
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

describe("the open run that reaches the model", () => {
  const run = (length: number) => Array.from({ length }, (_, index) => `m${index}`);

  it("keeps a run whole up to the limit", () => {
    expect(OPEN_RUN_LIMIT).toBe(12);
    for (const length of [0, 1, 2, 11, 12]) expect(capOpenRun(run(length))).toEqual(run(length));
  });

  it("keeps the first message and the most recent ones, and drops the oldest of the middle", () => {
    expect(capOpenRun(run(13))).toEqual(["m0", ...run(13).slice(2)]);
    expect(capOpenRun(run(40))).toEqual(["m0", ...run(40).slice(29)]);
    expect(capOpenRun(run(40))).toHaveLength(OPEN_RUN_LIMIT);
    expect(capOpenRun(run(5), 3)).toEqual(["m0", "m3", "m4"]);
  });

  it("does not change the run it is given", () => {
    const original = run(20);
    capOpenRun(original);
    expect(original).toEqual(run(20));
  });
});

describe("the pending question a turn stores", () => {
  it("keeps the pending question for a turn that only reads or saved a bill and asked nothing", () => {
    for (const pending of FOLLOWUP_KINDS) expect(followupAfterTurn(pending, null, true)).toBe(pending);
  });

  it("ends the pending question for any other turn that asked nothing, such as a completed write", () => {
    for (const pending of FOLLOWUP_KINDS) expect(followupAfterTurn(pending, null, false)).toBeNull();
  });

  it("lets a turn that asks its own question replace the pending one, whether or not it read anything", () => {
    for (const pending of FOLLOWUP_KINDS) {
      expect(followupAfterTurn(pending, "bill_name", true)).toBe("bill_name");
      expect(followupAfterTurn(pending, "clarification", false)).toBe("clarification");
    }
  });

  it("stores no question when none was pending and the turn asked nothing", () => {
    expect(followupAfterTurn(null, null, true)).toBeNull();
    expect(followupAfterTurn(null, null, false)).toBeNull();
    expect(followupAfterTurn(null, "repayment_amount", false)).toBe("repayment_amount");
  });
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

  it("has no hint on a question the model worded, whatever kind it is stored under", () => {
    for (const pending of FOLLOWUP_KINDS) for (const asked of FOLLOWUP_KINDS) expect(cancelHint(pending, asked, true)).toBeNull();
    expect(cancelHint("repayment_amount", "repayment_amount", false)).toBe("Reply with the amount, or say cancel to drop this.");
  });

  it("has a hint when the repayment and income questions lead to each other, and not across other kinds", () => {
    const linked = ["repayment_amount", "repayment_payer", "ordinary_income"] as const;
    for (const pending of linked) for (const asked of linked) expect(cancelHint(pending, asked)).not.toBeNull();
    expect(cancelHint("bill_name", "bill_amount")).toBeNull();
    expect(cancelHint("account_or_date", "repayment_amount")).toBeNull();
    expect(cancelHint("repayment_amount", "account_or_date")).toBeNull();
  });
});

describe("a turn commits only if the conversation is where it read it", () => {
  it("commits while the last message is the one the turn read", () => {
    expect(turnMayCommit("message-7", "message-7")).toBe(true);
    expect(turnMayCommit(null, null)).toBe(true);
  });

  it("refuses when another request stored a message in between, however it ended", () => {
    expect(turnMayCommit("message-7", "message-9")).toBe(false);
    expect(turnMayCommit(null, "message-1")).toBe(false);
  });
});

describe("what a cancel says about the dropped question", () => {
  const nothingRecorded = "Okay, I dropped that question. Nothing was recorded.";
  const debtStays = "Okay, I dropped that question. The debt stays in Debts, and nothing was added to Transactions.";

  it("says the debt stays for the offer to add a just-saved debt to Transactions", () => {
    expect(cancelReply("debt_transaction", true)).toBe(debtStays);
    expect(cancelReply("debt_transaction", false)).toBe(debtStays);
  });

  // None of these asks anything after saving. The repayment, income, account or date, bill and generic questions
  // are all asked before the write they wait for, so nothing was recorded unless a debt came earlier in the run.
  for (const kind of FOLLOWUP_KINDS.filter((item) => item !== "debt_transaction")) {
    it(`says nothing was recorded for ${kind} when no debt was saved in the run`, () => {
      expect(cancelReply(kind, false)).toBe(nothingRecorded);
    });
    it(`says the debt stays for ${kind} when an earlier reply of the run saved one`, () => {
      expect(cancelReply(kind, true)).toBe(debtStays);
    });
  }

  it("finds a debt saved by any reply of the open run, and none before a reply that asked nothing", () => {
    const saved = { role: "assistant", followup: "debt_transaction", debtId: "debt-1" } as const;
    const ask = { role: "assistant", followup: "account_or_date", debtId: null } as const;
    const done = { role: "assistant", followup: null, debtId: "debt-0" } as const;
    const user = { role: "user" } as const;
    expect(runSavedDebt([user, saved])).toBe(true);
    expect(runSavedDebt([user, saved, user, ask])).toBe(true);
    expect(runSavedDebt([user, ask])).toBe(false);
    expect(runSavedDebt([user, done, user, ask])).toBe(false);
    expect(runSavedDebt([])).toBe(false);
  });
});
