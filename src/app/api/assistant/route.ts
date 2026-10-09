import { z } from "zod";
import { assertSameOrigin, HttpError, requestJson, requireUser, respondError } from "@/lib/api";
import { getStore } from "@/lib/db";
import { todayInManila, isDateOnly, monthToDateRange } from "@/lib/dates";
import { formatPHP, parsePHPToMinor } from "@/lib/money";
import type { Transaction } from "@/lib/store";
import { askProvider, minimalFollowUpContext, providerConfig, providerDisclosureHash } from "@/lib/provider";

const schema = z.object({ prompt: z.string().trim().min(1).max(2000), conversationId: z.string().uuid().optional() });
function answerForFacts(facts: ReturnType<ReturnType<typeof getStore>["getFinanceFacts"]>) {
  const period = `From ${facts.start} to ${facts.end}`;
  if (facts.requestedCategory) return `${period}, recorded spending in ${facts.requestedCategory} was ${formatPHP(facts.categoryAmountMinor ?? 0)}.`;
  const topCategories = facts.byCategory.slice(0, 3).map((item) => `${item.name}: ${formatPHP(item.amountMinor)}`).join(" · ");
  return `${period}, recorded income was ${formatPHP(facts.incomeMinor)} and spending was ${formatPHP(facts.spendingMinor)}.${topCategories ? ` Top spending categories: ${topCategories}.` : " No expenses were recorded in this period."}`;
}
function safeClarification(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 3 || value.length > 240) return "What amount, transaction type, or description should I use?";
  return value.trim();
}
function guessCategory(description: string, categories: { id: string; name: string; type: string }[], kind: string) {
  const text = description.toLowerCase();
  const rules: [RegExp, string][] = [
    [/food|lunch|dinner|breakfast|coffee|restaurant|jollibee|meal|grocer/, "Food"],
    [/bus|train|taxi|grab|jeep|fare|fuel|gasoline/, "Transport"],
    [/rent|mortgage|condo/, "Housing"], [/electric|water|internet|utility/, "Utilities"],
    [/doctor|medicine|pharmacy|clinic|hospital/, "Health"], [/school|tuition|book|course/, "Education"],
    [/movie|concert|game|stream/, "Entertainment"], [/flight|hotel|vacation|travel/, "Travel"], [/salary|payroll|payday/, "Salary"],
  ];
  const name = rules.find(([pattern]) => pattern.test(text))?.[1] ?? (kind === "income" ? "Other income" : "Other");
  return categories.find((category) => category.type === kind && category.name.toLowerCase() === name.toLowerCase()) ?? categories.find((category) => category.type === kind && category.name.toLowerCase() === (kind === "income" ? "other income" : "other"));
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
    store.addMessage(user.id, conversationId, "user", input.prompt);
    const call = await askProvider({ prompt: input.prompt, history });
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
      const kind = call.args.kind === "income" || call.args.kind === "expense" ? call.args.kind : null;
      const amount = typeof call.args.amount === "string" ? call.args.amount : "";
      const description = typeof call.args.description === "string" ? call.args.description.trim().slice(0, 180) : "";
      if (!kind || !amount || !description) { answer = safeClarification("What transaction type, amount, or description should I use?"); needsFollowup = true; }
      else if (!accounts.length) { answer = "Create a financial account first; then I can record this transaction."; needsFollowup = true; }
      else {
        const requestedAccount = typeof call.args.account === "string" ? call.args.account.trim() : "";
        const account = requestedAccount ? accounts.find((candidate) => candidate.name.toLowerCase() === requestedAccount.toLowerCase()) : accounts.find((candidate) => candidate.isDefault);
        const date = typeof call.args.date === "string" && isDateOnly(call.args.date) ? call.args.date : call.args.date === undefined ? todayInManila() : "";
        const guessed = guessCategory(description, categories, kind);
        const requestedCategory = typeof call.args.category === "string" ? categories.find((candidate) => candidate.type === kind && candidate.name.toLowerCase() === call.args.category!.toString().toLowerCase()) : undefined;
        const category = requestedCategory ?? guessed;
        if (!account) { answer = requestedAccount ? `I couldn't find the account “${requestedAccount}”. Choose one of your listed accounts: ${accounts.map((item) => item.name).join(", ")}.` : "Set a default financial account in Accounts before recording a transaction."; needsFollowup = true; }
        else if (!date) { answer = "What date should I use? Please give the date as YYYY-MM-DD."; needsFollowup = true; }
        else if (!category) { answer = "Create an income or expense category first, then I can record this transaction."; needsFollowup = true; }
        else {
          const amountMinor = parsePHPToMinor(amount);
          const saved = store.createTransaction(user.id, { kind, amountMinor, description, accountId: account.id, categoryId: category.id, date, source: "assistant" });
          transaction = saved; undoUntil = saved.undoUntil;
          answer = `Saved ${formatPHP(saved.amountMinor)} for ${saved.description} in ${saved.categoryName} · ${saved.accountName} · ${saved.date}.`;
        }
      }
    } else answer = "I couldn't complete that request. Please rephrase it.";

    store.addMessage(user.id, conversationId, "assistant", answer, transaction?.id, needsFollowup);
    return Response.json({ conversationId, answer, transaction, undoUntil });
  } catch (error) { return respondError(error); }
}
