import { describe, expect, it } from "vitest";
import { UNDO_WINDOW_MS, canUndo, pendingOutcome, undoUntilFor, type PromptFacts } from "../src/lib/machines/assistant";
import { promptFacts, type AssistantCategory } from "../src/lib/assistant";

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

const prompt = (facts: Partial<PromptFacts>): PromptFacts => ({ yesOrNo: false, paymentWording: false, hasNumber: false, categoryEvidence: false, hedged: false, namesOpenDebt: false, ...facts });
const replaceable = ["repayment_amount", "repayment_payer", "ordinary_income"] as const;

describe("pending follow-up outcome", () => {
  it("does nothing when no question is pending", () => {
    expect(pendingOutcome(null, prompt({ hasNumber: true, categoryEvidence: true }))).toBe("none");
  });

  it("replaces a pending repayment or income question only for a number with category evidence", () => {
    for (const pending of replaceable) expect(pendingOutcome(pending, prompt({ hasNumber: true, categoryEvidence: true }))).toBe("replace");
  });

  it("answers when either the number or the category evidence is missing", () => {
    for (const pending of replaceable) {
      expect(pendingOutcome(pending, prompt({ hasNumber: true }))).toBe("answer");
      expect(pendingOutcome(pending, prompt({ categoryEvidence: true }))).toBe("answer");
      expect(pendingOutcome(pending, prompt({}))).toBe("answer");
    }
  });

  it("answers even with a number and category evidence when the prompt hedges, negates, names an open debt, says yes or no, or is payment wording", () => {
    const request = { hasNumber: true, categoryEvidence: true };
    for (const pending of replaceable) {
      expect(pendingOutcome(pending, prompt({ ...request, hedged: true }))).toBe("answer");
      expect(pendingOutcome(pending, prompt({ ...request, namesOpenDebt: true }))).toBe("answer");
      expect(pendingOutcome(pending, prompt({ ...request, yesOrNo: true }))).toBe("answer");
      expect(pendingOutcome(pending, prompt({ ...request, paymentWording: true }))).toBe("answer");
    }
  });

  it("keeps answering the other pending questions, which the code resolves from context", () => {
    expect(pendingOutcome("clarification", prompt({ hasNumber: true, categoryEvidence: true }))).toBe("answer");
    expect(pendingOutcome("account_or_date", prompt({ hasNumber: true, categoryEvidence: true }))).toBe("answer");
  });
});

describe("pending follow-up outcome for real prompt wording", () => {
  const categories: AssistantCategory[] = [
    { id: "c1", name: "Salary", type: "income" }, { id: "c2", name: "Other income", type: "income" },
    { id: "c3", name: "Food", type: "expense" }, { id: "c4", name: "Transport", type: "expense" }, { id: "c5", name: "Other", type: "expense" },
    { id: "c6", name: "Pets", type: "expense" }, { id: "c7", name: "Savings", type: "expense" },
  ];
  const accounts = [{ name: "Wallet" }, { name: "GCash" }, { name: "Savings" }, { name: "BDO Savings" }];
  const outcomeFor = (pending: (typeof replaceable)[number], reply: string, openCounterparties = ["Ana"]) =>
    pendingOutcome(pending, promptFacts(reply, openCounterparties, categories, accounts));

  const answers = [
    // amount forms and details that main never read as a bare amount
    "500", "P500", "PHP 500", "₱500", "500 pesos", "500 po", "it was 500", "1,000.50", "500.", "just 500",
    "500 cash", "500 in cash", "500 to Wallet", "500 sa GCash", "500 yesterday", "500 last night", "500 kahapon", "500 kanina", "5k", "5 hundred", "500 daw", "500 bucks", "500 lng", "mga 500",
    // an account, even one that shares its name with a category
    "500 to Savings", "500 from BDO Savings", "500 from Savings to GCash", "Savings 500",
    // wording that names no category and so proves no request of its own
    "She paid 500", "paid 500", "received 500", "binayaran nya 500", "the other 500", "Ana 500",
    // approximate, hedged or negated
    "about 500", "around 500", "roughly 500", "approximately 500", "500-ish", "500ish", "500 ata", "500 cguro", "parang 500", "di 500",
    "maybe 500", "perhaps 500", "I think 500", "probably 500", "not 500", "no 500", "500?", "500 or 600", "hindi 500", "siguro 500",
    // a category word without a number, a yes or no, payment wording
    "Coffee", "yes", "no", "Ana paid me 500", "Coffee 120?", "maybe coffee 120", "not coffee 120",
    // no number
    "Other",
  ];
  for (const reply of answers) {
    it(`treats "${reply}" as an answer to every pending question`, () => {
      for (const pending of replaceable) expect(outcomeFor(pending, reply)).toBe("answer");
    });
  }

  const requests = [
    "Coffee 120", "coffee 120", "lunch 250", "Grab 180", "bought coffee 120", "Jollibee lunch 250", "Taxi P85", "lunch 250 yesterday", "Grab 1,200.50",
    "Coffee 120 from Missing", "Coffee 120 to Wallet", "Coffee 120 sa GCash", "Lunch 5k", "Jollibee 250 daw", "salary 20000", "Pets 300", "500 for lunch",
  ];
  for (const request of requests) {
    it(`replaces every pending question with the complete request "${request}"`, () => {
      for (const pending of replaceable) expect(outcomeFor(pending, request)).toBe("replace");
    });
  }

  it("answers a request that names someone with an open debt", () => {
    expect(outcomeFor("repayment_payer", "Ana coffee 120")).toBe("answer");
    expect(outcomeFor("repayment_payer", "Coffee 120 for Ana")).toBe("answer");
    expect(outcomeFor("repayment_payer", "Coffee 120 for Ben", ["Ana"])).toBe("replace");
  });

  it("does not count an account name as category evidence, even when a category has the same name", () => {
    expect(promptFacts("500 to Savings", [], categories, accounts).categoryEvidence).toBe(false);
    expect(promptFacts("Pets 500 to Savings", [], categories, accounts).categoryEvidence).toBe(true);
    expect(promptFacts("500 to Savings", [], categories, []).categoryEvidence).toBe(true);
  });

  it("finds a category the user renamed through the keyword map and through the user's own names", () => {
    const renamed: AssistantCategory[] = [{ id: "x", name: "Groceries", type: "expense" }];
    expect(promptFacts("coffee 120", [], renamed, accounts).categoryEvidence).toBe(true);
    expect(promptFacts("Groceries 800", [], renamed, accounts).categoryEvidence).toBe(true);
    expect(promptFacts("800", [], renamed, accounts).categoryEvidence).toBe(false);
  });
});
