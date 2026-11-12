import { describe, expect, it } from "vitest";
import { DECLINED_REPLY, MAX_OPEN_RUN_MESSAGES, REFUSED_AGAIN_REPLY, REFUSED_REPLY, UNDO_WINDOW_MS, cancelHint, cancelReply, canUndo, endedQuestionReply, expiredReply, followupAfterTurn, guardUserMessages, hintMessagesFor, incomeAccountChoice, incomeChainAccount, incomeChainAnswers, isIncomeConfirmation, isOrdinaryIncomeDecline, isQuietReply, ordinaryIncomeTurn, ownUserMessages, pendingOutcome, refusalOutcome, runExpired, runSaved, turnCallOf, turnMayCommit, undoUntilFor, userMessagesFor, type RefusalOutcome, type RunMessage, type StatementOpener, type TurnCall } from "../src/lib/machines/assistant";
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

// A hint that chooses a value reads only the statement the write is for. A new statement starts at a user message that
// opens a different payment, debt, bill or transaction and is not an answer to the question pending, which the kind
// the reply before it stored decides. Quiet turns are left out.
describe("the user messages a hint may read", () => {
  type Turn = [role: "user" | "assistant", text: string, followup?: FollowupKind | null, quiet?: boolean];
  const toRun = (turns: Turn[]) => turns.map(([role, content, followup, quiet]) => ({ role, content, followup: followup ?? null, ...(quiet ? { readOnly: true } : {}) }));
  // The caller's recognizer, stood in for here: "paid" is a payment, "owes" a debt, "bill" a bill, and a message with
  // letters and a number of two digits or more states a transaction.
  const opens = (text: string): StatementOpener => /\bpaid\b/.test(text) ? "payment" : /\bowes\b/.test(text) ? "debt" : /\bbill\b/.test(text) ? "bill" : /[a-z].*\d{2}|\d{2}.*[a-z]/i.test(text) ? "transaction" : null;
  const read = (turns: Turn[], current: string) => hintMessagesFor(toRun(turns), current, opens).map((message) => message.content);
  const incomeQuestion: Turn[] = [["user", "Zed paid me 500 into Maya"], ["assistant", "Record as income?", "ordinary_income"]];

  const table: [string, Turn[], string, string[]][] = [
    ["no run, the current message stands alone", [], "Coffee 120", []],
    ["an answer stays with the statement it answers", incomeQuestion, "yes", ["Zed paid me 500 into Maya"]],
    ["a correction in the same statement stays", [...incomeQuestion, ["user", "actually into Wallet"], ["assistant", "Please answer yes", "ordinary_income"]], "yes", ["Zed paid me 500 into Maya", "actually into Wallet"]],
    ["the current message opens a payment", incomeQuestion, "Actually Ben paid me 200", []],
    ["an earlier payment that opened a new statement hides the one before it", [...incomeQuestion, ["user", "Actually Ben paid me 200"], ["assistant", "Record as income?", "ordinary_income"]], "yes", ["Actually Ben paid me 200"]],
    ["the answers after the new statement stay with it", [...incomeQuestion, ["user", "Actually Ben paid me 200"], ["assistant", "Record as income?", "ordinary_income"], ["user", "into Wallet"], ["assistant", "Please answer yes", "ordinary_income"]], "yes", ["Actually Ben paid me 200", "into Wallet"]],
    ["a payment opens whatever question was pending, the amount question included", [["user", "Zed paid me into Maya"], ["assistant", "How much?", "repayment_amount"]], "Ana paid me 200", []],
    ["a bare amount answers the amount question", [["user", "Zed paid me into Maya"], ["assistant", "How much?", "repayment_amount"]], "500", ["Zed paid me into Maya"]],
    ["an amount with a detail still answers the amount question", [["user", "Zed paid me into Maya"], ["assistant", "How much?", "repayment_amount"]], "500 cash", ["Zed paid me into Maya"]],
    ["a new debt opens", incomeQuestion, "Ben owes me 200", []],
    ["a bill opens", incomeQuestion, "I have a Netflix bill", []],
    ["a bill answers a bill question, so the statement stays", [["user", "I have a Netflix bill under Entertainment"], ["assistant", "Amount?", "bill_amount"]], "I have a Netflix bill for 549", ["I have a Netflix bill under Entertainment"]],
    ["a transaction statement opens when the question pending did not ask for one", incomeQuestion, "Coffee 120 into Wallet", []],
    ["a transaction statement answers a question that asked for an amount", [["user", "Coffee into Maya"], ["assistant", "What amount?", "clarification"]], "Coffee 120", ["Coffee into Maya"]],
    ["a date answers an account or date question", [["user", "lunch 120"], ["assistant", "What date?", "account_or_date"]], "2026-10-05", ["lunch 120"]],
    ["a payment opened earlier in the run starts the statement, not the first message", [["user", "lunch 120 into Maya"], ["assistant", "Which?", "account_or_date"], ["user", "Ben paid me 200"], ["assistant", "Record as income?", "ordinary_income"], ["user", "yes, Wallet"], ["assistant", "What date?", "account_or_date"]], "2026-10-05", ["Ben paid me 200", "yes, Wallet"]],
    ["a quiet turn neither feeds a hint nor opens a statement", [...incomeQuestion, ["user", "How much did Ana pay me, paid?"], ["assistant", "Your answer", "ordinary_income", true]], "yes", ["Zed paid me 500 into Maya"]],
    ["a quiet turn first in the run is left out too", [["user", "Ana paid me into Maya"], ["assistant", "Debts", "repayment_amount", true], ["user", "Ben paid me"], ["assistant", "How much?", "repayment_amount"]], "200", ["Ben paid me"]],
  ];
  for (const [name, turns, current, expected] of table) {
    it(`${name} -> ${expected.length ? expected.join(" | ") : "none"}`, () => expect(read(turns, current)).toEqual(expected));
  }
});
