import { z } from "zod";
import { assertSameOrigin, HttpError, requestJson, requireUser, respondError } from "@/lib/api";
import { getStore } from "@/lib/db";
import { todayInManila, timeInManila, isDateOnly, isTime, monthToDateRange } from "@/lib/dates";
import { formatPHP, parsePHPToMinor } from "@/lib/money";
import type { Account, Transaction } from "@/lib/store";
import { askProvider, minimalFollowUpContext, providerConfig, providerDisclosureHash } from "@/lib/provider";

const schema = z.object({ prompt: z.string().trim().min(1).max(2000), conversationId: z.string().uuid().optional() });
function answerForFacts(facts: ReturnType<ReturnType<typeof getStore>["getFinanceFacts"]>) {
  const period = `From ${facts.start} to ${facts.end}`;
  if (facts.requestedCategory) return `${period}, recorded spending in ${facts.requestedCategory} was ${formatPHP(facts.categoryAmountMinor ?? 0)}.`;
  const topCategories = facts.byCategory.slice(0, 3).map((item) => `${item.name}: ${formatPHP(item.amountMinor)}`).join(" · ");
  return `${period}, recorded income was ${formatPHP(facts.incomeMinor)} and spending was ${formatPHP(facts.spendingMinor)}.${topCategories ? ` Top spending categories: ${topCategories}.` : " No expenses were recorded in this period."}`;
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
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function categoryNameMatches(name: string, categories: AssistantCategory[]): AssistantCategory[] {
  const exact = categories.filter((category) => category.name.toLowerCase() === name.trim().toLowerCase());
  if (exact.length) return exact;
  const normalizedName = normalizeCategoryName(name);
  return categories.filter((category) => normalizeCategoryName(category.name) === normalizedName);
}
function findCategory(name: string, categories: AssistantCategory[], preferredType?: AssistantCategory["type"]): AssistantCategory | null | undefined {
  const matches = categoryNameMatches(name, categories);
  if (matches.length === 1) return matches[0];
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
  if (longestMatches.length === 1) return longestMatches[0];
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
function accountHintFromMessages(messages: string[], accounts: Account[]): { account?: Account; mentioned: boolean } {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (/\b(?:use|choose|select|set|switch(?:\s+to)?|change\s+to)\s+(?:my\s+)?default(?:\s+account)?\b/i.test(messages[index])) return { mentioned: true };
    const account = accountMention(messages[index], accounts);
    if (account) return { account, mentioned: true };
  }
  return { mentioned: false };
}
function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}
function dateHintFromMessage(message: string, referenceDate: Date): { date?: string; mentioned: boolean } {
  const rawIsoDates = [...message.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map(([date]) => date);
  if (rawIsoDates.some((date) => !isDateOnly(date))) return { mentioned: true };
  const isoDates = rawIsoDates.filter(isDateOnly);
  if (isoDates.length === 1) return { date: isoDates[0], mentioned: true };
  if (isoDates.length > 1) return { mentioned: true };
  const relativeDates = [...message.matchAll(/\b(today|yesterday|tomorrow)\b/gi)].map(([, date]) => date.toLowerCase());
  if (relativeDates.length) {
    const uniqueDates = [...new Set(relativeDates)];
    if (uniqueDates.length !== 1) return { mentioned: true };
    const offset = uniqueDates[0] === "yesterday" ? -1 : uniqueDates[0] === "tomorrow" ? 1 : 0;
    return { date: shiftDate(todayInManila(referenceDate), offset), mentioned: true };
  }
  return { mentioned: /\b(?:date|last\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month)|next\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month)|this\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week)|on\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)\b/i.test(message) };
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
    const matches = [...messages[index].matchAll(/\b(?:(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*([ap])\.?m\.?|([01]?\d|2[0-3]):([0-5]\d))\b/gi)];
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

export async function POST(request: Request) {
  try {
    assertSameOrigin(request); const user = await requireUser(); const store = getStore();
    if (!store.getAssistantOptIn(user.id, providerDisclosureHash() ?? undefined)) throw new HttpError(403, "Enable the assistant in Settings after reviewing the current provider disclosure.");
    if (!providerConfig()) throw new HttpError(503, "The Codex-LB provider and privacy disclosure are not fully configured.");
    const input = await requestJson(request, schema);
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
    const directCapture = history.length ? null : directCategoryCapture(input.prompt, categories);
    const providerCall = await askProvider({ prompt: input.prompt, history, categories });
    const call = directCapture ?? providerCall;
    if (!call) throw new Error("Assistant provider returned no action.");

    let answer: string; let transaction: Transaction | null = null; let undoUntil: string | null = null; let needsFollowup = false;
    if (call.name === "ask_clarification") { answer = safeClarification(call.args.question); needsFollowup = true; }
    else if (call.name === "finance_question") {
      const defaultRange = monthToDateRange();
      const start = typeof call.args.start === "string" && isDateOnly(call.args.start) ? call.args.start : defaultRange.start;
      const end = typeof call.args.end === "string" && isDateOnly(call.args.end) ? call.args.end : todayInManila();
      if (start > end) { answer = "Which date range would you like me to check? Please use a start and end date."; needsFollowup = true; }
      else {
        const category = typeof call.args.category === "string" && call.args.category.trim() ? call.args.category.trim().slice(0, 40) : undefined;
        const facts = store.getFinanceFacts(user.id, start, end, category);
        answer = answerForFacts(facts);
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
        const account = requestedAccount
          ? /^(default|default account)$/i.test(requestedAccount) ? defaultAccount : accounts.find((candidate) => candidate.name.toLowerCase() === requestedAccount.toLowerCase())
          : accountHint.mentioned ? accountHint.account ?? defaultAccount : defaultAccount;
        const dateHint = priorDateHint(userMessages);
        const requestedDate = typeof call.args.date === "string" ? call.args.date.trim() : "";
        const date = dateHint.date ?? (dateHint.mentioned ? requestedDate && isDateOnly(requestedDate) ? requestedDate : "" : todayInManila());
        const timeHint = timeHintFromMessages(userMessageText);
        const time = timeHint && isTime(timeHint) ? timeHint : timeInManila();
        const explicitKind = explicitTransactionKind(userContext);
        const promptCategory = findCategoryInText(userContext, categories, explicitKind);
        const promptCategoryAmbiguous = promptCategory === null;
        const providerPreferredType = explicitKind ?? (!promptCategoryAmbiguous && !promptCategory ? kindHint ?? undefined : undefined);
        const requestedCategory = typeof call.args.category === "string"
          ? findCategory(call.args.category, categories, providerPreferredType)
          : undefined;
        const categoryText = `${userContext} ${description}`;
        const textCategory = findCategoryInText(categoryText, categories, providerPreferredType);
        const categoryAmbiguous = promptCategoryAmbiguous || requestedCategory === null || textCategory === null;
        const category = (promptCategory && promptCategory !== null ? promptCategory : undefined)
          ?? (requestedCategory && requestedCategory !== null ? requestedCategory : undefined)
          ?? (textCategory && textCategory !== null ? textCategory : undefined)
          ?? (!categoryAmbiguous ? guessCategory(categoryText, categories) : undefined);
        const kind = category?.type ?? (!categoryAmbiguous ? transactionKind(kindHint, categoryText) : null);
        const resolvedCategory = category ?? (!categoryAmbiguous && kind ? fallbackCategory(kind, categories) : undefined);
        if (!account) { answer = requestedAccount ? `I couldn't find the account “${requestedAccount}”. Choose one of your listed accounts: ${accounts.map((item) => item.name).join(", ")}.` : "Set a default financial account in Accounts before recording a transaction."; needsFollowup = true; }
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
          answer = `Saved ${formatPHP(saved.amountMinor)}${saved.description ? ` for ${saved.description}` : ""} in ${saved.categoryName} · ${saved.accountName} · ${saved.date} ${saved.time}.`;
        }
      }
    } else answer = "I couldn't complete that request. Please rephrase it.";

    store.addMessage(user.id, conversationId, "assistant", answer, transaction?.id, needsFollowup);
    return Response.json({ conversationId, answer, transaction, undoUntil });
  } catch (error) { return respondError(error); }
}
