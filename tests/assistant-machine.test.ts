import { describe, expect, it } from "vitest";
import { DECLINED_REPLY, MAX_OPEN_RUN_MESSAGES, REFUSED_AGAIN_REPLY, REFUSED_REPLY, UNDO_WINDOW_MS, cancelHint, cancelReply, debtContinuationRewrites, debtFlowContinues, debtOfferChainAnswer, isDebtOfferNo, isDebtOfferYes, isDebtRecordRefusal, DEBT_REFUSED_AGAIN_REPLY, ambiguityChoice, ambiguityVerdict, isAmbiguityQuestionOf, openQuestionOf, ambiguousHints, ambiguousHintsQuestion, canUndo, endedQuestionReply, expiredReply, followupAfterTurn, guardUserMessages, hasRestartWording, hintMessagesFor, hintReadingsFor, isAmbiguousHintsQuestion, readStatementStart, incomeAccountChoice, incomeChainAccount, incomeChainAnswers, isIncomeConfirmation, isOrdinaryIncomeDecline, isQuietReply, ordinaryIncomeTurn, ownUserMessages, pendingOutcome, refusalOutcome, runExpired, runSaved, startsNewStatement, turnCallOf, turnMayCommit, undoUntilFor, userMessagesFor, type DebtTransactionAnswer, type RefusalOutcome, type RunMessage, type TurnCall } from "../src/lib/machines/assistant";
import { FOLLOWUP_KINDS, type FollowupKind } from "../src/lib/assistant-followup";

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

describe("the ordinary income decline", () => {
  const declines = ["no", "No", "NO.", "nope", "Nope!", "nah", "no thanks", "No thanks!", "no thank you", "No, thank you.", "  no   thanks  ", "hindi", "Hindi.", "ayoko", "Ayoko!"];
  for (const reply of declines) {
    it(`reads "${reply}" as a decline`, () => expect(isOrdinaryIncomeDecline(reply)).toBe(true));
  }

  // A message that only starts with a no word says more than no. "not now" defers instead of refusing, so it is
  // not a decline either: the question is asked again with the way out.
  const notDeclines = [
    "No, use Wallet", "No, use Wallet. I still want to record it as income.", "no problem, yes record it", "not now", "no way", "Nope, but record it in Wallet",
    "no, 500", "nobody paid", "nowhere", "hindi Food 500", "hindi po", "ayoko na", "yes", "yes, no", "", "   ", "!!!",
  ];
  for (const reply of notDeclines) {
    it(`does not read "${reply}" as a decline`, () => expect(isOrdinaryIncomeDecline(reply)).toBe(false));
  }
});

// The ordinary income write needs the message being answered to be a yes itself. Nothing said earlier in the run can
// authorize it, so there is no held yes to veto: a reply is a confirmation, a decline, a read-only call or a re-ask.
describe("the ordinary income turn", () => {
  const confirmations = ["yes", "Yes.", "yeah", "yep, Wallet", "sure", "okay", "ok", "go ahead", "record it", "Record that", "yes, into my Wallet account", "  YES   please"];
  for (const reply of confirmations) {
    it(`reads "${reply}" as a confirmation`, () => expect(isIncomeConfirmation(reply)).toBe(true));
  }
  const notConfirmations = [
    "Wallet", "use Wallet", "Don't record it", "I changed my mind, don't record it", "Wallet, but don't record it", "Actually, skip recording it as income",
    "Not as income", "Hold on, don't record that", "No, use Wallet. I still want to record it as income.", "no problem, yes record it", "not now", "maybe", "500", "", "!!!",
    "Please record it", "I said yes earlier",
  ];
  for (const reply of notConfirmations) {
    it(`does not read "${reply}" as a confirmation`, () => expect(isIncomeConfirmation(reply)).toBe(false));
  }

  const calls: TurnCall[] = ["write", "bill", "read", "ask"];
  const table: [string, string, Record<TurnCall, ReturnType<typeof ordinaryIncomeTurn>>][] = [
    ["a plain yes", "yes", { write: "write", bill: "write", read: "write", ask: "write" }],
    ["a yes with the account", "yes, Wallet", { write: "write", bill: "write", read: "write", ask: "write" }],
    ["an exact decline", "no", { write: "decline", bill: "decline", read: "decline", ask: "decline" }],
    ["an exact decline phrase", "No thanks!", { write: "decline", bill: "decline", read: "decline", ask: "decline" }],
    ["a bare account", "Wallet", { write: "askAgain", bill: "askAgain", read: "read", ask: "askAgain" }],
    ["a refusal that does not lead with no", "Don't record it", { write: "askAgain", bill: "askAgain", read: "read", ask: "askAgain" }],
    ["a refusal that leads with no", "No, never mind", { write: "askAgain", bill: "askAgain", read: "read", ask: "askAgain" }],
    ["an unrelated finance question that leads with No", "No expenses this month? Show my spending totals.", { write: "askAgain", bill: "askAgain", read: "read", ask: "askAgain" }],
    ["a deferral", "not now", { write: "askAgain", bill: "askAgain", read: "read", ask: "askAgain" }],
  ];
  for (const [name, reply, expected] of table) {
    for (const call of calls) {
      it(`${name} with a ${call} call is ${expected[call]}`, () => expect(ordinaryIncomeTurn(reply, call)).toBe(expected[call]));
    }
  }

  it("lets only the current message authorize a write, whatever the provider's call", () => {
    for (const call of calls) {
      for (const reply of notConfirmations) expect(ordinaryIncomeTurn(reply, call)).not.toBe("write");
      for (const reply of confirmations) expect(ordinaryIncomeTurn(reply, call)).toBe("write");
    }
  });
  it("adds the cancel hint when the income question is asked again from its own account or date clarification", () => {
    expect(cancelHint("account_or_date", "ordinary_income")).toBe("Or say cancel to drop this.");
    expect(cancelHint("account_or_date", "ordinary_income", true)).toBeNull();
    expect(cancelHint(null, "ordinary_income")).toBeNull();
    expect(cancelHint("clarification", "ordinary_income")).toBeNull();
  });
});

