import { describe, expect, it } from "vitest";
import { duplicateCallData, parseReplyData } from "../src/lib/assistant-followup";
import { DECLINED_REPLY, MAX_OPEN_RUN_MESSAGES, REFUSED_AGAIN_REPLY, REFUSED_REPLY, UNDO_WINDOW_MS, cancelHint, cancelReply, debtContinuationRewrites, debtFlowContinues, debtFlowAnswers, debtOfferChainAnswer, debtFlowUserMessages, duplicateDebtChoice, duplicateDebtQuestion, duplicateOfRunDebt, isDuplicateDebtQuestion, isDuplicateDebtQuestionOf, runDebtIds, keepsAnotherChoice, openQuestionData, answerShaped, separateEntryChoice, shortenAtWord, separateEntryDecision, separateEntryQuestion, holdsSeparate, debtFlowStatement, isDebtOfferNo, isDebtOfferYes, isDebtRecordRefusal, DEBT_REFUSED_AGAIN_REPLY, ambiguityChoice, ambiguityVerdict, isAmbiguityQuestionOf, openQuestionOf, ambiguousHints, ambiguousHintsQuestion, canUndo, endedQuestionReply, expiredReply, followupAfterTurn, guardUserMessages, hasRestartWording, hintMessagesFor, hintReadingsFor, isAmbiguousHintsQuestion, readStatementStart, incomeAccountChoice, incomeChainAccount, incomeChainAnswers, isIncomeConfirmation, isOrdinaryIncomeDecline, isQuietReply, ordinaryIncomeTurn, ownUserMessages, pendingOutcome, refusalOutcome, runExpired, runSaved, startsNewStatement, turnCallOf, turnMayCommit, undoUntilFor, userMessagesFor, type DebtFlowTurn, type DebtRef, type RunDebt, type DebtTransactionAnswer, type RefusalOutcome, type RunMessage, type TurnCall, type AnswerQuestion, askedOf } from "../src/lib/machines/assistant";
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

  it("rewrites the provider's call for every call x answers-the-flow x answer exactly when the rule says", () => {
    for (const answersFlow of [false, true]) for (const answer of answers) for (const call of calls) {
      const expected = answersFlow && answer !== null && (call.kind === "write" || call.kind === "ask");
      expect(debtContinuationRewrites(turnCallOf(call.name), answersFlow, answer), `${call.name} / answers ${answersFlow} / ${answer}`).toBe(expected);
    }
  });

  it("never rewrites a call that only reads, or a bill, whatever the answer", () => {
    for (const answersFlow of [false, true]) for (const answer of answers) {
      expect(debtContinuationRewrites("read", answersFlow, answer)).toBe(false);
      expect(debtContinuationRewrites("bill", answersFlow, answer)).toBe(false);
    }
  });

  it("never rewrites without the user's yes or no, so a carried debt alone writes nothing", () => {
    for (const answersFlow of [false, true]) for (const call of ["write", "ask"] as const) {
      expect(debtContinuationRewrites(call, answersFlow, null)).toBe(false);
    }
    expect(debtContinuationRewrites("write", true, "optIn")).toBe(true);
    expect(debtContinuationRewrites("ask", true, "optOut")).toBe(true);
  });

  it("never rewrites a turn that does not answer the debt flow, even with a recorded yes", () => {
    for (const call of ["write", "ask"] as const) expect(debtContinuationRewrites(call, false, "optIn")).toBe(false);
  });
});

