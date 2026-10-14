import { z } from "zod";
import { HttpError } from "@/lib/api";
import { getStore } from "@/lib/db";
import { todayInManila, timeInManila, isDateOnly, isTime, monthToDateRange } from "@/lib/dates";
import { formatPHP, formatPHPFromMinorString, parsePHPToMinor } from "@/lib/money";
import type { Account, Debt, Transaction } from "@/lib/store";
import { askProvider, minimalFollowUpContext, providerConfig, providerDisclosureHash } from "@/lib/provider";

export const assistantPromptSchema = z.object({ prompt: z.string().trim().min(1).max(2000), conversationId: z.string().uuid().optional() });
export type AssistantPromptInput = z.infer<typeof assistantPromptSchema>;
export function assertAssistantAccess(store: ReturnType<typeof getStore>, userId: string): void {
  if (!store.getAssistantOptIn(userId, providerDisclosureHash() ?? undefined)) throw new HttpError(403, "Enable the assistant in Settings after reviewing the current provider disclosure.");
  if (!providerConfig()) throw new HttpError(503, "The Codex-LB provider and privacy disclosure are not fully configured.");
}
function formatAssistantDate(date: string, month: "short" | "long" = "short"): string {
  const options: Intl.DateTimeFormatOptions = month === "long" ? { month, timeZone: "UTC" } : { month, day: "numeric", timeZone: "UTC" };
  return new Intl.DateTimeFormat("en-US", options).format(new Date(`${date}T00:00:00Z`));
}
function answerForFacts(facts: ReturnType<ReturnType<typeof getStore>["getFinanceFacts"]>, prompt: string) {
  if (/\b(?:assets?|balances?|account totals?)\b/i.test(prompt)) {
    return `Account Balances\n\n${facts.accounts.map((account) => `${account.name}: ${formatPHP(account.balanceMinor)}`).join("\n") || "No accounts yet."}`;
  }
  const currentPeriod = monthToDateRange();
  const period = facts.start === currentPeriod.start && facts.end === currentPeriod.end
    ? `This ${formatAssistantDate(facts.end, "long")}`
    : `From ${formatAssistantDate(facts.start)} to ${formatAssistantDate(facts.end)}`;
  if (facts.requestedCategory) return `${period}\n\n${facts.requestedCategory}: ${formatPHP(facts.categoryAmountMinor ?? 0)}`;
  const topCategories = facts.byCategory.slice(0, 3).map((item) => `${item.name}: ${formatPHP(item.amountMinor)}`).join("\n");
  const asksIncome = /\b(?:income|earnings?|salary|earned|received)\b/i.test(prompt);
  const asksSpending = /\b(?:spend(?:ing)?|spent|expenses?|purchases?)\b/i.test(prompt);
  if (asksSpending && !asksIncome) return `${period}\n\nTotal Spent: ${formatPHP(facts.spendingMinor)}${topCategories ? `\n${topCategories}` : ""}`;
  if (asksIncome && !asksSpending) return `${period}\n\nTotal Income: ${formatPHP(facts.incomeMinor)}`;
  return `${period}\n\nTotal Income: ${formatPHP(facts.incomeMinor)}\nTotal Spent: ${formatPHP(facts.spendingMinor)}${topCategories ? `\n${topCategories}` : ""}`;
}
function debtQuestion(prompt: string): boolean {
  return /\b(?:list|show|display)\b.*\b(?:debts?|people who owe|people i owe|people who currently owe)\b/i.test(prompt)
    || /\b(?:open debt list|debt list|list of debts)\b/i.test(prompt)
    || /\b(?:who owes me(?: money)?|how much do (?:people|they) owe me|what debt do i owe|who do i owe|how much do i owe|how much is owed to me)\b/i.test(prompt);
}
function answerForDebts(debts: Debt[], prompt: string, accounts: Account[]): string {
  const direction = /\b(?:owed to me|owe me|owes me|people who owe me|people who currently owe me)\b/i.test(prompt) ? "owed_to_you"
    : /\b(?:i owe|we owe|owed by me|people i owe)\b/i.test(prompt) ? "you_owe" : undefined;
  const asksBothStatuses = /\b(?:open|outstanding)\b.*\bsettled\b|\bsettled\b.*\b(?:open|outstanding)\b/i.test(prompt);
  const asksAllWithoutStatus = /\ball\b/i.test(prompt) && !/\b(?:open|outstanding|settled)\b/i.test(prompt);
  const asksAllIncludingSettled = /\ball\b.*\bdebts?\b.*\b(?:including|with)\b.*\bsettled\b/i.test(prompt);
  const status = asksBothStatuses || asksAllWithoutStatus || asksAllIncludingSettled ? "all" : /\bsettled\b/i.test(prompt) ? "settled" : "open";
  const matches = debts.filter((debt) => (status === "all" || debt.status === status) && (!direction || debt.direction === direction));
  const title = status === "all" ? `All debts${direction === "owed_to_you" ? " owed to you" : direction === "you_owe" ? " you owe" : ""}`
    : status === "settled" ? "Settled debts (last outstanding balances)"
    : `Open debts${direction === "owed_to_you" ? " owed to you" : direction === "you_owe" ? " you owe" : ""}`;
  const lines = matches.map((debt) => `${debt.counterparty}: ${formatPHP(debt.amountMinor)}${status === "all"
    ? debt.status === "settled" ? " (settled; last outstanding balance)" : " (open)"
    : status === "settled" ? " (last outstanding balance)" : ""}`);
  const amount = matches.reduce((total, debt) => total + BigInt(debt.amountMinor), 0n);
  const totalLabel = status === "settled" ? "Total last outstanding balance"
    : direction === "owed_to_you" ? "Total owed to you" : direction === "you_owe" ? "Total you owe" : "Total debt balance";
  const asksTotal = /\b(?:total|amount|balance|how much)\b/i.test(prompt);
  const allStatusTotals = status === "all" ? `\nTotal outstanding: ${formatPHPFromMinorString(matches.filter((debt) => debt.status === "open").reduce((total, debt) => total + BigInt(debt.amountMinor), 0n).toString())}\nTotal last outstanding balance: ${formatPHPFromMinorString(matches.filter((debt) => debt.status === "settled").reduce((total, debt) => total + BigInt(debt.amountMinor), 0n).toString())}` : "";
  const asksAccountBalance = /\b(?:account|wallet|cash)\b|\bmy\b.*\bbalance\b|\bbalances\b/i.test(prompt);
  const accountTotal = accounts.reduce((total, account) => total + BigInt(account.balanceMinor), 0n);
  const accountBalances = asksAccountBalance
    ? `Account Balances\n\n${accounts.map((account) => `${account.name}: ${formatPHP(account.balanceMinor)}`).join("\n") || "No accounts yet."}\nTotal Account Balance: ${formatPHPFromMinorString(accountTotal.toString())}`
    : "";
  const debtTotals = asksTotal ? status === "all" ? allStatusTotals : `\n${totalLabel}: ${formatPHPFromMinorString(amount.toString())}` : "";
  return `${title}\n\n${lines.join("\n") || "None."}${debtTotals}${accountBalances ? `\n\n${accountBalances}` : ""}`;
}
function repaymentAmountFromPrompt(prompt: string): number | undefined {
  const amountPattern = "(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d{1,2})?";
  const dateFreeText = prompt.replace(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/gi, " ")
    .replace(/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:,?\s+\d{4})?\b/gi, " ")
    .replace(/\b\d{1,2}:\d{2}\s*(?:am|pm)?\b|\b\d{1,2}\s*(?:am|pm)\b/gi, " ");
  const incoming = new RegExp(`\\b(?:paid\\s+(?:me(?:\\s+back)?|back)|repaid(?:\\s+me)?|returned)\\s+(?:₱|PHP\\s*)?(${amountPattern})(?:\\s*(?:PHP|pesos?))?(?=$|[\\s,.;!?])`, "gi");
  const incomingMatches = [...dateFreeText.matchAll(incoming)].filter((match) => {
    const subject = dateFreeText.slice(0, match.index).trimEnd().match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*$/u)?.[0];
    return !/^(?:i|we)$/i.test(subject ?? "");
  });
  const outgoing = new RegExp(`\\b(?:i|we)\\s+(?:paid\\s+back|paid|repaid|returned|settled)\\s+(?:to\\s+)?(?:[\\p{L}\\p{N}'’.-]+\\s+){0,4}(?:₱|PHP\\s*)?(${amountPattern})(?:\\s*(?:PHP|pesos?))?(?=$|[\\s,.;!?])`, "giu");
  const tiedToPayment = [...incomingMatches, ...dateFreeText.matchAll(outgoing)];
  const raw = tiedToPayment.length === 1 ? tiedToPayment[0][1] : undefined;
  if (!raw) return undefined;
  try { return parsePHPToMinor(raw) || undefined; } catch { return undefined; }
}
function bareAmountFromPrompt(prompt: string): number | undefined {
  const match = /^\s*(₱\s*)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(?:php|pesos?)?\s*[.!]?\s*$/i.exec(prompt);
  if (!match) return undefined;
  try { return parsePHPToMinor(`${match[1] ?? ""}${match[2]}${match[3] ? `.${match[3]}` : ""}`); } catch { return undefined; }
}
function parseProviderAmount(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  try { return parsePHPToMinor(String(value)); } catch { return undefined; }
}
function safeClarification(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 3 || value.length > 240) return "What amount or category should I use?";
  return value.trim();
}
type AssistantCategory = { id: string; name: string; type: "income" | "expense" };
function normalizeCategoryName(value: string): string {
  return value.toLowerCase().replace(/\btranspor(?:tation|attion)\b/g, "transport").replace(/[^a-z0-9]+/g, " ").trim();
}
function normalizeWords(value: string): string {
  return value.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
function normalizeCounterparty(value: string): string {
  return value.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}-]+/gu, " ").replace(/\s+/g, " ").trim();
}
function containsCounterparty(text: string, counterparty: string): boolean {
  const normalizedCounterparty = normalizeCounterparty(counterparty);
  return normalizedCounterparty.length > 0 && ` ${normalizeCounterparty(text)} `.includes(` ${normalizedCounterparty} `);
}
function debtNoteMatches(text: string, note: string): boolean {
  // shortcut: matches full note phrases after one leading filler; broaden when users need partial note matching.
  const normalizedNote = normalizeWords(note).replace(/^(?:about|for|the|a|an)\s+/, "");
  return Boolean(normalizedNote && containsCounterparty(text, normalizedNote));
}
function hasIncomingDebtRepaymentWording(text: string): boolean {
  if (/\b(?:paid\s+me|repaid\s+me|repayment)\b/i.test(text)) return true;
  const payment = /\b(?:paid\s+back|repaid|returned)\s+(?:(?:₱|PHP|\$)\s*)?\d|\breturned\s+(?:the|my)\s+money\b/giu;
  return [...text.matchAll(payment)].some((match) => {
    const beforePayment = text.slice(0, match.index).trimEnd();
    const subject = beforePayment.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*$/u)?.[0];
    return Boolean(subject && !/^(?:i|we|you)$/i.test(subject));
  });
}
function isUncertainStatement(text: string): boolean {
  return text.includes("?") || /\b(?:did not|didn't|does not|doesn't|do not|don't|has not|hasn't|have not|haven't|never|not|maybe|perhaps|possibly|probably|might|may|could|would|will|if|whether|think|thought|unsure|uncertain)\b/i.test(text);
}
function isUnconfirmedIncomingDebtPayment(text: string): boolean {
  return /\b(?:pay|paid|pays|paying)\s+(?:me|back)\b|\b(?:repay|repays|repaid|repayment|return|returns|returned|returning)\b/i.test(text)
    && isUncertainStatement(text);
}
function isUnconfirmedOutgoingDebtPayment(text: string): boolean {
  return hasOutgoingDebtRepaymentWording(text)
    && (isUncertainStatement(text) || /\b(?:did|do|does)\s+(?:i|we)\s+(?:pay|paid|repaid|return|settle)\b/i.test(text));
}
function hasOutgoingDebtRepaymentWording(text: string): boolean {
  return /\b(?:i|we)\s+(?:(?:didn't|did not|haven't|have not|hasn't|has not|hadn't|had not|never|maybe|might not)\s+)?(?:paid|pay|repaid|returned|settled)\b|\b(?:i|we)\s+paid\s+back\b/i.test(text);
}
function hasOutgoingPayeeOrPurpose(text: string): boolean {
  const match = /\b(?:i|we)\s+(?:paid\s+back|paid|repaid|returned|settled)\s+(.+?)\s*[.!?]?\s*$/i.exec(text);
  if (!match) return false;
  const amount = /^(?:₱|PHP|\$)?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?(?:\s*(?:PHP|pesos?))?/i;
  if (!amount.test(match[1].trim())) return true;
  return /\b(?:to|for)\s+[\p{L}\p{N}]/iu.test(match[1].replace(amount, ""));
}
function isUncertainNewDebtStatement(text: string): boolean {
  return /\b(?:maybe|perhaps|possibly|probably|might|may|could|would|if|whether|think|thought|unsure|uncertain)\b/i.test(text)
    || /\b(?:doesn't|does not|don't|do not|didn't|did not|never|no longer|not)\b.{0,35}\b(?:owe|owes|owed|borrow|borrowed|lend|lent|loan|debt)\b/i.test(text)
    || /\b(?:owe|owes|owed|borrow|borrowed|lend|lent)\b.{0,35}\b(?:nothing|no money|no debt|no amount|not anything)\b/i.test(text)
    || /^\s*(?:does|do|did|is|are|was|were|can|could|would|should)\b.{0,120}\b(?:owe|owes|owed|borrow|borrowed|lend|lent|loan|debt)\b/i.test(text)
    || /\b(?:owe|owes|owed|borrow|borrowed|lend|lent|fronted|advanced|loaned)\b.*\?\s*$/i.test(text)
      && !/\b(?:note|description|category|account|date|time)\s*\?\s*$/i.test(text)
    || /\b(?:owe|owes|owed|borrow|borrowed|lend|lent|fronted|advanced|loaned)\b.{0,100}\b(?:right|correct)\s*\?\s*$/i.test(text);
}
function isConfirmedDebtFollowUp(messages: string[]): boolean {
  const latest = messages.at(-1)?.trim() ?? "";
  return messages.slice(0, -1).some(isUncertainNewDebtStatement)
    && /^(?:yes|yeah|yep|correct|confirmed|that's right|that is right|that's confirmed|that is confirmed|she does|he does|they do)\b/i.test(latest);
}
function explicitNewDebtIntent(message: string): { direction: "owed_to_you" | "you_owe"; counterparty: string } | undefined {
  const text = message.trim().replace(/^(?:please\s+)?(?:record|log|add|track|enter)\s+(?:that\s+|a\s+debt(?:\s+that)?\s*)?/i, "")
    .replace(/^(?:maybe|perhaps|possibly|probably|i think)\s+/i, "");
  const cleanName = (value: string) => value.replace(/^my\s+/i, "").replace(/[,:;.!?]+$/, "").trim();
  const owedToYou = /^(.+?)\s+ow(?:e|es|ed)\s+(?:me|us)\b/i.exec(text);
  if (owedToYou) {
    const counterparty = cleanName(owedToYou[1]);
    if (counterparty) return { direction: "owed_to_you", counterparty };
  }
  const youOwe = /^(?:i|we)\s+ow(?:e|ed)\s+(.+?)(?=\s+(?:(?:₱|php|\$)\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?\b|\s+(?:for|due|on|because)\b|$)/i.exec(text);
  if (youOwe) {
    const counterparty = cleanName(youOwe[1]);
    if (counterparty) return { direction: "you_owe", counterparty };
  }
  const amount = "(?:(?:₱|PHP|\\$)\\s*)?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d{1,2})?";
  const date = "(?:today|yesterday|tomorrow|(?:(?:last|next|this)\\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[/-]\\d{1,2}(?:[/-]\\d{2,4})?|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?\\s+\\d{1,2}(?:,?\\s+\\d{4})?)";
  const afterCounterparty = `(?=\\s+(?:for|due|on|because|about)\\b|\\s+${date}\\b|\\s+and\\s+(?:then\\s+)?(?:add|record|put|log|include|create)\\b|[,;.!?]|$)`;
  const borrowed = new RegExp(`^(?:i|we)\\s+borrow(?:ed)?\\s+${amount}\\s+from\\s+(.+?)${afterCounterparty}`, "i").exec(text);
  if (borrowed) return { direction: "you_owe", counterparty: cleanName(borrowed[1]) };
  const fronted = new RegExp(`^(?:i|we)\\s+fronted\\s+${amount}\\s+(?:for|to)\\s+(.+?)${afterCounterparty}`, "i").exec(text);
  if (fronted) return { direction: "owed_to_you", counterparty: cleanName(fronted[1]) };
  const borrowedFromMe = new RegExp(`^(.+?)\\s+borrowed\\s+${amount}\\s+from\\s+(?:me|us)\\b`, "i").exec(text);
  if (borrowedFromMe) return { direction: "owed_to_you", counterparty: cleanName(borrowedFromMe[1]) };
  const lent = new RegExp(`^(?:i|we)\\s+lent\\s+(.+?)\\s+${amount}${afterCounterparty}`, "i").exec(text);
  if (lent) return { direction: "owed_to_you", counterparty: cleanName(lent[1]) };
  return undefined;
}
function latestExplicitNewDebtIntent(messages: string[]): { direction: "owed_to_you" | "you_owe"; counterparty: string } | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const intent = explicitNewDebtIntent(messages[index]);
    if (intent) return intent;
  }
  return undefined;
}
function hasClearDebtTransactionOptOut(messages: string[]): boolean {
  return messages.some((text) => /\b(?:don't|dont|do not|no need to)\b.{0,40}\b(?:want|need|add|adding|record|recording|put|putting|log|logging|include|including|create|creating)\b.{0,50}\b(?:transaction|transactions|expense|expenses|ledger)\b/i.test(text)
    || /\bwithout\b.{0,25}\b(?:adding|recording|putting|logging|including|creating)\b.{0,50}\b(?:transaction|transactions|expense|expenses|ledger)\b/i.test(text)
    || /\b(?:keep|leave)\s+(?:it\s+)?(?:as\s+)?(?:a\s+)?debt[- ]only\b/i.test(text)
    || /\bno\s+(?:transaction|transactions|expense|expenses)\b(?!\s+yet)/i.test(text));
}
function hasClearDebtTransactionOptIn(messages: string[]): boolean {
  return messages.some((text) => /\b(?:add|record|log|put|include|create)\b.{0,55}\b(?:transaction|transactions|expense|income|ledger)\b/i.test(text)
    || /\b(?:add|record|log|put|include|create)\b.{0,30}\b(?:it|this|that|the advance|the borrowed money)\b.{0,35}\b(?:to|in)\b.{0,15}\b(?:my\s+)?transactions?\b/i.test(text));
}
function categoryNameMatches(name: string, categories: AssistantCategory[]): AssistantCategory[] {
  const exact = categories.filter((category) => category.name.toLowerCase() === name.trim().toLowerCase());
  if (exact.length) return exact;
  const normalizedName = normalizeCategoryName(name);
  return categories.filter((category) => normalizeCategoryName(category.name) === normalizedName);
}
function findCategory(name: string, categories: AssistantCategory[], preferredType?: AssistantCategory["type"]): AssistantCategory | null | undefined {
  const matches = categoryNameMatches(name, categories);
  if (matches.length === 1) return preferredType && matches[0].type !== preferredType ? null : matches[0];
  if (!matches.length) return undefined;
  return preferredType ? matches.find((category) => category.type === preferredType) ?? null : null;
}
function findCategoryInText(text: string, categories: AssistantCategory[], preferredType?: AssistantCategory["type"]): AssistantCategory | null | undefined {
  const normalizedText = normalizeWords(text);
  const containsName = (category: AssistantCategory, source: string) => {
    const name = normalizeWords(category.name);
    return name.length > 0 && ` ${source} `.includes(` ${name} `);
  };
  const byLength = [...categories].sort((a, b) => b.name.length - a.name.length);
  const exactMentions = byLength.filter((category) => containsName(category, normalizedText));
  const aliasedText = normalizedText.replace(/\btranspor(?:tation|attion)\b/g, "transport");
  const aliasMatches = byLength.filter((category) => containsName(category, aliasedText));
  const matches = [...new Map([...exactMentions, ...aliasMatches].map((category) => [category.id, category])).values()];
  if (!matches.length) return undefined;
  const longest = Math.max(...matches.map((category) => category.name.length));
  const longestMatches = matches.filter((category) => category.name.length === longest);
  if (longestMatches.length === 1) return preferredType && longestMatches[0].type !== preferredType ? undefined : longestMatches[0];
  if (preferredType) return longestMatches.find((category) => category.type === preferredType) ?? null;
  return null;
}
function guessCategory(text: string, categories: AssistantCategory[]): AssistantCategory | undefined {
  const rules: [RegExp, string, AssistantCategory["type"]][] = [
    [/\b(food|lunch|dinner|breakfast|coffee|restaurant|jollibee|meal|grocer)\b/i, "Food", "expense"],
    [/\b(transport|transpor(?:tation|attion)|commut(?:e|ing)|transit|bus|train|taxi|grab|jeep|fare|fuel|gasoline)\b/i, "Transport", "expense"],
    [/\b(rent|mortgage|condo)\b/i, "Housing", "expense"], [/\b(electric|water|internet|utility)\b/i, "Utilities", "expense"],
    [/\b(doctor|medicine|pharmacy|clinic|hospital)\b/i, "Health", "expense"], [/\b(school|tuition|book|course)\b/i, "Education", "expense"],
    [/\b(movie|concert|game|stream)\b/i, "Entertainment", "expense"], [/\b(flight|hotel|vacation|travel)\b/i, "Travel", "expense"],
    [/\b(salary|payroll|payday)\b/i, "Salary", "income"],
  ];
  const rule = rules.find(([pattern]) => pattern.test(text));
  return rule ? categories.find((category) => category.type === rule[2] && normalizeCategoryName(category.name) === normalizeCategoryName(rule[1])) : undefined;
}
function explicitTransactionKind(text: string): AssistantCategory["type"] | undefined {
  const mentionsExpense = /\b(expense|spent|spend|paid|purchase|bought|buy|cost|charged|charge)\b/i.test(text);
  const mentionsIncome = /\b(income|earned|earn|received|receive|deposit|paycheck)\b/i.test(text);
  return mentionsExpense === mentionsIncome ? undefined : mentionsExpense ? "expense" : "income";
}
function transactionKind(value: unknown, userText: string): AssistantCategory["type"] {
  if (value === "income" || value === "expense") return value;
  const receivedMoney = /\b(?:salary|payroll|paycheck|wages?|income|earned|received|deposit|refund|reimbursement|commission|bonus|cashback|sold|got paid|was paid|paid me)\b/i.test(userText);
  const spentMoney = /\b(?:spent|spend|paid|bought|purchased?|purchase|cost|expense|bill)\b/i.test(userText)
    && !/\b(?:got|was|been)\s+paid\b|\bpaid me\b/i.test(userText);
  if (spentMoney) return "expense";
  return receivedMoney ? "income" : "expense";
}
function fallbackCategory(kind: AssistantCategory["type"], categories: AssistantCategory[]): AssistantCategory | undefined {
  const fallbackName = kind === "income" ? "Other income" : "Other";
  return categories.find((category) => category.type === kind && category.name.toLowerCase() === fallbackName.toLowerCase())
    ?? categories.find((category) => category.type === kind);
}
function accountMention(text: string, accounts: Account[]): Account | undefined {
  const cues = "from|to|into|using|via|in|use|with|account(?:\\s+named)?|card";
  return [...accounts].sort((a, b) => b.name.length - a.name.length).find((account) => {
    const name = account.name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    return new RegExp(`\\b(?:${cues})\\s+(?:my\\s+)?${name}(?:\\s+(?:account|card))?\\b`, "i").test(text);
  });
}
function accountHintFromMessages(messages: string[], accounts: Account[]): { account?: Account; mentioned: boolean; invalidName?: string } {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (/\b(?:use|choose|select|set|switch(?:\s+to)?|change\s+to)\s+(?:my\s+)?default(?:\s+account)?\b/i.test(messages[index])) return { account: accounts.find((candidate) => candidate.isDefault), mentioned: true };
    const account = accountMention(messages[index], accounts);
    if (account) return { account, mentioned: true };
    const namedAccount = /\b(?:my\s+)?([\p{L}\p{N}][\p{L}\p{N}'’ .-]{0,58})\s+(?:account|card)\b/iu.exec(messages[index]);
    if (namedAccount) return { mentioned: true, invalidName: namedAccount[1].trim() };
  }
  return { mentioned: false };
}
function latestCategoryHintFromMessages(messages: string[], categories: AssistantCategory[], type?: AssistantCategory["type"]): { category?: AssistantCategory | null; mentioned: boolean } {
  for (let index = messages.length - 1; index >= 0; index--) {
    const category = findCategoryInText(messages[index], categories, type);
    if (category !== undefined) return { category, mentioned: true };
    if (/\bcategory\b/i.test(messages[index])) return { category: null, mentioned: true };
  }
  return { mentioned: false };
}
function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}
function dateHintFromMessage(message: string, referenceDate: Date): { date?: string; mentioned: boolean } {
  const dateToken = "(?:\\d{4}-\\d{2}-\\d{2}|today|yesterday|tomorrow|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\s+\\d{1,2}(?:,\\s*\\d{4})?|\\d{1,2}[/-]\\d{1,2}(?:[/-]\\d{2,4})?)";
  const transactionDateText = message.replace(new RegExp(`\\b(?:due(?:\\s+date)?|repayable|payable)(?:\\s+is)?\\s*:?[ \\t]+(?:(?:on|by)\\s+)?${dateToken}`, "gi"), " ");
  const rawIsoDates = [...transactionDateText.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map(([date]) => date);
  if (rawIsoDates.some((date) => !isDateOnly(date))) return { mentioned: true };
  const isoDates = rawIsoDates.filter(isDateOnly);
  if (isoDates.length === 1) return { date: isoDates[0], mentioned: true };
  if (isoDates.length > 1) return { mentioned: true };
  const relativeDates = [...transactionDateText.matchAll(/\b(today|yesterday|tomorrow)\b/gi)].map(([, date]) => date.toLowerCase());
  if (relativeDates.length) {
    const uniqueDates = [...new Set(relativeDates)];
    if (uniqueDates.length !== 1) return { mentioned: true };
    const offset = uniqueDates[0] === "yesterday" ? -1 : uniqueDates[0] === "tomorrow" ? 1 : 0;
    return { date: shiftDate(todayInManila(referenceDate), offset), mentioned: true };
  }
  return { mentioned: /\b(?:date|last\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month)|next\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month)|this\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|on\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)\b/i.test(transactionDateText) };
}
function priorDateHint(messages: { content: string; createdAt?: string }[]): { date?: string; mentioned: boolean } {
  for (let index = messages.length - 1; index >= 0; index--) {
    const createdAt = messages[index].createdAt ? new Date(messages[index].createdAt!) : new Date();
    const referenceDate = Number.isFinite(createdAt.getTime()) ? createdAt : new Date();
    const hint = dateHintFromMessage(messages[index].content, referenceDate);
    if (hint.mentioned) return hint;
  }
  return { mentioned: false };
}
function timeHintFromMessages(messages: string[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const matches = [...messages[index].matchAll(/\b(?:(1[0-2]|0?[1-9])(?::?([0-5]\d))?\s*([ap])\.?m\.?|([01]?\d|2[0-3]):([0-5]\d))\b/gi)];
    if (!matches.length) continue;
    if (matches.length > 1) return undefined;
    const [, hour12, minute12, meridiem, hour24, minute24] = matches[0];
    const hour = hour12 ? Number(hour12) % 12 + (meridiem.toLowerCase() === "p" ? 12 : 0) : Number(hour24);
    return `${String(hour).padStart(2, "0")}:${minute12 ?? minute24 ?? "00"}`;
  }
  return undefined;
}
function directCategoryCapture(prompt: string, categories: AssistantCategory[]): { name: string; args: Record<string, unknown> } | null {
  const text = prompt.trim().replace(/[.!]+$/, "");
  if (text.includes("?")) return null;
  const match = /^(.+?)\s+((?:₱\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)$/.exec(text);
  if (!match) return null;
  const label = match[1].trim();
  const category = findCategory(label, categories) ?? findCategoryInText(label, categories);
  if (!category) return null;
  return { name: "log_transaction", args: { kind: category.type, category: category.name, amount: match[2], description: label } };
}
const unclearDebtCounterparty = /^(?:(?:some|any|every)one(?:\s+else)?|(?:some|any|every)body(?:\s+else)?|nobody|no\s+one|people|(?:some|the)\s+people|(?:some|any|a|the|other)\s+person|unknown|unspecified|maybe|perhaps|probably|possibly|all|both|they|them|you|us)$/i;
function directDebtCapture(prompt: string): { name: string; args: Record<string, unknown> } | null {
  const rawText = prompt.trim().replace(/^(?:please\s+)?(?:record|log|add|track|enter)\s+(?:that\s+|a\s+debt(?:\s+that)?\s*)?/i, "");
  if (isUncertainNewDebtStatement(rawText)) return null;
  const text = rawText.replace(/[.!?]+$/, "");
  const amount = "((?:₱\\s*)?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d{1,2})?)";
  const patterns: { pattern: RegExp; direction: "owed_to_you" | "you_owe" }[] = [
    { pattern: new RegExp(`^(.+?)\\s+ow(?:e|es|ed)\\s+me\\s+${amount}$`, "i"), direction: "owed_to_you" },
    { pattern: new RegExp(`^(?:i|we)\\s+ow(?:e|es|ed)\\s+(.+?)\\s+${amount}$`, "i"), direction: "you_owe" },
  ];
  for (const { pattern, direction } of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const rawCounterparty = match[1].replace(/^my\s+/i, "").replace(/[,:;.!]+$/, "").trim();
    if (!rawCounterparty || unclearDebtCounterparty.test(rawCounterparty)) return null;
    const counterparty = rawCounterparty.replace(/(^|[\s-])\p{L}/gu, (letter) => letter.toUpperCase());
    if (!/^\p{Lu}[\p{L}'’ .\-]*$/u.test(counterparty)) return null;
    return { name: "log_debt", args: { direction, counterparty, amount: match[2] } };
  }
  return null;
}

export async function runAssistantPrompt(store: ReturnType<typeof getStore>, user: { id: string }, input: AssistantPromptInput) {
    const accounts = store.listAccounts(user.id);
    const categories = store.listCategories(user.id);
    let conversationId = input.conversationId;
    if (conversationId) {
      if (!store.getConversation(user.id, conversationId)) throw new HttpError(404, "Conversation not found.");
    } else conversationId = store.createConversation(user.id, input.prompt.slice(0, 80));
    const history = minimalFollowUpContext(store.getConversation(user.id, conversationId)?.messages ?? []);
    const promptCreatedAt = new Date().toISOString();
    const userMessages = [
      ...history.filter((message) => message.role === "user").map((message) => ({ content: message.content, createdAt: message.createdAt })),
      { content: input.prompt, createdAt: promptCreatedAt },
    ];
    const userMessageText = userMessages.map((message) => message.content);
    store.addMessage(user.id, conversationId, "user", input.prompt);
    if (debtQuestion(input.prompt)) {
      const answer = answerForDebts(store.listDebts(user.id), input.prompt, store.listAccounts(user.id));
      store.addMessage(user.id, conversationId, "assistant", answer);
      return { conversationId, answer, transaction: null, debt: null, undoUntil: null };
    }
    const directCapture = history.length ? null : directDebtCapture(input.prompt) ?? directCategoryCapture(input.prompt, categories);
    const openOwedToYouDebts = store.listDebts(user.id)
      .filter((debt) => debt.direction === "owed_to_you" && debt.status === "open")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const openOwedToYou = openOwedToYouDebts.map(({ counterparty, amountMinor }) => ({ counterparty, amountMinor }));
    const openYouOweDebts = store.listDebts(user.id)
      .filter((debt) => debt.direction === "you_owe" && debt.status === "open")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const openYouOwe = openYouOweDebts.map(({ counterparty, amountMinor }) => ({ counterparty, amountMinor }));
    const providerCall = directCapture ?? await askProvider({ prompt: input.prompt, history, categories, openOwedToYou, openYouOwe });
    if (!providerCall) throw new Error("Assistant provider returned no action.");
    const lastHistoryMessage = history.at(-1);
    const lastAssistantFollowup = lastHistoryMessage?.role === "assistant" ? lastHistoryMessage.content : "";
    const ordinaryIncomeQuestionPattern = /\b(?:should i record|please answer yes)\b.*\bordinary income\b/i;
    let ordinaryIncomeQuestionIndex = -1;
    for (let index = history.length - 1; index >= 0; index--) {
      if (history[index].role === "assistant" && ordinaryIncomeQuestionPattern.test(history[index].content)) {
        ordinaryIncomeQuestionIndex = index;
        break;
      }
    }
    const ordinaryIncomeQuestionPending = ordinaryIncomeQuestionPattern.test(lastAssistantFollowup);
    const afterOrdinaryIncomeQuestion = ordinaryIncomeQuestionIndex >= 0 ? history.slice(ordinaryIncomeQuestionIndex + 1) : [];
    const ordinaryIncomeConfirmedInHistory = afterOrdinaryIncomeQuestion.some((message) => message.role === "user"
      && /^\s*(?:yes|yeah|yep|sure|okay|ok|go ahead|record it|record that)\b/i.test(message.content))
      && !afterOrdinaryIncomeQuestion.some((message) => message.role === "user" && (hasIncomingDebtRepaymentWording(message.content) || hasOutgoingDebtRepaymentWording(message.content)));
    const ordinaryIncomeFlow = !hasIncomingDebtRepaymentWording(input.prompt) && !hasOutgoingDebtRepaymentWording(input.prompt)
      && (ordinaryIncomeConfirmedInHistory || ordinaryIncomeQuestionPending);
    const ordinaryIncomeAccepted = ordinaryIncomeConfirmedInHistory || (ordinaryIncomeQuestionPending
      && /^\s*(?:yes|yeah|yep|sure|okay|ok|go ahead|record it|record that)\b/i.test(input.prompt));
    const ordinaryIncomeDeclined = ordinaryIncomeFlow && /^\s*(?:no|nope|nah)\b/i.test(input.prompt);
    const debtTransactionQuestion = /\bsay ["“]add it to transactions["”]/i.test(lastAssistantFollowup);
    const debtQuestionYes = debtTransactionQuestion && /^\s*(?:yes|yeah|yep|sure|okay|ok|go ahead|add it|record it)\b/i.test(input.prompt);
    const debtQuestionNo = debtTransactionQuestion && /^\s*(?:no|nope|nah)\b/i.test(input.prompt);
    const debtTransactionOptOut = hasClearDebtTransactionOptOut(userMessageText) || debtQuestionNo;
    const debtTransactionRequested = !debtTransactionOptOut && (hasClearDebtTransactionOptIn(userMessageText) || debtQuestionYes);
    const statedDebtIntent = latestExplicitNewDebtIntent(userMessageText);
    const currentDebtIntent = explicitNewDebtIntent(input.prompt);
    const uncertainNewDebt = userMessageText.some(isUncertainNewDebtStatement) && !isConfirmedDebtFollowUp(userMessageText);
    const repaymentContextText = ordinaryIncomeFlow ? input.prompt : userMessageText.join(" ");
    const payerSelection = /\b(?:who paid|which person|which person's|which debt)\b/i.test(lastAssistantFollowup);
    const repaymentMatchText = payerSelection ? input.prompt : repaymentContextText;
    const repaymentFollowup = /\b(?:what amount|how much|who paid|which person|which debt)\b/i.test(lastAssistantFollowup);
    const uncertainRepayment = userMessageText.some((message) => isUnconfirmedIncomingDebtPayment(message) || isUnconfirmedOutgoingDebtPayment(message))
      || repaymentFollowup && isUncertainStatement(input.prompt);
    const incomingRepaymentIntent = hasIncomingDebtRepaymentWording(repaymentContextText) && !uncertainRepayment;
    const outgoingRepaymentIntent = hasOutgoingDebtRepaymentWording(repaymentContextText) && !uncertainRepayment;
    const repaymentIntent = incomingRepaymentIntent || outgoingRepaymentIntent;
    const repaymentDebts = incomingRepaymentIntent ? openOwedToYouDebts : outgoingRepaymentIntent ? openYouOweDebts : [];
    const repaymentNames = repaymentIntent
      ? [...new Set(repaymentDebts.filter((debt) => containsCounterparty(repaymentMatchText, debt.counterparty)).map((debt) => normalizeCounterparty(debt.counterparty)))]
      : [];
    const repaymentCandidates = repaymentNames.length === 1
      ? repaymentDebts.filter((debt) => normalizeCounterparty(debt.counterparty) === repaymentNames[0])
      : [];
    const repaymentNoteMatches = repaymentCandidates.filter((debt) => debt.note && debtNoteMatches(repaymentMatchText, debt.note));
    const repaymentDebt = repaymentNoteMatches.length === 1 ? repaymentNoteMatches[0] : repaymentCandidates[0];
    const accountOrDateClarificationPending = /(?:couldn't find the account|set a default financial account|create a financial account first|what date should i use)/i.test(lastAssistantFollowup);
    const latestRepaymentPrompt = [...history].reverse().find((message) => message.role === "user"
      && (hasIncomingDebtRepaymentWording(message.content) || hasOutgoingDebtRepaymentWording(message.content)));
    const currentAmountFollowup = /\b(?:what amount|how much)\b/i.test(lastAssistantFollowup);
    const statedRepaymentAmount = repaymentAmountFromPrompt(input.prompt)
      ?? (currentAmountFollowup ? bareAmountFromPrompt(input.prompt) : undefined)
      ?? (!hasIncomingDebtRepaymentWording(input.prompt) && !hasOutgoingDebtRepaymentWording(input.prompt) && (accountOrDateClarificationPending || payerSelection) && latestRepaymentPrompt
        ? repaymentAmountFromPrompt(latestRepaymentPrompt.content) : undefined);
    let call = providerCall;
    if (ordinaryIncomeFlow) {
      if (ordinaryIncomeAccepted && ["log_debt", "log_transaction", "record_debt_payment", "record_debt_repayment"].includes(providerCall.name)) {
        const providerCounterparty = typeof providerCall.args.counterparty === "string" ? providerCall.args.counterparty.trim() : "";
        const description = typeof providerCall.args.description === "string" && providerCall.args.description.trim()
          ? providerCall.args.description.trim()
          : providerCounterparty ? `${providerCounterparty} paid me` : "";
        call = { name: "log_transaction", args: { ...providerCall.args, kind: "income", category: "Other income", description } };
      } else if (ordinaryIncomeDeclined) {
        call = { name: "ask_clarification", args: { question: "Okay, I won't record the money as income." } };
      } else if (!ordinaryIncomeAccepted) {
        call = { name: "ask_clarification", args: { question: "Please answer yes if you want me to record this as ordinary income, or no to leave it unrecorded." } };
      }
    } else if (uncertainRepayment && ["log_debt", "log_transaction", "record_debt_payment", "record_debt_repayment"].includes(providerCall.name)) {
      call = { name: "ask_clarification", args: { question: "Was this a completed payment toward an existing debt? Please confirm before I record it." } };
    } else if (repaymentIntent && ["log_debt", "log_transaction", "record_debt_payment", "record_debt_repayment"].includes(providerCall.name)) {
      const providerCounterparty = typeof providerCall.args.counterparty === "string" ? normalizeCounterparty(providerCall.args.counterparty) : "";
      if (repaymentNames.length > 1) {
        call = { name: "ask_clarification", args: { question: "Which person's open debt should I apply this payment to?" } };
      } else if (!statedRepaymentAmount) {
        call = { name: "ask_clarification", args: { question: "What amount should I use for the repayment?" } };
      } else if (parseProviderAmount(providerCall.args.amount) !== statedRepaymentAmount) {
        call = { name: "ask_clarification", args: { question: `I understood ${formatPHP(statedRepaymentAmount)}. Please re-enter the repayment amount if that is correct.` } };
      } else if (!repaymentDebt && incomingRepaymentIntent) {
        call = { name: "ask_clarification", args: { question: "I couldn't find an open debt matching this payment. Should I record the money as ordinary income instead?" } };
      } else if (!repaymentDebt && outgoingRepaymentIntent) {
        call = openYouOweDebts.length && !hasOutgoingPayeeOrPurpose(repaymentMatchText)
          ? { name: "ask_clarification", args: { question: "Who did you repay? I found open debts you owe and need the person before applying this payment." } }
          : { name: "log_transaction", args: { ...providerCall.args, kind: "expense", description: providerCall.args.description || `Paid ${repaymentMatchText}` } };
      } else if (repaymentDebt && providerCounterparty && providerCounterparty !== normalizeCounterparty(repaymentDebt.counterparty)) {
        call = { name: "ask_clarification", args: { question: `I couldn't confirm which person ${incomingRepaymentIntent ? "paid you" : "you paid"}. Which person's open debt should I update?` } };
      } else if (repaymentDebt && incomingRepaymentIntent) {
        call = { name: "record_debt_payment", args: { ...providerCall.args, counterparty: repaymentDebt.counterparty } };
      } else if (repaymentDebt && outgoingRepaymentIntent) {
        call = { name: "record_debt_repayment", args: { ...providerCall.args, counterparty: repaymentDebt.counterparty } };
      } else if (outgoingRepaymentIntent) {
        call = { name: "log_transaction", args: { ...providerCall.args, kind: "expense", description: providerCall.args.description || `Paid ${repaymentMatchText}` } };
      }
    } else if (currentDebtIntent && ["log_transaction", "record_debt_payment", "record_debt_repayment"].includes(providerCall.name)) {
      call = uncertainNewDebt
        ? { name: "ask_clarification", args: { question: "Is this a confirmed debt? I won't record it until you confirm." } }
        : { name: "log_debt", args: { ...providerCall.args, direction: currentDebtIntent.direction, counterparty: currentDebtIntent.counterparty, recordTransaction: debtTransactionRequested } };
    } else if (debtTransactionQuestion && (debtTransactionRequested || debtTransactionOptOut) && statedDebtIntent) {
      const matchingDebts = store.listDebts(user.id).filter((item) => item.status === "open"
        && item.direction === statedDebtIntent.direction
        && normalizeCounterparty(item.counterparty) === normalizeCounterparty(statedDebtIntent.counterparty));
      call = matchingDebts.length === 1
        ? { name: "log_debt", args: { ...providerCall.args, direction: statedDebtIntent.direction, counterparty: matchingDebts[0].counterparty, amount: providerCall.args.amount ?? String(matchingDebts[0].amountMinor / 100), recordTransaction: debtTransactionRequested } }
        : { name: "ask_clarification", args: { question: matchingDebts.length ? "Which open debt should I update?" : "I couldn't find that open debt. Which debt do you mean?" } };
    }

    let answer: string; let transaction: Transaction | null = null; let debt: Debt | null = null; let undoUntil: string | null = null; let needsFollowup = false;
    if (call.name === "ask_clarification") { answer = safeClarification(call.args.question); needsFollowup = true; }
    else if (call.name === "finance_question") {
      const defaultRange = monthToDateRange();
      const start = typeof call.args.start === "string" && isDateOnly(call.args.start) ? call.args.start : defaultRange.start;
      const end = typeof call.args.end === "string" && isDateOnly(call.args.end) ? call.args.end : todayInManila();
      if (start > end) { answer = "Which date range would you like me to check? Please use a start and end date."; needsFollowup = true; }
      else {
        const category = typeof call.args.category === "string" && call.args.category.trim() ? call.args.category.trim().slice(0, 40) : undefined;
        const facts = store.getFinanceFacts(user.id, start, end, category);
        answer = answerForFacts(facts, input.prompt);
      }
    } else if (call.name === "log_debt") {
      const direction = call.args.direction === "owed_to_you" || call.args.direction === "you_owe" ? call.args.direction : statedDebtIntent?.direction ?? null;
      const amount = typeof call.args.amount === "string" ? call.args.amount : typeof call.args.amount === "number" && Number.isFinite(call.args.amount) ? String(call.args.amount) : "";
      const counterparty = typeof call.args.counterparty === "string" && call.args.counterparty.trim() ? call.args.counterparty.trim() : statedDebtIntent?.counterparty ?? "";
      const dueDate = typeof call.args.dueDate === "string" ? call.args.dueDate.trim() || null : null;
      const note = typeof call.args.note === "string" ? call.args.note.trim() : "";
      const transactionDescription = typeof call.args.description === "string" ? call.args.description.trim() : "";
      const isExistingDebtFollowup = debtTransactionQuestion && !currentDebtIntent;
      if (!counterparty) { answer = "Who is this debt with?"; needsFollowup = true; }
      else if (counterparty.length > 80) { answer = "What shorter name should I use for the other person?"; needsFollowup = true; }
      else if (unclearDebtCounterparty.test(counterparty)) { answer = "Who specifically is this debt with?"; needsFollowup = true; }
      else if (!direction) { answer = "Is this money owed to you, or do you owe the other person?"; needsFollowup = true; }
      else if (!amount && !isExistingDebtFollowup) { answer = "What amount should I use for this debt?"; needsFollowup = true; }
      else if (dueDate && !isDateOnly(dueDate)) { answer = "What due date should I use? Please give it as YYYY-MM-DD."; needsFollowup = true; }
      else if (note.length > 500) { answer = "Please shorten the note to 500 characters or fewer."; needsFollowup = true; }
      else if (uncertainNewDebt) { answer = "I'm not sure whether this is a confirmed debt. Do you want me to record it?"; needsFollowup = true; }
      else if (statedDebtIntent && (statedDebtIntent.direction !== direction || normalizeCounterparty(statedDebtIntent.counterparty) !== normalizeCounterparty(counterparty))) {
        answer = "The proposed debt does not match the person or direction in your request. Which debt should I record?";
        needsFollowup = true;
      }
      else {
        const existingDebts = isExistingDebtFollowup ? store.listDebts(user.id).filter((item) => item.status === "open"
          && item.direction === direction && normalizeCounterparty(item.counterparty) === normalizeCounterparty(counterparty)) : [];
        const amountMinor = amount ? parsePHPToMinor(amount) : existingDebts[0]?.amountMinor;
        if (!amountMinor) { answer = "What amount should I use for this debt?"; needsFollowup = true; }
        else if (isExistingDebtFollowup && existingDebts.length !== 1) {
          answer = existingDebts.length ? "Which open debt should I add the transaction to?" : "I couldn't find that open debt. Which debt do you mean?";
          needsFollowup = true;
        } else if (isExistingDebtFollowup && amount && amountMinor !== existingDebts[0].amountMinor) {
          answer = "That amount doesn't match the open debt in this conversation. Which debt should I use?";
          needsFollowup = true;
        } else if (isExistingDebtFollowup && debtTransactionOptOut) {
          debt = existingDebts[0];
          answer = `Okay, ${debt.counterparty}'s debt stays in Debts only.`;
        } else if (!debtTransactionRequested) {
          debt = isExistingDebtFollowup ? existingDebts[0] : store.createDebt(user.id, { direction, counterparty, amountMinor, dueDate, note });
          answer = direction === "owed_to_you"
            ? `${formatPHP(debt.amountMinor)} is owed to you by ${debt.counterparty}. Added it to Debts only.`
            : `You owe ${debt.counterparty} ${formatPHP(debt.amountMinor)}. Added it to Debts only.`;
          if (!debtTransactionOptOut) {
            answer += ' If you want to record the money movement too, say "add it to Transactions" and tell me what it was for.';
            needsFollowup = true;
          }
        } else {
          const userContext = userMessageText.join(" ");
          const requestedAccount = typeof call.args.account === "string" ? call.args.account.trim() : "";
          const accountHint = accountHintFromMessages(userMessageText, accounts);
          const defaultAccount = accounts.find((candidate) => candidate.isDefault);
          const account = accountHint.mentioned
            ? accountHint.account
            : requestedAccount
              ? /^(default|default account)$/i.test(requestedAccount) ? defaultAccount : accounts.find((candidate) => candidate.name.toLowerCase() === requestedAccount.toLowerCase())
              : defaultAccount;
          const dateHint = priorDateHint(userMessages);
          const requestedDate = typeof call.args.date === "string" ? call.args.date.trim() : "";
          const date = dateHint.date ?? (dateHint.mentioned ? requestedDate && isDateOnly(requestedDate) ? requestedDate : "" : todayInManila());
          const timeHint = timeHintFromMessages(userMessageText);
          const requestedTime = typeof call.args.time === "string" ? call.args.time.trim() : "";
          const time = timeHint && isTime(timeHint) ? timeHint : requestedTime && isTime(requestedTime) ? requestedTime : timeInManila();
          const kind: "expense" | "income" = direction === "owed_to_you" ? "expense" : "income";
          const requestedCategory = typeof call.args.category === "string" ? findCategory(call.args.category, categories, kind) : undefined;
          const categoryHint = latestCategoryHintFromMessages(userMessageText, categories, kind);
          const category = categoryHint.mentioned
            ? categoryHint.category
            : [
              findCategoryInText(userContext, categories, kind),
              requestedCategory?.type === kind ? requestedCategory : undefined,
              guessCategory(`${userContext} ${note} ${transactionDescription}`, categories),
            ].find((candidate): candidate is AssistantCategory => candidate?.type === kind) ?? fallbackCategory(kind, categories);
          const details = transactionDescription || note;
          const description = `${direction === "owed_to_you" ? "Owed by" : "Borrowed from"} ${counterparty}${details ? ` for ${details}` : ""}`;

          if (!accounts.length) { answer = "Create a financial account first; then I can record this money movement."; needsFollowup = true; }
          else if (!account) {
            const invalidName = accountHint.invalidName?.replace(/^my\s+/i, "") || requestedAccount;
            answer = invalidName ? `I couldn't find the account “${invalidName}”. Choose one of your listed accounts: ${accounts.map((item) => item.name).join(", ")}.` : "Set a default financial account in Accounts before recording this money movement.";
            needsFollowup = true;
          }
          else if (!date) { answer = "What date should I use? Please give it as YYYY-MM-DD."; needsFollowup = true; }
          else if (!category && categoryHint.mentioned) { answer = `Which ${kind} category should I use? Choose one from your categories.`; needsFollowup = true; }
          else if (!category) { answer = `Create a ${kind} category before recording this money movement.`; needsFollowup = true; }
          else if (description.length > 180) { answer = "Please shorten the transaction description to 180 characters or fewer."; needsFollowup = true; }
          else {
            const transactionInput = { kind, amountMinor, description, accountId: account.id, categoryId: category.id, date, time, source: "assistant" as const };
            const saved = isExistingDebtFollowup
              ? store.recordDebtAdvanceTransaction(user.id, existingDebts[0].id, transactionInput)
              : store.recordDebtAdvance(user.id, { direction, counterparty, amountMinor, dueDate, note }, transactionInput);
            debt = saved.debt; transaction = saved.transaction;
            answer = `Recorded ${formatPHP(transaction.amountMinor)} as ${kind} for ${debt.counterparty}.\n${transaction.categoryName} · ${transaction.accountName}\n${formatAssistantDate(transaction.date)} ${transaction.time}.\nAdded to Debts and Transactions.`;
          }
        }
      }
    } else if (call.name === "record_debt_payment") {
      const counterparty = typeof call.args.counterparty === "string" ? call.args.counterparty.trim() : "";
      const amount = typeof call.args.amount === "string" ? call.args.amount : typeof call.args.amount === "number" && Number.isFinite(call.args.amount) ? String(call.args.amount) : "";
      if (!counterparty || counterparty.length > 80) { answer = "Who paid you?"; needsFollowup = true; }
      else if (!amount) { answer = safeClarification("What amount should I use for the repayment?"); needsFollowup = true; }
      else {
        const normalizedCounterparty = normalizeCounterparty(counterparty);
        const matchingDebt = repaymentDebt && normalizeCounterparty(repaymentDebt.counterparty) === normalizedCounterparty
          ? repaymentDebt
          : normalizedCounterparty ? store.listDebts(user.id)
          .filter((item) => item.direction === "owed_to_you" && item.status === "open" && normalizeCounterparty(item.counterparty) === normalizedCounterparty)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] : undefined;
        const amountMinor = parsePHPToMinor(amount);
        if (!matchingDebt) {
          answer = `I couldn't find an open debt owed to you by ${counterparty}. Should I record ${formatPHP(amountMinor)} as ordinary income instead?`;
          needsFollowup = true;
        } else if (amountMinor > matchingDebt.amountMinor) {
          answer = `That payment is more than the ${formatPHP(matchingDebt.amountMinor)} still owed by ${matchingDebt.counterparty}. How should I handle it?`;
          needsFollowup = true;
        } else if (!accounts.length) { answer = "Create a financial account first; then I can record this repayment."; needsFollowup = true; }
        else {
          const requestedAccount = typeof call.args.account === "string" ? call.args.account.trim() : "";
          const accountHint = accountHintFromMessages(userMessageText, accounts);
          const defaultAccount = accounts.find((candidate) => candidate.isDefault);
          const account = accountHint.mentioned
            ? accountHint.account
            : requestedAccount
              ? /^(default|default account)$/i.test(requestedAccount) ? defaultAccount : accounts.find((candidate) => candidate.name.toLowerCase() === requestedAccount.toLowerCase())
              : defaultAccount;
          const dateHint = priorDateHint(userMessages);
          const requestedDate = typeof call.args.date === "string" ? call.args.date.trim() : "";
          const date = dateHint.date ?? (dateHint.mentioned ? requestedDate && isDateOnly(requestedDate) ? requestedDate : "" : todayInManila());
          const timeHint = timeHintFromMessages(userMessageText);
          const requestedTime = typeof call.args.time === "string" ? call.args.time.trim() : "";
          const time = timeHint && isTime(timeHint) ? timeHint : requestedTime && isTime(requestedTime) ? requestedTime : timeInManila();
          const categoryHint = latestCategoryHintFromMessages(userMessageText, categories, "income");
          const requestedCategory = typeof call.args.category === "string" ? findCategory(call.args.category, categories, "income") : undefined;
          const category = categoryHint.mentioned ? categoryHint.category : requestedCategory ?? fallbackCategory("income", categories);
          if (!account) {
            const invalidName = accountHint.invalidName?.replace(/^my\s+/i, "") || requestedAccount;
            answer = invalidName ? `I couldn't find the account “${invalidName}”. Choose one of your listed accounts: ${accounts.map((item) => item.name).join(", ")}.` : "Set a default financial account in Accounts before recording this repayment.";
            needsFollowup = true;
          }
          else if (!date) { answer = "What date should I use? Please give the date as YYYY-MM-DD."; needsFollowup = true; }
          else if (!category && (categoryHint.mentioned || typeof call.args.category === "string")) { answer = "Which income category should I use? Choose one from your categories."; needsFollowup = true; }
          else if (!category) { answer = "Create an income category before recording this repayment."; needsFollowup = true; }
          else {
            const description = typeof call.args.description === "string" && call.args.description.trim()
              ? call.args.description.trim().slice(0, 180)
              : `${matchingDebt.counterparty} paid me`;
            const saved = store.recordDebtPayment(user.id, matchingDebt.id, {
              kind: "income", amountMinor, description, accountId: account.id, categoryId: category.id, date, time, source: "assistant",
            });
            transaction = saved.transaction; debt = saved.debt;
            const debtStatus = debt.status === "settled" ? "The debt is settled." : `${formatPHP(debt.amountMinor)} remains owed to you.`;
            answer = `Saved ${formatPHP(transaction.amountMinor)} from ${matchingDebt.counterparty}.\n${transaction.categoryName} · ${transaction.accountName}\n${formatAssistantDate(transaction.date)} ${transaction.time}.\n${debtStatus}`;
          }
        }
      }
    } else if (call.name === "record_debt_repayment") {
      const counterparty = typeof call.args.counterparty === "string" ? call.args.counterparty.trim() : "";
      const amount = typeof call.args.amount === "string" ? call.args.amount : typeof call.args.amount === "number" && Number.isFinite(call.args.amount) ? String(call.args.amount) : "";
      if (!outgoingRepaymentIntent) { answer = "Tell me who you paid and how much before I update a debt."; needsFollowup = true; }
      else if (!counterparty || counterparty.length > 80) { answer = "Who did you pay?"; needsFollowup = true; }
      else if (!amount) { answer = safeClarification("What amount did you pay?"); needsFollowup = true; }
      else if (!repaymentDebt || normalizeCounterparty(repaymentDebt.counterparty) !== normalizeCounterparty(counterparty)) {
        answer = `I couldn't find an open debt you owe to ${counterparty}. I can record this as an ordinary expense.`;
        needsFollowup = true;
      } else {
        const amountMinor = parsePHPToMinor(amount);
        const requestedAccount = typeof call.args.account === "string" ? call.args.account.trim() : "";
        const accountHint = accountHintFromMessages(userMessageText, accounts);
        const defaultAccount = accounts.find((candidate) => candidate.isDefault);
        const account = accountHint.mentioned
          ? accountHint.account
          : requestedAccount
            ? /^(default|default account)$/i.test(requestedAccount) ? defaultAccount : accounts.find((candidate) => candidate.name.toLowerCase() === requestedAccount.toLowerCase())
            : defaultAccount;
        const dateHint = priorDateHint(userMessages);
        const requestedDate = typeof call.args.date === "string" ? call.args.date.trim() : "";
        const date = dateHint.date ?? (dateHint.mentioned ? requestedDate && isDateOnly(requestedDate) ? requestedDate : "" : todayInManila());
        const timeHint = timeHintFromMessages(userMessageText);
        const requestedTime = typeof call.args.time === "string" ? call.args.time.trim() : "";
        const time = timeHint && isTime(timeHint) ? timeHint : requestedTime && isTime(requestedTime) ? requestedTime : timeInManila();
        const categoryHint = latestCategoryHintFromMessages(userMessageText, categories, "expense");
        const requestedCategory = typeof call.args.category === "string" ? findCategory(call.args.category, categories, "expense") : undefined;
        const category = categoryHint.mentioned ? categoryHint.category : requestedCategory ?? fallbackCategory("expense", categories);
        if (amountMinor > repaymentDebt.amountMinor) { answer = `That payment is more than the ${formatPHP(repaymentDebt.amountMinor)} you still owe ${repaymentDebt.counterparty}. How should I handle it?`; needsFollowup = true; }
        else if (!accounts.length) { answer = "Create a financial account first; then I can record this repayment."; needsFollowup = true; }
        else if (!account) {
          const invalidName = accountHint.invalidName?.replace(/^my\s+/i, "") || requestedAccount;
          answer = invalidName ? `I couldn't find the account “${invalidName}”. Choose one of your listed accounts: ${accounts.map((item) => item.name).join(", ")}.` : "Set a default financial account in Accounts before recording this repayment.";
          needsFollowup = true;
        }
        else if (!date) { answer = "What date should I use? Please give the date as YYYY-MM-DD."; needsFollowup = true; }
        else if (!category && (categoryHint.mentioned || typeof call.args.category === "string")) { answer = "Which expense category should I use? Choose one from your categories."; needsFollowup = true; }
        else if (!category) { answer = "Create an expense category before recording this repayment."; needsFollowup = true; }
        else {
          const description = typeof call.args.description === "string" && call.args.description.trim()
            ? call.args.description.trim().slice(0, 180)
            : `Paid ${repaymentDebt.counterparty}`;
          const saved = store.recordDebtRepayment(user.id, repaymentDebt.id, {
            kind: "expense", amountMinor, description, accountId: account.id, categoryId: category.id, date, time, source: "assistant",
          });
          transaction = saved.transaction; debt = saved.debt;
          const debtStatus = debt.status === "settled" ? "The debt is settled." : `${formatPHP(debt.amountMinor)} remains owed to ${debt.counterparty}.`;
          answer = `Saved ${formatPHP(transaction.amountMinor)} paid to ${repaymentDebt.counterparty}.\n${transaction.categoryName} · ${transaction.accountName}\n${formatAssistantDate(transaction.date)} ${transaction.time}.\n${debtStatus}`;
        }
      }
    } else if (call.name === "log_transaction") {
      const kindHint = call.args.kind === "income" || call.args.kind === "expense" ? call.args.kind : null;
      const amount = typeof call.args.amount === "string" ? call.args.amount : typeof call.args.amount === "number" && Number.isFinite(call.args.amount) ? String(call.args.amount) : "";
      const description = typeof call.args.description === "string" ? call.args.description.trim().replace(/\p{L}/u, (letter) => letter.toUpperCase()).slice(0, 180) : "";
      if (!amount) { answer = safeClarification("What amount should I use?"); needsFollowup = true; }
      else if (!accounts.length) { answer = "Create a financial account first; then I can record this transaction."; needsFollowup = true; }
      else {
        const userContext = userMessageText.join(" ");
        const requestedAccount = typeof call.args.account === "string" ? call.args.account.trim() : "";
        const accountHint = accountHintFromMessages(userMessageText, accounts);
        const defaultAccount = accounts.find((candidate) => candidate.isDefault);
        const account = accountHint.mentioned
          ? accountHint.account
          : requestedAccount
            ? /^(default|default account)$/i.test(requestedAccount) ? defaultAccount : accounts.find((candidate) => candidate.name.toLowerCase() === requestedAccount.toLowerCase())
            : defaultAccount;
        const dateHint = priorDateHint(userMessages);
        const requestedDate = typeof call.args.date === "string" ? call.args.date.trim() : "";
        const date = dateHint.date ?? (dateHint.mentioned ? requestedDate && isDateOnly(requestedDate) ? requestedDate : "" : todayInManila());
        const timeHint = timeHintFromMessages(userMessageText);
        const time = timeHint && isTime(timeHint) ? timeHint : timeInManila();
        const explicitKind = ordinaryIncomeAccepted ? "income" : outgoingRepaymentIntent ? "expense" : explicitTransactionKind(userContext);
        const promptCategory = findCategoryInText(userContext, categories, explicitKind ?? kindHint ?? undefined);
        const promptCategoryAmbiguous = promptCategory === null;
        const providerPreferredType = explicitKind ?? (!promptCategoryAmbiguous && !promptCategory ? kindHint ?? undefined : undefined);
        const requestedCategoryHint = typeof call.args.category === "string"
          ? findCategory(call.args.category, categories, providerPreferredType)
          : undefined;
        const requestedCategory = requestedCategoryHint?.type === providerPreferredType || !providerPreferredType ? requestedCategoryHint : undefined;
        const categoryText = `${userContext} ${description}`;
        const textCategory = findCategoryInText(categoryText, categories, providerPreferredType);
        const categoryHint = latestCategoryHintFromMessages(userMessageText, categories, providerPreferredType);
        const categoryAmbiguous = promptCategoryAmbiguous || categoryHint.mentioned && !categoryHint.category || requestedCategory === null || textCategory === null;
        const category = categoryHint.mentioned ? categoryHint.category : (promptCategory && promptCategory !== null ? promptCategory : undefined)
          ?? (requestedCategory && requestedCategory !== null ? requestedCategory : undefined)
          ?? (textCategory && textCategory !== null ? textCategory : undefined)
          ?? (!categoryAmbiguous ? guessCategory(categoryText, categories) : undefined);
        const kind = explicitKind ?? category?.type ?? (!categoryAmbiguous ? transactionKind(kindHint, categoryText) : null);
        const resolvedCategory = category ?? (!categoryAmbiguous && kind ? fallbackCategory(kind, categories) : undefined);
        if (!account) {
          const invalidName = accountHint.invalidName?.replace(/^my\s+/i, "") || requestedAccount;
          answer = invalidName ? `I couldn't find the account “${invalidName}”. Choose one of your listed accounts: ${accounts.map((item) => item.name).join(", ")}.` : "Set a default financial account in Accounts before recording a transaction.";
          needsFollowup = true;
        }
        else if (!date) { answer = "What date should I use? Please give the date as YYYY-MM-DD."; needsFollowup = true; }
        else if (!resolvedCategory || !kind) {
          const ambiguousCategory = typeof call.args.category === "string" ? `“${call.args.category.trim()}”` : "That category name";
          answer = categoryAmbiguous ? `${ambiguousCategory} appears under both income and expense. Which category type did you mean?` : "Which category should I use?";
          needsFollowup = true;
        }
        else {
          const amountMinor = parsePHPToMinor(amount);
          const saved = store.createTransaction(user.id, { kind, amountMinor, description, accountId: account.id, categoryId: resolvedCategory.id, date, time, source: "assistant" });
          transaction = saved; undoUntil = saved.undoUntil;
          answer = `Saved ${formatPHP(saved.amountMinor)}${saved.description ? ` for ${saved.description}` : ""}.\n${saved.categoryName} · ${saved.accountName}\n${formatAssistantDate(saved.date)} ${saved.time}.`;
        }
      }
    } else answer = "I couldn't complete that request. Please rephrase it.";

    if (uncertainRepayment) { answer = "I didn't record anything because I couldn't confirm that the payment happened. If it did, tell me who paid and how much."; needsFollowup = false; }
    else if (ordinaryIncomeDeclined) { answer = "Okay, I won't record the money."; needsFollowup = false; }
    store.addMessage(user.id, conversationId, "assistant", answer, transaction?.id, needsFollowup);
    return { conversationId, answer, transaction, undoUntil, debt };
}