// An income write takes an account from the current reply only. An earlier confirmation of the same income question that
// chose one makes a reply that names none ask again; it never chooses the account.
describe("the account an income write may use", () => {
  type Turn = [role: "user" | "assistant", text: string, followup?: FollowupKind | null, quiet?: boolean];
  const toRun = (turns: Turn[]) => turns.map(([role, content, followup, quiet]) => ({ role, content, followup: followup ?? null, ...(quiet ? { readOnly: true } : {}) }));
  // The caller's readers, stood in for here: a message names an account when it is "yes" and then Maya or Wallet, and a
  // message with the word "paid" has payment wording.
  const nameIn = (text: string) => /^yes[, ]+(Maya|Wallet)\b/.exec(text)?.[1];
  const opensPayment = (text: string) => /\bpaid\b/.test(text);
  const earlierAccount = (turns: Turn[]) => incomeChainAccount(incomeChainAnswers(toRun(turns), opensPayment), nameIn);
  const question: Turn[] = [["user", "Zed paid me 500 last Monday"], ["assistant", "Record as income?", "ordinary_income"]];
  const heldInMaya: Turn[] = [...question, ["user", "yes, Maya"], ["assistant", "What date?", "account_or_date"]];

  const chain: [string, Turn[], string | undefined][] = [
    ["the date clarification a confirmation led to", heldInMaya, "Maya"],
    ["the amount clarification a confirmation led to", [...question, ["user", "yes, Maya"], ["assistant", "What amount?", "clarification"]], "Maya"],
    ["a later confirmation naming another account", [...heldInMaya, ["user", "yes, Wallet"], ["assistant", "What date?", "account_or_date"]], "Wallet"],
    ["a later confirmation naming none keeps the earlier one", [...heldInMaya, ["user", "yes, 2026-10-05"], ["assistant", "What amount?", "clarification"]], "Maya"],
    ["a re-ask of the same question keeps the chain", [...heldInMaya, ["user", "Wallet"], ["assistant", "Please answer yes", "ordinary_income"]], "Maya"],
    ["a reply that is not a confirmation never counts", [...question, ["user", "Maya"], ["assistant", "Please answer yes", "ordinary_income"]], undefined],
    ["no confirmation names an account", [...question, ["user", "yes"], ["assistant", "What date?", "account_or_date"]], undefined],
    ["a quiet turn in between is left out", [...heldInMaya, ["user", "yes, Wallet"], ["assistant", "Your spending", "account_or_date", true]], "Maya"],
    ["a new payment question resets the chain", [...heldInMaya, ["user", "Bob paid me 200 into Wallet today"], ["assistant", "Record as income?", "ordinary_income"]], undefined],
    ["a payer pick never counts", [...question, ["user", "Ana and Maya paid me 500"], ["assistant", "Which person?", "repayment_payer"], ["user", "yes, Maya"], ["assistant", "What date?", "account_or_date"]], undefined],
    ["a payer pick between two income questions never counts", [...question, ["user", "Ana and Maya paid me 500"], ["assistant", "Which person?", "repayment_payer"], ["user", "yes, Maya"], ["assistant", "What date?", "account_or_date"], ["user", "Zed"], ["assistant", "Record as income?", "ordinary_income"]], undefined],
    ["a repayment amount question ends the chain", [...heldInMaya, ["user", "yes"], ["assistant", "How much?", "repayment_amount"]], undefined],
    ["no run", [], undefined],
  ];
  for (const [name, turns, expected] of chain) {
    it(`earlier choice: ${name} -> ${expected ?? "none"}`, () => expect(earlierAccount(turns)).toBe(expected));
  }

  const choice: [string, { confirmed?: string; names?: boolean }, string | undefined, ReturnType<typeof incomeAccountChoice<string>>][] = [
    ["the current reply names an account", { confirmed: "Wallet" }, undefined, { use: "account", account: "Wallet" }],
    ["the current reply overrides an earlier choice", { confirmed: "Wallet" }, "Maya", { use: "account", account: "Wallet" }],
    ["the current reply names an account by a cue word (or one that does not exist), which the ordinary reading decides", { names: true }, "Maya", { use: "none" }],
    ["the reply names none and an earlier confirmation chose one", {}, "Maya", { use: "ask", earlier: "Maya" }],
    ["no confirmation names an account", {}, undefined, { use: "none" }],
  ];
  for (const [name, current, earlier, expected] of choice) {
    it(`choice: ${name} -> ${expected.use}`, () => expect(incomeAccountChoice({ confirmed: current.confirmed, names: current.names ?? false }, earlier)).toEqual(expected));
  }
});

// Replaces the capOpenRun tests, which pinned a trim of the middle of a long run. No run is trimmed any more.
// A run that would grow past the limit ends its question instead.
describe("how long an open question run may grow", () => {
  const lengths = [0, 1, 2, 22, 23, 24, 25, 26, 100];
  const outcomes = ["none", "answer", "cancel"] as const;

  it("allows 24 messages", () => {
    expect(MAX_OPEN_RUN_MESSAGES).toBe(24);
  });

  for (const outcome of outcomes) {
    it(`expires a run of each length for a prompt that is a(n) ${outcome}`, () => {
      for (const length of lengths) {
        expect(runExpired(length, outcome), `${outcome} at ${length}`).toBe(outcome === "answer" && length >= MAX_OPEN_RUN_MESSAGES);
      }
    });
  }

  it("never expires an exact cancel or a prompt with nothing pending, however long the run", () => {
    for (const length of lengths) {
      expect(runExpired(length, "cancel")).toBe(false);
      expect(runExpired(length, "none")).toBe(false);
    }
  });

  it.each([
    [{ debt: false, bill: false }, "Nothing was recorded. Please send the details again."],
    [{ debt: true, bill: false }, "The debt stays in Debts, and nothing was added to Transactions."],
    [{ debt: false, bill: true }, "The bill stays in Bills, and nothing else was recorded."],
    [{ debt: true, bill: true }, "The debt stays in Debts and the bill stays in Bills."],
  ])("says what the run saved for %j", (saved, rest) => {
    expect(expiredReply(saved)).toBe(`That question has been open too long, so I dropped it. ${rest}`);
  });
});

describe("the pending question a turn stores", () => {
  const billKinds = FOLLOWUP_KINDS.filter((kind) => kind.startsWith("bill_"));
  const otherKinds = FOLLOWUP_KINDS.filter((kind) => !kind.startsWith("bill_"));

  it("keeps the pending question for a turn that only reads", () => {
    for (const pending of FOLLOWUP_KINDS) expect(followupAfterTurn(pending, null, "read")).toBe(pending);
  });

  it("keeps a pending question that is not about a bill when a bill is saved without a question", () => {
    for (const pending of otherKinds) expect(followupAfterTurn(pending, null, "billSaved")).toBe(pending);
  });

  it("consumes a pending bill question when a bill is saved without a question, because that save answered it", () => {
    for (const pending of billKinds) expect(followupAfterTurn(pending, null, "billSaved")).toBeNull();
  });

  it("ends the pending question for any other turn that asked nothing, such as a completed write", () => {
    for (const pending of FOLLOWUP_KINDS) expect(followupAfterTurn(pending, null, "other")).toBeNull();
  });

  it("lets a turn that asks its own question replace the pending one, whatever else the turn did", () => {
    for (const pending of FOLLOWUP_KINDS) {
      for (const turn of ["read", "billSaved", "other"] as const) {
        expect(followupAfterTurn(pending, "bill_name", turn)).toBe("bill_name");
        expect(followupAfterTurn(pending, "clarification", turn)).toBe("clarification");
      }
    }
  });

  it("stores no question when none was pending and the turn asked nothing", () => {
    for (const turn of ["read", "billSaved", "other"] as const) {
      expect(followupAfterTurn(null, null, turn)).toBeNull();
      expect(followupAfterTurn(null, "repayment_amount", turn)).toBe("repayment_amount");
    }
  });
});