// Finding 24: the debt flow's recorded yes and its link to the saved debt apply only to a turn that answers that debt's own
// question. One pure function says whether the current turn does.
describe("debtFlowAnswers", () => {
  const ana: DebtRef = { direction: "owed_to_you", counterparty: "Ana" };
  const turn = (over: Partial<DebtFlowTurn> = {}): DebtFlowTurn => ({
    pending: "account_or_date", carriesDebt: true, refused: false, shaped: true, stated: undefined, saved: ana, call: { kind: "write" }, ...over,
  });
  const cases: { name: string; turn: DebtFlowTurn; expected: boolean }[] = [
    { name: "an answer to its own account question", turn: turn(), expected: true },
    { name: "an answer to the offer", turn: turn({ pending: "debt_transaction" }), expected: true },
    { name: "an answer to its own generic question", turn: turn({ pending: "clarification" }), expected: true },
    { name: "a write that names the saved debt (a different spelling of the same counterparty)", turn: turn({ call: { kind: "write", names: { direction: "owed_to_you", counterparty: " ANA " } } }), expected: true },
    { name: "the same debt stated again", turn: turn({ stated: ana }), expected: true },
    { name: "a call that asks", turn: turn({ call: { kind: "ask" } }), expected: true },
    { name: "a read-only call", turn: turn({ call: { kind: "read" } }), expected: true },
    { name: "a refusal anywhere in the run", turn: turn({ refused: true }), expected: false },
    { name: "a refusal anywhere in the run, even for the offer", turn: turn({ pending: "debt_transaction", refused: true }), expected: false },
    { name: "a new debt: a different counterparty stated", turn: turn({ stated: { direction: "owed_to_you", counterparty: "Ben" } }), expected: false },
    { name: "a new debt: a different direction stated", turn: turn({ stated: { direction: "you_owe", counterparty: "Ana" } }), expected: false },
    { name: "a write for a different counterparty", turn: turn({ call: { kind: "write", names: { counterparty: "Ben" } } }), expected: false },
    { name: "a write in a different direction", turn: turn({ call: { kind: "write", names: { direction: "you_owe" } } }), expected: false },
    { name: "a message that is not answer-shaped (a new expense, a restart, a refusal, any verb phrase)", turn: turn({ shaped: false }), expected: false },
    { name: "a message that is not answer-shaped, under the offer", turn: turn({ pending: "debt_transaction", shaped: false }), expected: false },
    { name: "a message that is not answer-shaped, under a question the model asks", turn: turn({ shaped: false, call: { kind: "ask" } }), expected: false },
    { name: "a message that is not answer-shaped, under a read-only call", turn: turn({ shaped: false, call: { kind: "read" } }), expected: false },
    { name: "a message that is not answer-shaped, even when the write names the saved debt", turn: turn({ shaped: false, call: { kind: "write", names: { direction: "owed_to_you", counterparty: "Ana" } } }), expected: false },
    { name: "no debt flow open: nothing pending", turn: turn({ pending: null }), expected: false },
    { name: "no debt flow open: a question that carries no debt", turn: turn({ carriesDebt: false }), expected: false },
    { name: "no debt flow open: another kind of question", turn: turn({ pending: "repayment_amount" }), expected: false },
  ];
  for (const { name, turn: input, expected } of cases) it(`${expected ? "answers" : "does not answer"}: ${name}`, () => expect(debtFlowAnswers(input)).toBe(expected));

  it("never answers when the question does not belong to the debt flow, whatever else holds", () => {
    for (const pending of FOLLOWUP_KINDS) for (const carriesDebt of [false, true]) {
      if (debtFlowContinues(pending, carriesDebt)) continue;
      expect(debtFlowAnswers(turn({ pending, carriesDebt })), `${pending} ${carriesDebt}`).toBe(false);
    }
  });

  it("lets a refusal, a new statement or another debt each take the answer away on their own", () => {
    expect(debtFlowAnswers(turn())).toBe(true);
    for (const over of [{ refused: true }, { shaped: false }, { stated: { counterparty: "Ben" } }, { call: { kind: "write" as const, names: { counterparty: "Ben" } } }]) {
      expect(debtFlowAnswers(turn(over)), JSON.stringify(over)).toBe(false);
    }
  });

  it("does not compare a debt the turn leaves unnamed or a saved debt it cannot find", () => {
    expect(debtFlowAnswers(turn({ saved: undefined, stated: { counterparty: "Ben" }, call: { kind: "write", names: { counterparty: "Ben" } } }))).toBe(true);
    expect(debtFlowAnswers(turn({ call: { kind: "write", names: { direction: null, counterparty: null } } }))).toBe(true);
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
  it("reads the small anchored set of refusals: the whole message or its leading clause for the bare forms", () => {
    for (const text of ["no", "No.", "no thanks", "No thank you!", "nope", "nah", "hindi", "Ayoko", "skip it", "Skip it.", "debts only", "Debts only", "leave it in debts only", "no, skip it", "Okay, debts only"]) expect(isDebtRecordRefusal(text), text).toBe(true);
  });

  it("reads an explicit refusal clause to record, add, log or save as a refusal anywhere in the message, curly apostrophes included", () => {
    for (const text of [
      "No, don't record it. The date was 2026-10-08.", "don't record it", "don't record this", "Don't record that", "do not record it", "do not record this", "do not record that",
      "don't add it", "don't add this to transactions", "Don\u2019t add that to my transactions", "do not add it", "no need to record it", "No need to record this", "no need to record that",
      "I won\u2019t log that", "Don\u2019t save it yet", "please don't go ahead and record it", "Wallet, but don't record it", "Use Wallet. Do not add it.", "okay don't record it", "never record it",
    ]) expect(isDebtRecordRefusal(text), text).toBe(true);
  });

  it("reads no incidental negation as a refusal: 'forget', 'know', 'mind', 'worry', 'need' and a negation far from a verb", () => {
    for (const text of [
      "Don't forget to log coffee 100 using Wallet", "Don't forget to add it to Wallet", "I don't know, add it to Wallet", "I never save in cash, put it in Wallet",
      "Sure, don't forget to put it in Wallet", "Spent 200 on lunch in Wallet, and don't forget to log it", "Don't worry, record it", "Don't mind me, add it to Wallet",
      "I don't need to know the date, log it", "no need to hurry, record it", "never mind the date, add it", "Don't forget",
    ]) expect(isDebtRecordRefusal(text), text).toBe(false);
  });

  it("reads nothing else as a refusal: a plain answer, a yes or a no that goes on is not", () => {
    for (const text of ["yes, for lunch", "no, but make it 600", "no, use Wallet", "Wallet, no, GCash", "use Wallet", "record it", "I don't know the date", "Ben owes me 700 using Wallet", "2026-10-08", "", "skip it for now please, 2026-10-08"]) expect(isDebtRecordRefusal(text), text).toBe(false);
  });

  it("has a re-ask that names the refusal and the way out, not the payment", () => {
    expect(DEBT_REFUSED_AGAIN_REPLY).toContain("recorded");
    expect(DEBT_REFUSED_AGAIN_REPLY).toContain("cancel");
    expect(DEBT_REFUSED_AGAIN_REPLY).not.toContain("payment");
  });
});

// Finding 25: a debt write never creates a second open debt that duplicates one the open run already saved.
describe("duplicateOfRunDebt", () => {
  const ana: RunDebt = { id: "d1", direction: "owed_to_you", counterparty: "Ana", amountMinor: 50_000, status: "open" };
  const next: { direction: RunDebt["direction"]; counterparty: string; amountMinor: number } = { direction: "owed_to_you", counterparty: "Ana", amountMinor: 50_000 };
  const cases: { name: string; saved: RunDebt[]; next: typeof next; duplicate: boolean }[] = [
    { name: "the same debt again", saved: [ana], next, duplicate: true },
    { name: "the same counterparty spelled another way", saved: [ana], next: { ...next, counterparty: "  ANA " }, duplicate: true },
    { name: "a different amount", saved: [ana], next: { ...next, amountMinor: 70_000 }, duplicate: false },
    { name: "a different counterparty", saved: [ana], next: { ...next, counterparty: "Ben" }, duplicate: false },
    { name: "a different direction", saved: [ana], next: { ...next, direction: "you_owe" }, duplicate: false },
    { name: "a settled debt of the run", saved: [{ ...ana, status: "settled" }], next, duplicate: false },
    { name: "a debt outside the run (not among the saved ones)", saved: [], next, duplicate: false },
    { name: "the second of two saved debts", saved: [{ ...ana, id: "d0", counterparty: "Ben" }, ana], next, duplicate: true },
  ];
  for (const { name, saved, next: input, duplicate } of cases) it(`${duplicate ? "finds" : "does not find"} a duplicate: ${name}`, () => {
    expect(duplicateOfRunDebt(saved, input)?.id ?? null).toBe(duplicate ? saved.find((debt) => debt.status === "open" && debt.counterparty !== "Ben")!.id : null);
  });
});

describe("the debts a run saved and the duplicate question", () => {
  it("lists each debt id the replies of the run carry once, oldest first", () => {
    expect(runDebtIds([
      { role: "user" }, { role: "assistant", followup: "debt_transaction", debtId: "a" },
      { role: "user" }, { role: "assistant", followup: "clarification", debtId: "a" },
      { role: "user" }, { role: "assistant", followup: "debt_transaction", debtId: "b" }, { role: "user" }, { role: "assistant" },
    ])).toEqual(["a", "b"]);
    expect(runDebtIds([{ role: "user" }, { role: "assistant", followup: "clarification" }])).toEqual([]);
  });

  it("words the question and recognizes its own wording only", () => {
    const owed = duplicateDebtQuestion({ direction: "owed_to_you", counterparty: "Ana" }, "₱500.00");
    expect(owed).toBe('You already added Ana owes you ₱500.00 in this conversation. Add another, or use that one? Reply "another" or "that one", or cancel.');
    expect(duplicateDebtQuestion({ direction: "you_owe", counterparty: "Ana" }, "₱500.00")).toContain("you owe Ana ₱500.00");
    expect(isDuplicateDebtQuestion(owed)).toBe(true);
    for (const text of ["You already added a bill.", "Which one?", ""]) expect(isDuplicateDebtQuestion(text), text).toBe(false);
  });

  it("reads the open question as the duplicate question only when it is the last one that is not quiet", () => {
    const question = { role: "assistant" as const, followup: "clarification" as const, content: duplicateDebtQuestion({ direction: "owed_to_you", counterparty: "Ana" }, "₱500.00") };
    expect(isDuplicateDebtQuestionOf([{ role: "user", content: "x" }, question])).toBe(true);
    expect(isDuplicateDebtQuestionOf([question, { role: "user", content: "How much did I spend?" }, { role: "assistant", followup: "clarification", readOnly: true, content: "₱0" }])).toBe(true);
    expect(isDuplicateDebtQuestionOf([question, { role: "user", content: "x" }, { role: "assistant", followup: "clarification", content: "Which one?" }])).toBe(false);
    expect(isDuplicateDebtQuestionOf([{ role: "assistant", followup: "account_or_date", content: question.content }])).toBe(false);
  });

  it("answers by an exact list: another, that one, and nothing else", () => {
    for (const text of ["another", "Another one.", "add another", "ADD ANOTHER ONE!"]) expect(duplicateDebtChoice(text), text).toBe("another");
    for (const text of ["that one", "Use that one", "the same one.", "same one"]) expect(duplicateDebtChoice(text), text).toBe("that");
    for (const text of ["yes", "Ana owes me 500", "another debt for Ben", "that one and another", "", "cancel"]) expect(duplicateDebtChoice(text), text).toBeNull();
  });
});

// Finding 26: the debt flow's recorded yes and its link to the saved debt are inherited only by an ANSWER-SHAPED message. A whitelist,
// so no wording of a refusal, a restart or a new statement has to be recognised for safety.
describe("answerShaped", () => {
  const context = { accountNames: ["Wallet", "BPI 2", "Savings"], counterparty: "Ana", amountMinor: 50_000, statement: ["Ana owes me 500", "yes, for lunch using Wallet on 2026-13-45"] };
  const answers: { reply: string; question: AnswerQuestion }[] = [
    { reply: "use Wallet", question: "detail" },
    { reply: "Use Wallet, please", question: "detail" },
    { reply: "yes, Wallet", question: "detail" },
    { reply: "yes", question: "offer" },
    { reply: "no", question: "offer" },
    { reply: "No thanks", question: "offer" },
    { reply: "BPI 2", question: "detail" },
    { reply: "use BPI 2 today", question: "detail" },
    { reply: "Wallet today", question: "detail" },
    { reply: "2026-10-08", question: "detail" },
    { reply: "use Wallet on 2026-10-08", question: "detail" },
    { reply: "Wallet at 8pm", question: "detail" },
    { reply: "yesterday, Savings", question: "detail" },
    { reply: "last Monday into Wallet", question: "detail" },
    { reply: "the 500 lunch was on 2026-10-08 using Wallet", question: "detail" },
    { reply: "The 500 lunch was on 2026-10-08 into Nowhere account", question: "detail" },
    { reply: "add it to Transactions", question: "offer" },
    { reply: "Yes, add it to Transactions for lunch", question: "offer" },
    { reply: "Add it to Transactions; it was Jollibee", question: "offer" },
    { reply: "yes, for lunch into Nowhere account", question: "offer" },
    { reply: "yes, for food in Wallet on 2026-13-45", question: "offer" },
    { reply: "yes, for groceries and drinks", question: "offer" },
    { reply: "27 then", question: "detail" },
    { reply: "500 then", question: "detail" },
    { reply: "another", question: "duplicate" },
    { reply: "another one", question: "duplicate" },
    { reply: "that one", question: "duplicate" },
    { reply: "the same one", question: "duplicate" },
    { reply: "earlier, Wallet", question: "ambiguity" },
    { reply: "new one, Wallet, today", question: "ambiguity" },
    { reply: "Ana", question: "detail" },
  ];
  for (const { reply, question } of answers) it(`is an answer (${question}): ${reply}`, () => expect(answerShaped(reply, question, { ...context, amountMinor: reply === "27 then" ? 2_700 : 50_000 })).toBe(true));

  const notAnswers: { reply: string; question: AnswerQuestion }[] = [
    { reply: "I don't want to record it. Use Wallet.", question: "detail" },
    { reply: "Don't record the money. Use Wallet.", question: "detail" },
    { reply: "Don't record it in Wallet.", question: "detail" },
    { reply: "I don't want to record the 500 lunch. Use Wallet.", question: "detail" },
    { reply: "Please do not record it yet.", question: "detail" },
    { reply: "Leave the money out. Wallet.", question: "detail" },
    { reply: "Sure, don't forget to put it in Wallet", question: "offer" },
    { reply: "Don't forget to add it to Wallet", question: "detail" },
    { reply: "I don't know, add it to Wallet", question: "detail" },
    { reply: "Instead, record my lunch refund income of 500 using Wallet today.", question: "detail" },
    { reply: "Spent 500 on lunch with Ben in Wallet", question: "detail" },
    { reply: "Log groceries 500 using Wallet", question: "detail" },
    { reply: "The 500 lunch expense was on 2026-10-08 using Wallet", question: "detail" },
    { reply: "Ben owes me 700 using Wallet.", question: "detail" },
    { reply: "make it 30", question: "offer" },
    { reply: "no, but make it 600", question: "offer" },
    { reply: "okay, just debts then", question: "offer" },
    { reply: "yes for lunch don't record it", question: "offer" },
    { reply: "yes, for lunch, skip it", question: "offer" },
    { reply: "yes, record my groceries for Ben", question: "offer" },
    { reply: "use Wallet for groceries", question: "detail" },
    { reply: "500 for groceries", question: "detail" },
    { reply: "Wallet, 700", question: "detail" },
    { reply: "Ben, Wallet", question: "detail" },
    { reply: "how much did I spend using Wallet?", question: "detail" },
    // Finding 27a: the choice words answer only the question that offers the choice.
    { reply: "Record another 500 using Wallet today", question: "detail" },
    { reply: "Record another 500 using Wallet today", question: "offer" },
    { reply: "Record another 500 using Wallet today", question: "account" },
    { reply: "Record another 500 using Wallet today", question: "date" },
    { reply: "another", question: "detail" },
    { reply: "that one", question: "offer" },
    { reply: "new one, Wallet, today", question: "account" },
    { reply: "earlier, Wallet", question: "detail" },
    { reply: "the same one", question: "date" },
    { reply: "use that one", question: "detail" },
  ];
  for (const { reply, question } of notAnswers) it(`is not an answer (${question}): ${reply}`, () => expect(answerShaped(reply, question, context)).toBe(false));

  it("treats the debt's own counterparty and amount, and only those, as filler", () => {
    expect(answerShaped("Ana 500 Wallet", "detail", context)).toBe(true);
    expect(answerShaped("Ben 500 Wallet", "detail", context)).toBe(false);
    expect(answerShaped("Ana 600 Wallet", "detail", context)).toBe(false);
    expect(answerShaped("₱500.00 Wallet", "detail", context)).toBe(true);
    expect(answerShaped("1,500 Wallet", "detail", context)).toBe(false);
  });
  it("treats the words of the flow's statement as filler, except the refusal words, which no statement can make filler", () => {
    expect(answerShaped("lunch", "detail", context)).toBe(true);
    expect(answerShaped("groceries", "detail", context)).toBe(false);
    expect(answerShaped("don't", "detail", { ...context, statement: [...context.statement, "don't record it, lunch"] })).toBe(false);
  });
  it("lets only the offer carry a purpose, and never a purpose that holds a refusal word", () => {
    expect(answerShaped("yes, for groceries", "offer", context)).toBe(true);
    expect(answerShaped("yes, for groceries", "detail", context)).toBe(false);
    expect(answerShaped("yes, for no reason", "offer", context)).toBe(false);
    expect(answerShaped("yes, for don't record", "offer", context)).toBe(false);
  });
  it("knows only the accounts the user has, and answers an unknown one only as a named account", () => {
    expect(answerShaped("use Nowhere", "detail", context)).toBe(false);
    expect(answerShaped("use Nowhere account", "detail", context)).toBe(true);
    expect(answerShaped("into my Savings Plus account", "detail", context)).toBe(true);
    expect(answerShaped("I hate the Nowhere account", "detail", context)).toBe(false);
  });
});

describe("the choice of another debt (ReplyData)", () => {
  it("keeps only the known plain keys of a debt write, each string cut", () => {
    expect(duplicateCallData({ note: "groceries", dueDate: "2026-10-20", amount: 500, recordTransaction: true, extra: "x", description: { a: 1 }, account: "W".repeat(900) }))
      .toEqual({ note: "groceries", dueDate: "2026-10-20", amount: 500, recordTransaction: true, account: "W".repeat(600) });
  });
  it("reads the stored JSON back and ignores anything that is not the shape written", () => {
    expect(parseReplyData(JSON.stringify({ another: true }))).toEqual({ another: true });
    expect(parseReplyData(JSON.stringify({ another: true, duplicateCall: { note: "x", bogus: 1 } }))).toEqual({ another: true, duplicateCall: { note: "x" } });
    for (const raw of [null, undefined, "", "not json", "[]", "5", JSON.stringify({ another: "yes" }), JSON.stringify({ duplicateCall: [] }), JSON.stringify({})]) expect(parseReplyData(raw), String(raw)).toBeNull();
  });
  const reply = (followup: FollowupKind | null, data: { another?: true } | null, extra: { readOnly?: boolean } = {}) => ({ role: "assistant" as const, content: "", followup, data, ...extra });
  it("reads the data of the question the run waits on, a quiet reply in between left out", () => {
    expect(openQuestionData([reply("account_or_date", { another: true }), reply("account_or_date", null, { readOnly: true })])).toEqual({ another: true });
    expect(openQuestionData([reply("account_or_date", { another: true }), reply("clarification", null)])).toBeNull();
    expect(openQuestionData([])).toBeNull();
  });
  it("keeps the choice only while a debt write for the second debt asks again with no debt on its question", () => {
    const turn = { chosen: true, call: "log_debt", debtCreated: false, asks: true, debtOnQuestion: false };
    expect(keepsAnotherChoice(turn)).toBe(true);
    for (const over of [{ chosen: false }, { call: "log_transaction" }, { debtCreated: true }, { asks: false }, { debtOnQuestion: true }]) expect(keepsAnotherChoice({ ...turn, ...over }), JSON.stringify(over)).toBe(false);
  });
});

describe("debtFlowStatement", () => {
  const msg = (content: string) => ({ role: "user" as const, content });
  const reply = (followup: FollowupKind | null, debtId: string | null, extra: { readOnly?: boolean } = {}) => ({ role: "assistant" as const, content: "", followup, debtId, ...extra });
  it("is the user messages whose reply carries the debt, a quiet reply and a reply with no debt left out", () => {
    expect(debtFlowStatement([
      msg("Ana owes me 500"), reply("debt_transaction", "d1"), msg("how much did I spend?"), reply("debt_transaction", "d1", { readOnly: true }),
      msg("Log groceries"), reply("clarification", null), msg("yes, for lunch"), reply("account_or_date", "d1"),
    ])).toEqual(["Ana owes me 500", "yes, for lunch"]);
  });
});

describe("debtOfferChainAnswer with a shape check", () => {
  const msg = (content: string) => ({ role: "user" as const, content });
  const reply = (followup: FollowupKind | null, debtId: string | null) => ({ role: "assistant" as const, content: "", followup, debtId });
  const run = [msg("Ana owes me 500"), reply("debt_transaction", "d1"), msg("yes, record my groceries for Ben"), reply("account_or_date", "d1")];
  it("records the yes by default and ignores one that was not answer-shaped when it was said", () => {
    expect(debtOfferChainAnswer(run)).toBe("optIn");
    expect(debtOfferChainAnswer(run, (content) => !content.includes("Ben"))).toBeNull();
    expect(debtOfferChainAnswer(run, () => true)).toBe("optIn");
  });
});

// Refusal wording is read only from the messages that answered the debt flow's own questions.
describe("debtFlowUserMessages", () => {
  const msg = (content: string) => ({ role: "user" as const, content });
  const reply = (followup: FollowupKind | null, debtId: string | null, extra: { readOnly?: boolean; billId?: string } = {}) => ({ role: "assistant" as const, content: "", followup, debtId, ...extra });
  const contents = (run: Parameters<typeof debtFlowUserMessages>[0]) => debtFlowUserMessages(run).map(({ message, answersOffer }) => `${message.content}${answersOffer ? " (offer)" : ""}`);

  it("reads the answer to the offer, marked, and the answers to the account, date and generic questions that carry the debt", () => {
    expect(contents([msg("Ana owes me 500"), reply("debt_transaction", "d1"), msg("no"), reply("account_or_date", "d1"), msg("Wallet"), reply("clarification", "d1")])).toEqual(["no (offer)", "Wallet"]);
  });
  it("never reads the statement itself, the first message of the run", () => {
    expect(contents([msg("Don't record it, Ana owes me 500"), reply("debt_transaction", "d1")])).toEqual([]);
  });
  it("skips a message that followed a reply carrying no debt, another kind, or a bill", () => {
    expect(contents([
      msg("Ana owes me 500"), reply("debt_transaction", "d1"), msg("Log coffee"), reply("clarification", null), msg("I don't record that"),
      reply("repayment_amount", "d1"), msg("don't record it"), reply("bill_amount", "d1"), msg("no"),
    ])).toEqual(["Log coffee (offer)"]);
  });
  it("reads a message answered by a quiet read, which carries the same question forward", () => {
    expect(contents([msg("Ana owes me 500"), reply("account_or_date", "d1"), msg("Don't record it yet, how much did I spend?"), reply("account_or_date", "d1", { readOnly: true }), msg("use Wallet")]))
      .toEqual(["Don't record it yet, how much did I spend?", "use Wallet"]);
  });
  it("reads nothing from a run with no debt flow", () => {
    expect(contents([msg("Coffee"), reply("clarification", null), msg("don't record it")])).toEqual([]);
  });
});

// Finding 27: the question stores what it asks for, and the answer is judged by that vocabulary.
describe("askedOf", () => {
  const user = { role: "user" as const, content: "x" };
  it("reads the stored asks of the question the run waits on", () => {
    expect(askedOf([{ role: "assistant", followup: "clarification", content: "Which category?", data: { asks: "category" } }])).toBe("category");
    expect(askedOf([{ role: "assistant", followup: "clarification", content: "q", data: { asks: "category" } }, user, { role: "assistant", followup: "clarification", readOnly: true, content: "a read" }])).toBe("category");
  });
  it("knows the duplicate and the ambiguity question of an older row by the text the code wrote", () => {
    const duplicate = duplicateDebtQuestion({ direction: "owed_to_you", counterparty: "Ana" }, "₱500.00");
    expect(askedOf([{ role: "assistant", followup: "clarification", content: duplicate }])).toBe("duplicate");
    expect(askedOf([{ role: "assistant", followup: "account_or_date", content: ambiguousHintsQuestion("coffee", "Wallet on 2026-10-09") }])).toBe("ambiguity");
  });
  it("says null for a question that stored none, and for no question at all", () => {
    expect(askedOf([{ role: "assistant", followup: "account_or_date", content: "What date should I use?" }])).toBeNull();
    expect(askedOf([])).toBeNull();
  });
  it("round trips through the stored data and ignores an unknown value", () => {
    expect(parseReplyData(JSON.stringify({ asks: "description" }))).toBeNull();
    expect(parseReplyData(JSON.stringify({ asks: "category" }))).toEqual({ asks: "category" });
    expect(parseReplyData(JSON.stringify({ asks: "whatever" }))).toBeNull();
    expect(parseReplyData(JSON.stringify({ another: true, asks: "account" }))).toEqual({ another: true, asks: "account" });
  });
});

// Finding 27b: each question that names what it asks for is judged by its own vocabulary.
describe("answerShaped, question by question", () => {
  const context = { accountNames: ["Wallet", "Savings"], counterparty: "Ana", amountMinor: 50_000, statement: ["Ana owes me 500", "yes, for lunch"], categoryNames: ["Food", "Eating Out", "Salary"] };
  const table: { asks: AnswerQuestion; yes: string[]; no: string[] }[] = [
    { asks: "category", yes: ["Food", "food", "yes, Food", "Eating out", "yes, eating out", "Food, please", "Salary"],
      no: ["Wallet", "lunch", "Sushi", "Food 500", "Record an expense under Food", "don't use Food", "Food and Wallet", "Use Food category", "Ben"] },
    { asks: "account", yes: ["Wallet", "use Wallet", "yes, Wallet", "Wallet today", "use Nowhere account", "2026-10-08"], no: ["lunch groceries", "Food", "500 for groceries", "another", "that one"] },
    { asks: "date", yes: ["2026-10-08", "yesterday", "Wallet on 2026-10-08", "today"], no: ["Food", "tomorrow groceries", "another"] },
    { asks: "amount", yes: ["600", "₱600.00", "it's 30", "30 pesos", "1,200.50", "500"], no: ["thirty", "600 for groceries", "make it 30", "Food 600", "don't, 600"] },
    { asks: "duplicate", yes: ["another", "that one", "the same one", "another one, Wallet"], no: ["Food", "Instead, record 500"] },
    { asks: "ambiguity", yes: ["earlier, Wallet", "new one, Wallet, today", "the earlier one 2026-10-08"], no: ["Food", "lunch groceries"] },
    { asks: "separate", yes: ["yes, separate", "Yes, separate!", "that debt", "separate", "That debt."], no: ["yes", "another", "Wallet", "yes, separate, Wallet", "that debt 500", "Spent 500 on lunch", "no", "cancel"] },
  ];
  for (const { asks, yes, no } of table) {
    for (const reply of yes) it(`${asks}: "${reply}" is an answer`, () => expect(answerShaped(reply, asks, context)).toBe(true));
    for (const reply of no) it(`${asks}: "${reply}" is not an answer`, () => expect(answerShaped(reply, asks, context)).toBe(false));
  }
  it("a category question with no category names accepts nothing but filler", () => {
    expect(answerShaped("Food", "category", { ...context, categoryNames: undefined })).toBe(false);
    expect(answerShaped("yes", "category", { ...context, categoryNames: undefined })).toBe(true);
  });
  it("a question that stored nothing keeps the account, date and filler vocabulary", () => {
    expect(answerShaped("use Wallet today", "detail", context)).toBe(true);
    expect(answerShaped("Food", "detail", context)).toBe(false);
  });
});

// Finding 27c: inside an open debt flow a message that is not answer-shaped never writes on its own authority.
describe("separateEntryChoice", () => {
  for (const reply of ["yes, separate", "Yes, separate!", "yes separately", "separate", "separate entry"]) it(`"${reply}" is the separate entry`, () => expect(separateEntryChoice(reply)).toBe("separate"));
  for (const reply of ["that debt", "That debt.", "use that debt", "the same debt"]) it(`"${reply}" continues the saved debt`, () => expect(separateEntryChoice(reply)).toBe("that"));
  for (const reply of ["yes", "no", "another", "yes, separate, Wallet", "record it separately in Wallet", "that debt 500", "", "cancel", "Spent 500 on lunch"]) it(`"${reply}" is neither`, () => expect(separateEntryChoice(reply)).toBeNull());
});

describe("separateEntryDecision", () => {
  type Turn = Parameters<typeof separateEntryDecision>[0];
  const turn = (over: Partial<Turn>): Turn => ({ separateOpen: false, choice: null, flowOpen: true, shaped: false, refusal: "proceed", call: "write", ...over });
  const table: { name: string; turn: Partial<Turn>; decision: ReturnType<typeof separateEntryDecision> }[] = [
    // No separate-entry question is open.
    { name: "a write that is no answer, in an open flow, is held however clear it looks", turn: {}, decision: "holdNew" },
    { name: "a bill that is no answer, in an open flow, is held", turn: { call: "bill" }, decision: "holdNew" },
    { name: "an answer-shaped write goes on", turn: { shaped: true }, decision: "proceed" },
    { name: "a write outside any debt flow is an ordinary write", turn: { flowOpen: false }, decision: "proceed" },
    { name: "a read is never held", turn: { call: "read" }, decision: "proceed" },
    { name: "a question the model asks writes nothing, so nothing is held", turn: { call: "ask" }, decision: "proceed" },
    { name: "a refusal outcome decides before the hold", turn: { refusal: "refuse" }, decision: "proceed" },
    { name: "a refusal that asks again decides before the hold", turn: { refusal: "askAgain" }, decision: "proceed" },
    { name: "\"yes, separate\" with no question open is no choice", turn: { choice: "separate" }, decision: "holdNew" },
    // The separate-entry question is open.
    { name: "\"yes, separate\" records the held call", turn: { separateOpen: true, choice: "separate", shaped: true }, decision: "record" },
    { name: "\"yes, separate\" records even after a refusal word was seen", turn: { separateOpen: true, choice: "separate", refusal: "refuse" }, decision: "record" },
    { name: "\"that debt\" continues the flow", turn: { separateOpen: true, choice: "that", shaped: true }, decision: "continue" },
    { name: "a refusal still wins over \"that debt\"", turn: { separateOpen: true, choice: "that", refusal: "refuse" }, decision: "proceed" },
    { name: "any other write asks again and never replaces the held call", turn: { separateOpen: true }, decision: "askAgain" },
    { name: "any other bill asks again", turn: { separateOpen: true, call: "bill" }, decision: "askAgain" },
    { name: "a model question asks again", turn: { separateOpen: true, call: "ask" }, decision: "askAgain" },
    { name: "a read leaves the question open", turn: { separateOpen: true, call: "read" }, decision: "proceed" },
    { name: "a refusal while the question is open is the refusal's decision", turn: { separateOpen: true, refusal: "refuse" }, decision: "proceed" },
  ];
  for (const row of table) it(row.name, () => expect(separateEntryDecision(turn(row.turn))).toBe(row.decision));
  it("never writes on its own authority: no turn that is neither choice reaches record", () => {
    for (const separateOpen of [false, true]) for (const flowOpen of [false, true]) for (const shaped of [false, true])
      for (const refusal of ["proceed", "refuse", "askAgain", "endQuestion"] as const) for (const call of ["write", "bill", "read", "ask"] as const)
        expect(separateEntryDecision({ separateOpen, choice: null, flowOpen, shaped, refusal, call })).not.toBe("record");
  });
  it("names the saved debt and both replies in its question", () => {
    expect(separateEntryQuestion("Ana's ₱500.00 debt")).toBe('You have an open question about Ana\'s ₱500.00 debt. Do you want me to record this as a separate new entry? Reply "yes, separate" to record it, "that debt" to continue it, or say cancel.');
  });
});

describe("the held statement (ReplyData.separate)", () => {
  const hold = { name: "log_transaction", args: { kind: "expense", amount: "500", nested: { a: ["x", 1, true, null] } }, statement: "Keep the 500 lunch out of Transactions", at: "2026-10-09T08:00:00.000Z", resume: { kind: "debt_transaction", text: "Offer?", data: { asks: "account" } } };
  it("round-trips through the stored JSON", () => {
    expect(parseReplyData(JSON.stringify({ asks: "separate", separate: hold }))).toEqual({ asks: "separate", separate: hold });
  });
  it("ignores a held call that is not the shape written", () => {
    expect(parseReplyData(JSON.stringify({ asks: "separate", separate: { name: 5, args: {}, statement: "x", at: "y" } }))).toEqual({ asks: "separate" });
    expect(parseReplyData(JSON.stringify({ separate: { name: "log_debt", args: [], statement: "x", at: "y" } }))).toBeNull();
    expect(parseReplyData(JSON.stringify({ separate: { ...hold, resume: { kind: "nonsense", text: "x" } } }))?.separate?.resume).toBeUndefined();
  });
  it("does not nest a hold inside the question it resumes", () => {
    const nested = parseReplyData(JSON.stringify({ separate: { ...hold, resume: { kind: "clarification", text: "q", data: { separate: hold } } } }));
    expect(nested?.separate?.resume?.data).toBeUndefined();
  });
});

describe("the held exchange is no part of the flow's words", () => {
  const hold = { name: "log_transaction", args: {}, statement: "Keep the 500 lunch out of Transactions", at: "2026-10-09T08:00:00.000Z" };
  const run = [
    { role: "user" as const, content: "Ana owes me 500" },
    { role: "assistant" as const, content: "offer", followup: "debt_transaction" as const, debtId: "d1" },
    { role: "user" as const, content: "Keep the 500 lunch out of Transactions" },
    { role: "assistant" as const, content: "separate?", followup: "clarification" as const, debtId: "d1", data: { asks: "separate" as const, separate: hold } },
    { role: "user" as const, content: "that debt" },
    { role: "assistant" as const, content: "offer", followup: "debt_transaction" as const, debtId: "d1" },
    { role: "user" as const, content: "yes, Wallet" },
  ];
  it("holdsSeparate is true only for a reply that carries the held statement", () => {
    expect(run.map(holdsSeparate)).toEqual([false, false, false, true, false, false, false]);
  });
  it("neither the held message nor its answer is a hint message", () => {
    expect(ownUserMessages(run).map((message) => message.content)).toEqual(["Ana owes me 500", "yes, Wallet"]);
  });
  it("neither adds a word to the flow's statement", () => {
    expect(debtFlowStatement(run)).toEqual(["Ana owes me 500"]);
  });
});

// Round 29, bug 1: a description that is too long is shortened by the code at a word boundary, never asked of the user.
describe("shortenAtWord", () => {
  it("leaves a description that fits alone", () => expect(shortenAtWord("lunch with Ana", 20)).toBe("lunch with Ana"));
  it("cuts at the last word boundary that fits", () => expect(shortenAtWord("lunch with the whole team", 17)).toBe("lunch with the"));
  it("keeps a word that ends exactly at the limit", () => expect(shortenAtWord("lunch with the whole team", 14)).toBe("lunch with the"));
  it("drops the punctuation the cut leaves behind", () => expect(shortenAtWord("lunch, with the whole team", 6)).toBe("lunch"));
  it("cuts one very long word at the limit", () => expect(shortenAtWord("a".repeat(300), 100)).toBe("a".repeat(100)));
  it("never returns more than the limit", () => {
    for (const text of ["x ".repeat(200), "word ".repeat(80), "  padded text that goes on and on  ".repeat(10)]) expect(shortenAtWord(text, 77).length).toBeLessThanOrEqual(77);
  });
});