describe("which user messages belong to the pending question", () => {
  const ask = { role: "assistant" as const, followup: "repayment_amount" as const };
  const user = (content: string) => ({ role: "user" as const, content });

  it.each([
    ["a question asked", { ...ask }, false],
    ["a read-only answer that kept the question", { ...ask, readOnly: true }, true],
    ["a bill saved that kept the question", { ...ask, billId: "bill-1" }, true],
    ["a bill saved that kept the question, and a read-only flag too", { ...ask, billId: "bill-1", readOnly: true }, true],
    ["a bill carried on a reply that ended the question", { role: "assistant" as const, followup: null, billId: "bill-1" }, false],
    ["a read-only reply with no pending question", { role: "assistant" as const, followup: null, readOnly: true }, false],
    ["a user message", { role: "user" as const, readOnly: true, billId: "bill-1", followup: "repayment_amount" as const }, false],
  ])("%s: quiet is %s", (_name, reply, quiet) => {
    expect(isQuietReply(reply)).toBe(quiet);
  });

  it("drops the user message of every quiet turn and keeps the statement, answers, re-asks and corrections", () => {
    const run: (RunMessage & { content?: string })[] = [
      user("Ana paid me"), { ...ask },
      user("Netflix using Savings, starts tomorrow"), { ...ask, billId: "bill-1" },
      user("Actually into Savings"), { ...ask },
      user("How much did I spend on 2026-09-30?"), { ...ask, readOnly: true },
      user("List my debts"), { ...ask, readOnly: true },
    ];

    expect(ownUserMessages(run).map((message) => message.content)).toEqual(["Ana paid me", "Actually into Savings"]);
  });

  it("keeps a user message that has no reply yet, and returns nothing for an empty run", () => {
    expect(ownUserMessages([user("Ana paid me")])).toEqual([user("Ana paid me")]);
    expect(ownUserMessages([])).toEqual([]);
  });

  it("never returns an assistant message", () => {
    expect(ownUserMessages([{ ...ask }, { ...ask, readOnly: true }])).toEqual([]);
  });
});

describe("which user messages each kind of read may see", () => {
  const ask = { role: "assistant" as const, followup: "repayment_amount" as const };
  const user = (content: string) => ({ role: "user" as const, content });
  const run: (RunMessage & { content?: string })[] = [
    user("Ana paid me"), { ...ask },
    user("Actually, Ana did not pay me. List my debts."), { ...ask, readOnly: true },
    user("Maybe I should track Netflix, 549 monthly"), { ...ask, billId: "bill-1" },
    user("Actually into Savings"), { ...ask },
  ];
  const contents = (messages: { content?: string }[]) => messages.map((message) => message.content);

  it.each([
    ["hint", ["Ana paid me", "Actually into Savings"]],
    ["guard", ["Ana paid me", "Actually, Ana did not pay me. List my debts.", "Maybe I should track Netflix, 549 monthly", "Actually into Savings"]],
  ] as const)("a %s reads %j", (use, expected) => {
    expect(contents(userMessagesFor(use, run))).toEqual(expected);
  });

  it("gives a guard every user message and a hint the same list the own-message rule gives", () => {
    expect(userMessagesFor("guard", run)).toEqual(guardUserMessages(run));
    expect(userMessagesFor("hint", run)).toEqual(ownUserMessages(run));
  });

  it("never hides a message from a guard that a hint can see", () => {
    for (const prefix of [[], run.slice(0, 2), run.slice(0, 4), run]) {
      const guarded = userMessagesFor("guard", prefix);
      for (const message of userMessagesFor("hint", prefix)) expect(guarded).toContain(message);
    }
  });

  it("returns nothing for an empty run and never an assistant message", () => {
    for (const use of ["hint", "guard"] as const) {
      expect(userMessagesFor(use, [])).toEqual([]);
      expect(userMessagesFor(use, [{ ...ask }, { ...ask, readOnly: true }])).toEqual([]);
    }
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
  const nothing = { debt: false, bill: false };
  const debtOnly = { debt: true, bill: false };
  const billOnly = { debt: false, bill: true };
  const both = { debt: true, bill: true };
  const nothingRecorded = "Okay, I dropped that question. Nothing was recorded.";
  const debtStays = "Okay, I dropped that question. The debt stays in Debts, and nothing was added to Transactions.";
  const billStays = "Okay, I dropped that question. The bill stays in Bills, and nothing else was recorded.";
  const bothStay = "Okay, I dropped that question. The debt stays in Debts and the bill stays in Bills.";

  it("says the debt stays for the offer to add a just-saved debt to Transactions, whatever else the run saved", () => {
    expect(cancelReply("debt_transaction", debtOnly)).toBe(debtStays);
    expect(cancelReply("debt_transaction", nothing)).toBe(debtStays);
    expect(cancelReply("debt_transaction", both)).toBe(bothStay);
    expect(cancelReply("debt_transaction", billOnly)).toBe(bothStay);
  });

  // None of these asks anything after saving. The repayment, income, account or date, bill and generic questions
  // are all asked before the write they wait for, so nothing was recorded unless something came earlier in the run.
  for (const kind of FOLLOWUP_KINDS.filter((item) => item !== "debt_transaction")) {
    it.each([
      [nothing, nothingRecorded],
      [debtOnly, debtStays],
      [billOnly, billStays],
      [both, bothStay],
    ])(`says what the run saved for ${kind}, %j`, (saved, reply) => {
      expect(cancelReply(kind, saved)).toBe(reply);
    });
  }

  it("finds a debt or a bill saved by any reply of the open run, and none before a reply that asked nothing", () => {
    const saved = { role: "assistant", followup: "debt_transaction", debtId: "debt-1" } as const;
    const billed = { role: "assistant", followup: "repayment_amount", billId: "bill-1" } as const;
    const ask = { role: "assistant", followup: "account_or_date", debtId: null } as const;
    const done = { role: "assistant", followup: null, debtId: "debt-0", billId: "bill-0" } as const;
    const user = { role: "user" } as const;
    expect(runSaved([user, saved])).toEqual(debtOnly);
    expect(runSaved([user, saved, user, ask])).toEqual(debtOnly);
    expect(runSaved([user, billed, user, ask])).toEqual(billOnly);
    expect(runSaved([user, saved, user, billed])).toEqual(both);
    expect(runSaved([user, ask])).toEqual(nothing);
    expect(runSaved([user, done, user, ask])).toEqual(nothing);
    expect(runSaved([])).toEqual(nothing);
  });
});

describe("the refusal decision a turn takes before it writes", () => {
  it.each([
    ["create_bill", "bill"], ["update_bill", "bill"],
    ["log_debt", "write"], ["log_transaction", "write"], ["record_debt_payment", "write"], ["record_debt_repayment", "write"],
    ["finance_question", "read"], ["ask_clarification", "ask"], ["something_new", "ask"], ["", "ask"],
  ] as const)("reads the call %j as %s", (name, expected) => {
    expect(turnCallOf(name)).toBe(expected);
  });

  const calls: TurnCall[] = ["write", "bill", "read", "ask"];
  // earlier: said in an earlier turn of the run, quiet turns included. now: said in the message being answered.
  const table: [string, { earlier: boolean; now: boolean }, FollowupKindOrNull, Record<TurnCall, RefusalOutcome>][] = [
    ["no refusal", { earlier: false, now: false }, "repayment_amount", { write: "proceed", bill: "proceed", read: "proceed", ask: "proceed" }],
    ["no refusal, nothing pending", { earlier: false, now: false }, null, { write: "proceed", bill: "proceed", read: "proceed", ask: "proceed" }],
    ["refusal in an earlier turn", { earlier: true, now: false }, "repayment_amount", { write: "askAgain", bill: "askAgain", read: "proceed", ask: "refuse" }],
    ["refusal in an earlier turn on an income question", { earlier: true, now: false }, "ordinary_income", { write: "askAgain", bill: "askAgain", read: "proceed", ask: "refuse" }],
    ["refusal in this message", { earlier: false, now: true }, "repayment_amount", { write: "refuse", bill: "endQuestion", read: "proceed", ask: "refuse" }],
    ["refusal in this message, nothing pending", { earlier: false, now: true }, null, { write: "refuse", bill: "endQuestion", read: "refuse", ask: "refuse" }],
    ["refusal in both", { earlier: true, now: true }, "repayment_amount", { write: "askAgain", bill: "askAgain", read: "proceed", ask: "refuse" }],
    ["a refusal with nothing pending cannot be an earlier one, but never writes if it is", { earlier: true, now: false }, null, { write: "refuse", bill: "refuse", read: "refuse", ask: "refuse" }],
  ];
  type FollowupKindOrNull = (typeof FOLLOWUP_KINDS)[number] | null;
  it.each(table)("%s", (_name, refusal, pending, expected) => {
    for (const call of calls) expect(refusalOutcome(refusal, pending, call)).toBe(expected[call]);
  });

  it("lets a call write only when no refusal applies, or when a bill shares the message that carries it", () => {
    for (const earlier of [false, true]) for (const now of [false, true]) for (const pending of [null, ...FOLLOWUP_KINDS]) for (const call of calls) {
      const outcome = refusalOutcome({ earlier, now }, pending, call);
      const mayWrite = outcome === "proceed" || outcome === "endQuestion";
      if (call !== "write" && call !== "bill") continue;
      if (earlier) expect(mayWrite).toBe(false);
      if (!earlier && now) expect(mayWrite).toBe(call === "bill");
      if (!earlier && !now) expect(mayWrite).toBe(true);
    }
  });

  it("keeps the pending question only when it asks again", () => {
    for (const pending of FOLLOWUP_KINDS) {
      expect(refusalOutcome({ earlier: true, now: false }, pending, "write")).toBe("askAgain");
      expect(followupAfterTurn(pending, null, "read")).toBe(pending);
    }
  });

  it("says nothing was recorded only for a turn that wrote nothing", () => {
    const receipt = "Saved ₱549.00 for Netflix.";
    expect(endedQuestionReply("refused", receipt, false)).toBe(REFUSED_REPLY);
    expect(endedQuestionReply("declined", receipt, false)).toBe(DECLINED_REPLY);
    for (const reason of ["refused", "declined"] as const) {
      const kept = endedQuestionReply(reason, receipt, true);
      expect(kept.startsWith(`${receipt}\n`)).toBe(true);
      expect(kept).not.toMatch(/didn't record anything|nothing was recorded|won't record the money/i);
    }
  });

  it("asks again with the way out and a statement that is true of a turn that wrote nothing", () => {
    expect(REFUSED_AGAIN_REPLY).toContain("cancel");
    expect(REFUSED_AGAIN_REPLY).toContain("haven't recorded anything");
  });
});

// The kind of the question pending decides whether a reply continues the statement it asks about. Only an explicit restart
// starts a new one, and the exact wording the machine accepts for it is listed here.
describe("whether a reply starts a new statement", () => {
  const accounts = ["Wallet", "Maya", "BPI 2", "BPI 1234"];
  const statement = ["Log coffee into Maya on 2026-10-05"];
  const starts = (pending: FollowupKind | null, reply: string, earlier: string[] = statement) => startsNewStatement(pending, reply, earlier, accounts);

  // Every followup kind, with a reply of each shape. true = the reply starts a new statement.
  const answers = ["yes", "yes, Maya, 2026-10-05", "500", "Actually 200", "use BPI 2", "use BPI 1234", "BPI 2", "use Maya", "I paid 549", "I paid 549 pesos", "5 October", "5th of October", "October 5, 2026", "10/5", "3 days ago", "last 2 weeks", "yesterday", "around 5", "at 5", "5pm", "17:30", "500 cash", "Maya instead", "Actually, into Wallet"];
  for (const pending of FOLLOWUP_KINDS) {
    for (const reply of answers) {
      it(`${pending}: "${reply}" answers the question and keeps the statement`, () => expect(starts(pending, reply)).toBe(false));
    }
  }

  it("a reply with no question pending starts a statement", () => expect(starts(null, "yes")).toBe(true));

  // Replies that state their own amount with a purpose or a counterparty the statement did not name restart under the kinds
  // whose question expects a small answer, and answer under every other kind.
  const complete = ["Log salary 5000", "Ben paid me 200", "I paid Ana 200", "Ben owes me 200 and add it to Transactions for food", "I have a Netflix bill for ₱549 under Entertainment. It is monthly, starts today, and ends December 15."];
  const mayRestart: FollowupKind[] = ["clarification", "account_or_date", "ordinary_income", "repayment_amount"];
  for (const pending of FOLLOWUP_KINDS) {
    for (const reply of complete) {
      it(`${pending}: "${reply}" ${mayRestart.includes(pending) ? "starts a new statement" : "answers"}`, () => expect(starts(pending, reply)).toBe(mayRestart.includes(pending)));
    }
  }
  it("a purpose or counterparty the statement already named is an answer, not a restart", () => {
    expect(starts("clarification", "Coffee 120")).toBe(false);
    expect(starts("repayment_amount", "Ana paid me 500", ["Ana paid me into Maya"])).toBe(false);
    expect(starts("repayment_amount", "Ana paid me 200", ["Zed paid me into Maya"])).toBe(true);
  });

  // The restart wording, with a complete transaction after it, restarts under every kind, answerable or not.
  const restarts = ["Instead, log salary 5000", "instead log salary 5000", "Actually Ben paid me 200", "Actually, log salary 5000", "Never mind, Ben paid me 200", "nevermind log salary 5000", "No, instead log salary 5000", "Oh actually log salary 5000", "Scratch that, log salary 5000", "Forget that, Ben owes me 200", "Ignore that. Log salary 5000", "Log salary 5000 instead"];
  for (const pending of FOLLOWUP_KINDS) {
    for (const reply of restarts) {
      it(`${pending}: "${reply}" starts a new statement`, () => expect(starts(pending, reply)).toBe(true));
    }
  }
  it("recognizes exactly the restart wording", () => {
    for (const wording of ["Instead, x", "instead x", "Actually x", "Never mind, x", "never   mind x", "nvm x", "Scratch that x", "Forget that x", "Forget it x", "Ignore that x", "no, actually x", "x instead", "x instead."]) expect(hasRestartWording(wording)).toBe(true);
    for (const wording of ["Maya", "I would rather Maya", "in fact x", "not instead of x", "actualy x", "x insteadly", "Coffee 120"]) expect(hasRestartWording(wording)).toBe(false);
  });
  it("restart wording without a complete transaction restarts nothing", () => {
    for (const pending of FOLLOWUP_KINDS) for (const reply of ["Instead, Maya", "Actually 200", "Never mind, 500", "Actually Ben paid me", "Instead, use BPI 2 for 200"]) expect(starts(pending, reply)).toBe(false);
  });
});

// A hint that chooses a value reads only the statement the write is for. A new statement starts at a user message that is
// an explicit restart (startsNewStatement). Quiet turns are left out.
describe("the user messages a hint may read", () => {
  type Turn = [role: "user" | "assistant", text: string, followup?: FollowupKind | null, quiet?: boolean];
  const toRun = (turns: Turn[]) => turns.map(([role, content, followup, quiet]) => ({ role, content, followup: followup ?? null, ...(quiet ? { readOnly: true } : {}) }));
  const read = (turns: Turn[], current: string) => hintMessagesFor(toRun(turns), current, ["Wallet", "Maya"]).map((message) => message.content);
  const incomeQuestion: Turn[] = [["user", "Zed paid me 500 into Maya"], ["assistant", "Record as income?", "ordinary_income"]];

  const table: [string, Turn[], string, string[]][] = [
    ["no run, the current message stands alone", [], "Coffee 120", []],
    ["an answer stays with the statement it answers", incomeQuestion, "yes", ["Zed paid me 500 into Maya"]],
    ["a number is a correction of the amount, not a new statement", incomeQuestion, "Actually 200", ["Zed paid me 500 into Maya"]],
    ["a correction in the same statement stays", [...incomeQuestion, ["user", "actually into Wallet"], ["assistant", "Please answer yes", "ordinary_income"]], "yes", ["Zed paid me 500 into Maya", "actually into Wallet"]],
    ["the current message restarts with its own payment", incomeQuestion, "Actually Ben paid me 200", []],
    ["a different payer under the income question is a new statement", incomeQuestion, "Ben paid me 200", []],
    ["an earlier restart hides the statement before it", [...incomeQuestion, ["user", "Actually Ben paid me 200"], ["assistant", "Record as income?", "ordinary_income"]], "yes", ["Actually Ben paid me 200"]],
    ["the answers after the restart stay with it", [...incomeQuestion, ["user", "Actually Ben paid me 200"], ["assistant", "Record as income?", "ordinary_income"], ["user", "into Wallet"], ["assistant", "Please answer yes", "ordinary_income"]], "yes", ["Actually Ben paid me 200", "into Wallet"]],
    ["a different payer under the amount question is a new statement", [["user", "Zed paid me into Maya"], ["assistant", "How much?", "repayment_amount"]], "Ana paid me 200", []],
    ["a bare amount answers the amount question", [["user", "Zed paid me into Maya"], ["assistant", "How much?", "repayment_amount"]], "500", ["Zed paid me into Maya"]],
    ["the same payer restated with an amount answers the amount question", [["user", "Zed paid me into Maya"], ["assistant", "How much?", "repayment_amount"]], "Zed paid me 500", ["Zed paid me into Maya"]],
    ["a bill answer with payment wording stays with the bill", [["user", "I have a Netflix bill under Entertainment using Maya"], ["assistant", "Amount?", "bill_amount"]], "I paid 549", ["I have a Netflix bill under Entertainment using Maya"]],
    ["a bill restated in full under a bill question stays the bill", [["user", "I have a Netflix bill under Entertainment"], ["assistant", "Amount?", "bill_amount"]], "I have a Netflix bill for 549", ["I have a Netflix bill under Entertainment"]],
    ["an opt-in answer that repeats the amount stays with the debt", [["user", "Ana owes me 500 from Maya on 2026-10-05"], ["assistant", "Add it to Transactions?", "debt_transaction"]], "Add it to Transactions for the 500 lunch", ["Ana owes me 500 from Maya on 2026-10-05"]],
    ["an account answer with digits stays with the statement", [["user", "Ana paid me 500 into Nowhere on 2026-10-05"], ["assistant", "Which account?", "account_or_date"]], "use BPI 2", ["Ana paid me 500 into Nowhere on 2026-10-05"]],
    ["a date answer stays with the statement", [["user", "lunch 120"], ["assistant", "What date?", "account_or_date"]], "5 October", ["lunch 120"]],
    ["an explicit replacement under a clarification starts a statement", [["user", "Log coffee into Maya on 2026-10-05"], ["assistant", "What amount?", "clarification"]], "Instead, log salary 5000", []],
    ["the same transaction with its amount answers the clarification", [["user", "Log coffee into Maya on 2026-10-05"], ["assistant", "What amount?", "clarification"]], "Coffee 120", ["Log coffee into Maya on 2026-10-05"]],
    ["a restart earlier in the run starts the statement, not the first message", [["user", "lunch 120 into Maya"], ["assistant", "Which?", "account_or_date"], ["user", "Instead, log salary 5000"], ["assistant", "Which account?", "account_or_date"], ["user", "use Wallet"], ["assistant", "What date?", "account_or_date"]], "2026-10-05", ["Instead, log salary 5000", "use Wallet"]],
    ["a quiet turn neither feeds a hint nor restarts a statement", [...incomeQuestion, ["user", "Actually, how much did Ben pay me, 200?"], ["assistant", "Your answer", "ordinary_income", true]], "yes", ["Zed paid me 500 into Maya"]],
    ["a quiet turn first in the run is left out too", [["user", "Ana paid me into Maya"], ["assistant", "Debts", "repayment_amount", true], ["user", "Ben paid me"], ["assistant", "How much?", "repayment_amount"]], "200", ["Ben paid me"]],
  ];
  for (const [name, turns, current, expected] of table) {
    it(`${name} -> ${expected.length ? expected.join(" | ") : "none"}`, () => expect(read(turns, current)).toEqual(expected));
  }
});

// The text rule is a guess, so the machine says when it is not sure (`uncertain`) and gives the other reading of the run
// (hintReadingsFor). A write compares the two before it stores anything (ambiguousHints, ambiguityVerdict).
describe("when the text rule is unsure whether a reply starts a new statement", () => {
  const accounts = ["Wallet", "Maya", "BPI", "BPI 2"];
  const read = (pending: FollowupKind | null, reply: string, statement: string[] = ["Log coffee into BPI on 2026-10-05 at 8pm"]) => readStatementStart(pending, reply, statement, accounts);

  // [pending, reply, starts, uncertain]
  const table: [FollowupKind | null, string, boolean, boolean][] = [
    ["clarification", "Maya paid me 200", false, true], // a payer named like an account: the rule strips it and sees no purpose
    ["account_or_date", "Make it salary 5000 instead", false, true], // a command lead with restart wording
    ["clarification", "Actually coffee 120", true, true], // the same transaction, with restart wording
    ["clarification", "Actually Ben paid me 200", true, true],
    ["bill_amount", "Actually it is 549 monthly", true, true], // restart wording and an extra word under a bill question
    ["bill_amount", "Actually 12 payments", true, true],
    ["account_or_date", "12 noon", true, true], // a date or time answer with a word the rule does not know
    ["account_or_date", "3 in the afternoon", true, true],
    ["clarification", "500 bucks", true, true],
    ["repayment_amount", "500 lang", true, true],
    ["ordinary_income", "Ben paid me 200", true, true],
    ["clarification", "Log salary 5000", true, true],
    // Pure answers by their shape or by their kind are never unsure.
    ["clarification", "Coffee 120", false, false],
    ["clarification", "Actually 200", false, false],
    ["clarification", "500", false, false],
    ["account_or_date", "use BPI 2", false, false],
    ["account_or_date", "use BPI", false, false],
    ["account_or_date", "5 October", false, false],
    ["account_or_date", "120 at 1130pm", false, false],
    ["account_or_date", "5pm", false, false],
    ["ordinary_income", "yes, Maya", false, false],
    ["debt_transaction", "Add it to Transactions for the 500 lunch", false, false],
    ["bill_amount", "I paid 549", false, false],
    ["bill_amount", "I have a Netflix bill for 549", false, false],
    ["repayment_payer", "Ben paid me 200", false, false],
    [null, "Log salary 5000", true, false],
  ];
  for (const [pending, reply, starts, uncertain] of table) {
    it(`${pending ?? "no question"}: "${reply}" -> starts ${starts}, ${uncertain ? "unsure" : "sure"}`, () => expect(read(pending, reply)).toEqual({ starts, uncertain }));
  }

  it("reads a compact time as a time, so no word is left over", () => {
    expect(readStatementStart("account_or_date", "120 at 1130pm", ["Log coffee into Maya"], accounts)).toEqual({ starts: false, uncertain: false });
    expect(startsNewStatement("account_or_date", "1130pm", ["Log coffee into Maya"], accounts)).toBe(false);
  });

  describe("the two readings of the run", () => {
    const run = [
      { role: "user" as const, content: "Log coffee into BPI on 2026-10-05 at 8pm", followup: null },
      { role: "assistant" as const, content: "What amount?", followup: "clarification" as FollowupKind },
    ];
    it("an unsure reply has the reading that keeps the statement and the one that drops it", () => {
      const readings = hintReadingsFor(run, "Maya paid me 200", accounts);
      expect(readings.primary.map((message) => message.content)).toEqual(["Log coffee into BPI on 2026-10-05 at 8pm"]);
      expect(readings.other).toEqual([]);
    });
    it("a restart the rule is unsure about has the other reading keep the statement", () => {
      const readings = hintReadingsFor(run, "Actually coffee 120", accounts);
      expect(readings.primary).toEqual([]);
      expect(readings.other?.map((message) => message.content)).toEqual(["Log coffee into BPI on 2026-10-05 at 8pm"]);
    });
    it("a sure answer or a sure restart has a single reading", () => {
      expect(hintReadingsFor(run, "Coffee 120", accounts).other).toBeNull();
      expect(hintReadingsFor(run, "use BPI 2", accounts).other).toBeNull();
      expect(hintReadingsFor([], "Maya paid me 200", accounts).other).toBeNull();
    });
    it("hintMessagesFor is the primary reading", () => {
      expect(hintMessagesFor(run, "Actually coffee 120", accounts)).toEqual([]);
    });
    it("an unsure message earlier in the run is turned over as well", () => {
      const longer = [
        ...run,
        { role: "user" as const, content: "Actually coffee 120", followup: "clarification" as FollowupKind },
        { role: "assistant" as const, content: "Which account?", followup: "account_or_date" as FollowupKind },
      ];
      const readings = hintReadingsFor(longer, "use Maya", accounts);
      expect(readings.primary.map((message) => message.content)).toEqual(["Actually coffee 120"]);
      expect(readings.other?.map((message) => message.content)).toEqual(["Log coffee into BPI on 2026-10-05 at 8pm", "Actually coffee 120"]);
    });
  });
});

describe("where a write would put the money under two readings", () => {
  const place = { account: "bpi", date: "2026-10-05", time: "20:00" };
  const table: [string, Partial<typeof place>, boolean][] = [
    ["the same place", {}, false],
    ["another account", { account: "wallet" }, true],
    ["another date", { date: "2026-10-09" }, true],
    ["another time", { time: "16:00" }, true],
    ["a missing date against a date", { date: "" }, true],
  ];
  for (const [name, change, expected] of table) it(`${name} -> ${expected ? "ambiguous" : "not ambiguous"}`, () => expect(ambiguousHints(place, { ...place, ...change })).toBe(expected));

  const other = { account: "wallet", date: "2026-10-09", time: "16:00" };
  type Answer = { namesAccount: boolean; namesDate: boolean; choice: "earlier" | "new" | "unmarked" | "unclear" };
  const unmarked = (namesAccount: boolean, namesDate: boolean): Answer => ({ namesAccount, namesDate, choice: "unmarked" });
  const verdicts: [string, Answer | null, "write" | "ask"][] = [
    ["no question was answered", null, "ask"],
    ["the answer names neither", unmarked(false, false), "ask"],
    ["the answer names only the account", unmarked(true, false), "ask"],
    ["the answer names only the date", unmarked(false, true), "ask"],
    ["the answer names both", unmarked(true, true), "write"],
    ["\"earlier\" names neither", { namesAccount: false, namesDate: false, choice: "earlier" }, "ask"],
    ["\"earlier\" names both", { namesAccount: true, namesDate: true, choice: "earlier" }, "write"],
    ["\"new one\" names neither", { namesAccount: false, namesDate: false, choice: "new" }, "ask"],
    ["\"new one\" names both", { namesAccount: true, namesDate: true, choice: "new" }, "write"],
    ["the answer says both choices or denies one, and names both", { namesAccount: true, namesDate: true, choice: "unclear" }, "ask"],
  ];
  for (const [name, answer, expected] of verdicts) it(`readings differ in account and date, ${name} -> ${expected}`, () => expect(ambiguityVerdict(place, other, answer)).toBe(expected));
  it("readings that agree are written when nothing was asked, and an answer to the question must still be a valid answer", () => {
    expect(ambiguityVerdict(place, place, null)).toBe("write");
    expect(ambiguityVerdict(place, place, { namesAccount: false, namesDate: false, choice: "new" })).toBe("write");
    expect(ambiguityVerdict(place, place, { namesAccount: false, namesDate: false, choice: "earlier" })).toBe("write");
    expect(ambiguityVerdict(place, place, unmarked(true, true))).toBe("write");
    expect(ambiguityVerdict(place, place, unmarked(false, false))).toBe("ask");
    expect(ambiguityVerdict(place, place, unmarked(true, false))).toBe("ask");
    expect(ambiguityVerdict(place, place, { namesAccount: true, namesDate: true, choice: "unclear" })).toBe("ask");
  });
  it("a difference in time alone needs a choice word, or an answer that names the account and the date", () => {
    const time = { ...place, time: "16:00" };
    expect(ambiguityVerdict(place, time, null)).toBe("ask");
    expect(ambiguityVerdict(place, time, unmarked(false, false))).toBe("ask");
    expect(ambiguityVerdict(place, time, { namesAccount: false, namesDate: false, choice: "unclear" })).toBe("ask");
    expect(ambiguityVerdict(place, time, { namesAccount: false, namesDate: false, choice: "new" })).toBe("write");
    expect(ambiguityVerdict(place, time, { namesAccount: false, namesDate: false, choice: "earlier" })).toBe("write");
    expect(ambiguityVerdict(place, time, unmarked(true, true))).toBe("write");
  });
  it("a difference in account needs only the account", () => {
    expect(ambiguityVerdict(place, { ...place, account: "wallet" }, { namesAccount: true, namesDate: false, choice: "new" })).toBe("write");
  });

  // The words that choose a reading are this exact list and nothing else: "earlier", "earlier one", "the earlier" and
  // "the earlier one" choose the earlier statement; "new one", "a new one" and "the new one" choose the restart. A reply that
  // carries neither is unmarked, and one that carries both, or denies the one it carries, is unclear and is asked again.
  const choices: [string, "earlier" | "new" | "unmarked" | "unclear"][] = [
    ["earlier", "earlier"],
    ["the earlier one", "earlier"],
    ["Earlier one, use BPI on 2026-10-05", "earlier"],
    ["use BPI on 2026-10-05 for the earlier.", "earlier"],
    ["new one", "new"],
    ["A new one, use Wallet on 2026-10-09", "new"],
    ["NEW ONE: Wallet, today", "new"],
    ["the new one", "new"],
    ["use Wallet on 2026-10-09", "unmarked"],
    ["yes, Wallet, today", "unmarked"],
    ["a new account, Wallet", "unmarked"],
    ["the earliest one", "unmarked"],
    ["newer", "unmarked"],
    ["", "unmarked"],
    ["earlier or a new one, Wallet, today", "unclear"],
    ["new one, not the earlier one", "unclear"],
    ["not the earlier one, use Wallet on 2026-10-09", "unclear"],
    ["it is not a new one, use BPI on 2026-10-05", "unclear"],
    ["don't mean the new one", "unclear"],
  ];
  for (const [reply, expected] of choices) it(`${JSON.stringify(reply)} -> ${expected}`, () => expect(ambiguityChoice(reply)).toBe(expected));

  describe("the question the run is waiting on", () => {
    const question = ambiguousHintsQuestion("coffee", "BPI on Oct 5 at 20:00");
    const asked = [
      { role: "user" as const, content: "Log coffee into BPI on 2026-10-05 at 8pm" },
      { role: "assistant" as const, content: "What amount?", followup: "clarification" as const },
      { role: "user" as const, content: "Maya paid me 200" },
      { role: "assistant" as const, content: question, followup: "account_or_date" as const },
    ];
    const quiet = [
      { role: "user" as const, content: "how much did I spend?" },
      { role: "assistant" as const, content: "Total Spent: ₱0.00", followup: "account_or_date" as const, readOnly: true },
    ];
    it("is the last reply when nothing quiet follows it", () => {
      expect(openQuestionOf(asked)?.content).toBe(question);
      expect(isAmbiguityQuestionOf(asked)).toBe(true);
    });
    it("skips a read-only reply and a reply that saved a bill, and ignores user messages", () => {
      expect(openQuestionOf([...asked, ...quiet])?.content).toBe(question);
      expect(isAmbiguityQuestionOf([...asked, ...quiet, { role: "user", content: "list my debts" }, { role: "assistant", content: "None.", followup: "account_or_date", readOnly: true }])).toBe(true);
      expect(isAmbiguityQuestionOf([...asked, { role: "user", content: "a bill" }, { role: "assistant", content: "Saved Internet", followup: "account_or_date", billId: "b1" }])).toBe(true);
    });
    it("is not the question when the last reply that is not quiet is another one, or has another kind", () => {
      expect(isAmbiguityQuestionOf([...asked, { role: "user", content: "x" }, { role: "assistant", content: "What date should I use?", followup: "account_or_date" }])).toBe(false);
      expect(isAmbiguityQuestionOf([...asked.slice(0, 3), { role: "assistant", content: question, followup: "clarification" }])).toBe(false);
      expect(isAmbiguityQuestionOf([])).toBe(false);
      expect(openQuestionOf([])).toBeUndefined();
    });
  });

  it("names the earlier statement and the way out, and is recognized when it comes back stored", () => {
    const question = ambiguousHintsQuestion("coffee", "BPI on Oct 5 at 20:00");
    expect(question).toBe("Do you mean the earlier coffee in BPI on Oct 5 at 20:00, or a new one? Reply \"earlier\" or \"new one\" with the account and date, or say cancel.");
    expect(isAmbiguousHintsQuestion(question)).toBe(true);
    expect(isAmbiguousHintsQuestion(`${question} Reply with yes and the account, like "yes, BPI", or say cancel.`)).toBe(true);
    expect(isAmbiguousHintsQuestion("What amount should I use?")).toBe(false);
  });
});

// The debt flow of a saved debt (finding 22). The debt a pending question carries is only the debt an answer links to. The provider's
// call is replaced by the debt write only when the user said yes or no to Transactions, and only a call that writes or asks is.
describe("debt flow continuation", () => {
  const calls: { name: string; kind: TurnCall }[] = [
    { name: "log_debt", kind: "write" }, { name: "log_transaction", kind: "write" }, { name: "record_debt_payment", kind: "write" },
    { name: "record_debt_repayment", kind: "write" }, { name: "create_bill", kind: "bill" }, { name: "update_bill", kind: "bill" },
    { name: "finance_question", kind: "read" }, { name: "ask_clarification", kind: "ask" },
  ];
  const answers: DebtTransactionAnswer[] = ["optIn", "optOut", null];

  it("continues only the offer and a generic, account or date question that carries the debt", () => {
    for (const pending of [null, ...FOLLOWUP_KINDS]) {
      for (const carriesDebt of [false, true]) {
        const expected = pending === "debt_transaction" || ((pending === "account_or_date" || pending === "clarification") && carriesDebt);
        expect(debtFlowContinues(pending, carriesDebt), `${pending} ${carriesDebt}`).toBe(expected);
      }
    }
  });

  it("rewrites the provider's call for every call x pending kind x answer exactly when the rule says", () => {
    for (const pending of [null, ...FOLLOWUP_KINDS]) for (const carriesDebt of [false, true]) for (const answer of answers) for (const call of calls) {
      const expected = debtFlowContinues(pending, carriesDebt) && answer !== null && (call.kind === "write" || call.kind === "ask");
      expect(debtContinuationRewrites(turnCallOf(call.name), pending, carriesDebt, answer), `${call.name} / ${pending} / debt ${carriesDebt} / ${answer}`).toBe(expected);
    }
  });

  it("never rewrites a call that only reads, or a bill, whatever the pending question and the answer", () => {
    for (const pending of [null, ...FOLLOWUP_KINDS]) for (const carriesDebt of [false, true]) for (const answer of answers) {
      expect(debtContinuationRewrites("read", pending, carriesDebt, answer)).toBe(false);
      expect(debtContinuationRewrites("bill", pending, carriesDebt, answer)).toBe(false);
    }
  });

  it("never rewrites without the user's yes or no, so a carried debt alone writes nothing", () => {
    for (const pending of [null, ...FOLLOWUP_KINDS]) for (const carriesDebt of [false, true]) for (const call of ["write", "ask"] as const) {
      expect(debtContinuationRewrites(call, pending, carriesDebt, null)).toBe(false);
    }
    expect(debtContinuationRewrites("write", "account_or_date", true, "optIn")).toBe(true);
    expect(debtContinuationRewrites("write", "debt_transaction", false, "optOut")).toBe(true);
  });
});

// A yes or a no to the stored Transactions offer is a recorded answer for that debt's whole flow (finding 23). The walk reads the
// stored reply kinds and debt ids of the open run, never the text of a reply, and a user message only for the yes or no itself.
describe("debt offer chain", () => {
  type Turn = { role: "user" | "assistant"; content: string; followup?: FollowupKind | null; debtId?: string | null; readOnly?: boolean };
  const u = (content: string): Turn => ({ role: "user", content });
  const a = (followup: FollowupKind | null, debtId: string | null = "D1", extra: Partial<Turn> = {}): Turn => ({ role: "assistant", content: "reply", followup, debtId, ...extra });
  const offer = [u("Ana owes me 500"), a("debt_transaction")];

  const cases: { name: string; run: Turn[]; expected: "optIn" | "optOut" | null }[] = [
    { name: "no offer at all", run: [u("what is this"), a("clarification", null)], expected: null },
    { name: "the offer is the last reply, so the current message is its answer", run: offer, expected: null },
    { name: "yes, then an account question", run: [...offer, u("yes, for lunch into Nowhere account"), a("account_or_date")], expected: "optIn" },
    { name: "yes, then a date question", run: [...offer, u("yes for food on 2026-13-45"), a("account_or_date")], expected: "optIn" },
    { name: "yes, then a generic question", run: [...offer, u("yes, for food"), a("clarification")], expected: "optIn" },
    { name: "yes, an account question, an answer that asks again", run: [...offer, u("yes"), a("account_or_date"), u("Nowhere"), a("account_or_date")], expected: "optIn" },
    { name: "yes, an account question, then a date question", run: [...offer, u("yes"), a("account_or_date"), u("Wallet"), a("clarification")], expected: "optIn" },
    { name: "no, then a question", run: [...offer, u("no, but make it 600"), a("clarification")], expected: "optOut" },
    { name: "a reply that is not a yes or a no to the offer records nothing", run: [...offer, u("make it 600"), a("clarification")], expected: null },
    { name: "an unrelated kind ends the chain", run: [...offer, u("yes"), a("account_or_date"), u("Maya paid me"), a("repayment_payer")], expected: null },
    { name: "an ordinary income question ends the chain", run: [...offer, u("yes"), a("account_or_date"), u("x"), a("ordinary_income")], expected: null },
    { name: "a reply that dropped the debt ends the chain", run: [...offer, u("yes"), a("account_or_date"), u("Nowhere"), a("clarification", null)], expected: null },
    { name: "a different debt ends the chain", run: [...offer, u("yes"), a("account_or_date", "D2")], expected: null },
    { name: "a new offer for a different debt starts over", run: [...offer, u("yes"), a("account_or_date"), u("Ben owes me 3"), a("debt_transaction", "D2")], expected: null },
    { name: "a new offer for a different debt, then its yes", run: [...offer, u("Ben owes me 3"), a("debt_transaction", "D2"), u("yes"), a("account_or_date", "D2")], expected: "optIn" },
    { name: "an offer for another debt answered no, after an earlier yes", run: [...offer, u("yes"), a("account_or_date"), u("Ben owes me 3"), a("debt_transaction", "D2"), u("no"), a("clarification", "D2")], expected: "optOut" },
    { name: "an offer with no debt id is no offer", run: [u("x"), a("debt_transaction", null), u("yes"), a("account_or_date", null)], expected: null },
    { name: "a quiet read between the yes and the current message does not end it", run: [...offer, u("yes"), a("account_or_date"), u("how much did I spend?"), a("account_or_date", "D1", { readOnly: true })], expected: "optIn" },
    { name: "a quiet read before the yes does not answer the offer", run: [...offer, u("how much did I spend?"), a("debt_transaction", "D1", { readOnly: true }), u("yes"), a("account_or_date")], expected: "optIn" },
    { name: "a quiet read on the offer alone records nothing", run: [...offer, u("how much did I spend?"), a("debt_transaction", "D1", { readOnly: true })], expected: null },
    { name: "a quiet bill between does not end it", run: [...offer, u("yes"), a("account_or_date"), u("Netflix bill"), { ...a("account_or_date"), billId: "B1" } as Turn], expected: "optIn" },
    { name: "the offer asked again after a yes is a new, unanswered offer", run: [...offer, u("yes"), a("debt_transaction")], expected: null },
  ];
  for (const { name, run, expected } of cases) it(name, () => expect(debtOfferChainAnswer(run)).toBe(expected));

  it("reads the stored kinds and ids only: a reply's wording changes nothing", () => {
    const worded = (content: string) => [...offer, u("yes"), { ...a("account_or_date"), content }];
    for (const content of ["", "Added it to Debts only", "yes yes yes", "Okay, Ana's debt stays in Debts only."]) expect(debtOfferChainAnswer(worded(content))).toBe("optIn");
  });

  it("recognizes the same yes and no the offer answer always did", () => {
    for (const text of ["yes", "Yes, for lunch", "yeah", "yep", "sure", "okay", "ok", "go ahead", "add it", "record it please"]) expect(isDebtOfferYes(text), text).toBe(true);
    for (const text of ["no", "nope", "nah, keep it", "No."]) expect(isDebtOfferNo(text), text).toBe(true);
    for (const text of ["maybe", "yesterday", "nothing", "Wallet", ""]) { expect(isDebtOfferYes(text), text).toBe(false); expect(isDebtOfferNo(text), text).toBe(false); }
  });
});

// Wording that refuses to record, read over the whole open debt flow, wins over a yes recorded earlier in it (finding 24).
describe("debt record refusal wording", () => {
  it("reads a refusal to record, add, log or save, curly apostrophes included", () => {
    for (const text of ["No, don't record it. The date was 2026-10-08.", "do not add it", "I won\u2019t log that", "Don\u2019t save it yet", "no need to record this", "never put it in", "Please don't go ahead and record it"]) expect(isDebtRecordRefusal(text), text).toBe(true);
  });

  it("reads nothing else as a refusal: a plain answer, a yes or a no is not", () => {
    for (const text of ["yes, for lunch", "no", "no, but make it 600", "use Wallet", "record it", "I don't know the date", "Ben owes me 700 using Wallet", "2026-10-08", ""]) expect(isDebtRecordRefusal(text), text).toBe(false);
  });

  it("has a re-ask that names the refusal and the way out, not the payment", () => {
    expect(DEBT_REFUSED_AGAIN_REPLY).toContain("recorded");
    expect(DEBT_REFUSED_AGAIN_REPLY).toContain("cancel");
    expect(DEBT_REFUSED_AGAIN_REPLY).not.toContain("payment");
  });
});
