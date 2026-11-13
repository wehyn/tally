// Pure rules for one Ask Tally conversation turn. assistant.ts and store.ts ask this module for
// each decision and persist the answer; they never re-derive these rules inline.

import { isBillFollowup, type Asks, type FollowupKind, type ReplyData } from "../assistant-followup";
import { normalizeCounterparty } from "../counterparty";
import { formatPHP, parsePHPToMinor } from "../money";

// An assistant-saved transaction can be undone for this long after it is saved.
export const UNDO_WINDOW_MS = 10_000;

export function undoUntilFor(source: "manual" | "assistant", nowMs: number): string | null {
  return source === "assistant" ? new Date(nowMs + UNDO_WINDOW_MS).toISOString() : null;
}

export function canUndo(row: { source: "manual" | "assistant"; undoUntil: string | null }, nowMs: number): boolean {
  return row.source === "assistant" && row.undoUntil !== null && nowMs <= Date.parse(row.undoUntil);
}

// Consent: "on" only while the opt-in matches the current provider disclosure. A disclosure change
// turns "on" into "stale" without any write. Writes need "on" both before and after the model call.
export type ConsentState = "off" | "on" | "stale";

export function canWrite(consent: ConsentState): boolean {
  return consent === "on";
}

// A turn reads the stored question before the model call and stores nothing until it commits, so by then
// another request may have answered or cancelled that question. The turn may commit only while the
// conversation still ends at the message it read (null for a chat with none). A refused turn stores nothing.
export function turnMayCommit(readLastMessageId: string | null, currentLastMessageId: string | null): boolean {
  return readLastMessageId === currentLastMessageId;
}

// Pending follow-up: what a new prompt does to the question the last reply asked. The only way to drop
// a question is to say so: a prompt that, trimmed, case-folded and stripped of punctuation, equals one of
// these phrases. Everything else is an "answer", which keeps the pending context and leaves the reply to the
// existing handling, and that asks again and writes nothing when the reply is not a usable answer. Guessing
// from free text that a reply is a new request was abandoned: a wrong guess drops the context and the guards
// that read it and writes money to the wrong place, while a wrong "answer" only asks again. "no" is not here:
// it already answers a yes or no question.
export type PendingOutcome = "none" | "answer" | "cancel";

const CANCEL_PHRASES: ReadonlySet<string> = new Set([
  "cancel", "never mind", "nevermind", "skip", "forget it", "stop", "ayoko na", "wag na", "huwag na", "di na",
]);

// A whole message, trimmed, case-folded and stripped of punctuation, so a phrase set matches it exactly.
function normalizedPhrase(prompt: string): string {
  return prompt.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function pendingOutcome(pending: FollowupKind | null, prompt: string): PendingOutcome {
  if (pending === null) return "none";
  return CANCEL_PHRASES.has(normalizedPhrase(prompt)) ? "cancel" : "answer";
}

// The one way to say no to the ordinary income question: a message that, normalized, is exactly one of these. A
// message that only starts with "no" is not a decline, for the reason a cancel is an exact phrase: guessing a refusal
// from free text drops what the user said. A decline only ends the question and never authorizes anything. Any
// other reply that is not a confirmation asks again (ordinaryIncomeTurn), "not now" included: it defers instead of
// refusing, so the user can say cancel.
const INCOME_DECLINE_PHRASES: ReadonlySet<string> = new Set([
  "no", "nope", "nah", "no thanks", "no thank you", "hindi", "ayoko",
]);

export function isOrdinaryIncomeDecline(prompt: string): boolean {
  return INCOME_DECLINE_PHRASES.has(normalizedPhrase(prompt));
}

// A yes to the ordinary income question: the message leads with an affirmative word. It is the one recognizer, the same
// one a plain "yes" to the question passes, and it reads only the message being answered.
const INCOME_CONFIRMATION = /^\s*(?:yes|yeah|yep|sure|okay|ok|go ahead|record it|record that)\b/i;

export function isIncomeConfirmation(prompt: string): boolean {
  return INCOME_CONFIRMATION.test(prompt);
}

// What one turn does while the ordinary income flow is open (the question is pending, or its account or date
// clarification is). "write": the message is itself a confirmation, so the provider's write may run as income.
// "decline": an exact decline ends the question and writes nothing. "read": a read-only call is answered by the
// ordinary read-only rules and leaves the question pending. "askAgain": anything else writes nothing and asks the
// income question again with the way out. No earlier message can authorize a write. A yes said in an earlier turn, which
// only led to a question about the account or date, is not carried forward, so there is no refusal wording to detect:
// every message that is not a confirmation, however it is worded, fails to write. The user confirms again, and
// "yes, Wallet" does that in one message.
export type OrdinaryIncomeTurn = "write" | "decline" | "read" | "askAgain";

export function ordinaryIncomeTurn(prompt: string, call: TurnCall): OrdinaryIncomeTurn {
  if (isOrdinaryIncomeDecline(prompt)) return "decline";
  if (isIncomeConfirmation(prompt)) return "write";
  return call === "read" ? "read" : "askAgain";
}

// An income write never carries an account across turns. It uses one only from the current reply, or, when the reply
// names none, from the provider, a cue word or the default exactly as any other write does. The one safety rule: when
// an earlier confirmation of the same income question chose an account and this reply names none, the code cannot
// tell whether the choice still stands, so it writes nothing and asks again, echoing the earlier choice.
//
// "The same income question" is the chain a pure walk over the open run finds, decided by the kind each reply stored,
// never by what the user's words say. A chain starts at an ordinary_income question that opened a payment, goes on
// through the account, date and amount clarifications it led to, and its re-asks, and ends at any other turn: a
// repayment_payer, repayment_amount or other kind of reply, or a new ordinary_income question (the user's message had
// payment wording, so the code ran the repayment path, not the income flow). A reply that answered another kind of
// question, such as "yes, Maya" picking a payer, is therefore never in the chain.
type IncomeChainTurn = RunMessage & { content: string };

export function incomeChainAnswers(run: readonly IncomeChainTurn[], opensPayment: (userMessage: string) => boolean): string[] {
  let answers: string[] = [];
  let open = false;
  for (let index = 0; index < run.length; index++) {
    const message = run[index];
    const reply = run[index + 1];
    if (message.role !== "user" || reply?.role !== "assistant") continue;
    // A quiet reply handled its own request and left the question pending: the message says nothing about it.
    if (isQuietReply(reply)) continue;
    const inChain = open && !opensPayment(message.content);
    if (reply.followup === "ordinary_income") {
      if (!inChain) answers = [];
      open = true;
    } else if (inChain && (reply.followup === "account_or_date" || reply.followup === "clarification")) {
      answers.push(message.content);
    } else {
      answers = [];
      open = false;
    }
  }
  return open ? answers : [];
}

// The account the chain's earlier confirmations chose, the latest one that names one. Only a message that is itself an
// income confirmation counts, so a bare "Wallet" or a refusal naming an account never does. `nameIn` reads the account
// out of one confirmation and is the caller's, because it knows the accounts.
export function incomeChainAccount<T>(answers: readonly string[], nameIn: (confirmation: string) => T | undefined): T | undefined {
  for (let index = answers.length - 1; index >= 0; index--) {
    if (!isIncomeConfirmation(answers[index])) continue;
    const named = nameIn(answers[index]);
    if (named !== undefined) return named;
  }
  return undefined;
}

// "account": the current reply chose this account. "ask": it chose none while an earlier confirmation of the chain
// chose `earlier`, so write nothing and ask again. "none": no account was chosen by a confirmation, and the write
// uses what any other write uses (the account the reply names by a cue word, the provider's, the default). When the
// current reply names an account by a cue word or names one that does not exist, that is its own choice, which the
// ordinary account reading honors or asks about, so an earlier choice never overrides it and never answers for it.
export type IncomeAccountChoice<T> = { use: "account"; account: T } | { use: "ask"; earlier: T } | { use: "none" };

export function incomeAccountChoice<T>(current: { confirmed: T | undefined; names: boolean }, earlier: T | undefined): IncomeAccountChoice<T> {
  if (current.confirmed !== undefined) return { use: "account", account: current.confirmed };
  if (current.names || earlier === undefined) return { use: "none" };
  return { use: "ask", earlier };
}

// How to confirm after the code asks for the account, date or answer that income the user just said yes to still needs.
// The yes is not carried over, so the next message says it again, with the answer in the same message.
export function incomeConfirmHint(asked: "account_or_date" | "clarification", account?: string): string {
  if (asked === "account_or_date" && account) return `Reply with yes and the account, like "yes, ${account}", or say cancel.`;
  return "Reply with yes and your answer, or say cancel.";
}

// What a turn that asked no question did. "read" only read the ledger (the debt list, a finance answer),
// "billSaved" saved or updated a bill, and "other" is everything else, such as a completed write.
export type QuietTurn = "read" | "billSaved" | "other";

// The pending question a turn stores with its reply. A turn that asks a question of its own replaces the
// pending one. A turn that only reads is not an answer to the pending question and not a cancel of it, so the
// question stays exactly as it was and the next reply still answers it. A saved bill is an answer to a bill
// question, which it ends, and not to any other, which stays. Every other turn that asks nothing ends it.
export function followupAfterTurn(pending: FollowupKind | null, asked: FollowupKind | null, turn: QuietTurn): FollowupKind | null {
  if (asked) return asked;
  if (turn === "read") return pending;
  if (turn === "billSaved") return isBillFollowup(pending) ? null : pending;
  return null;
}

// The longest open follow-up run, in messages, that a turn may extend. The whole run reaches the model and the
// local reading of it, and no message is ever left out, because choosing which ones to keep was a guess that
// kept dropping the statement or the correction a later answer depends on. A run that reaches the limit ends
// its question instead.
export const MAX_OPEN_RUN_MESSAGES = 24;

// A turn that would extend a run already at the limit ends the question. It calls no model and writes nothing.
// An exact cancel still gets its own reply, and with nothing pending there is no run.
export function runExpired(runLength: number, outcome: PendingOutcome): boolean {
  return outcome === "answer" && runLength >= MAX_OPEN_RUN_MESSAGES;
}

// A message of the open run, as stored. readOnly marks a reply that only read the ledger.
export type RunMessage = { role: "user" | "assistant"; followup?: FollowupKind | null; billId?: string | null; readOnly?: boolean; data?: ReplyData | null };

// A reply is quiet when it handled its own request and left the pending question pending: a bill saved without
// a question (the reply carries the bill) or a read-only answer. The user message it answered says nothing about
// the pending question.
export function isQuietReply(reply: RunMessage): boolean {
  return reply.role === "assistant" && !!reply.followup && (!!reply.billId || !!reply.readOnly);
}

// A reply that holds a statement behind the separate-entry question (ReplyData.separate). The message it answered, and the message that
// answers it ("yes, separate", "that debt", anything else), are not words of the debt flow: they feed no hint, no filler and no
// statement, so a held wording never changes what a later answer may say or where money goes. The reply itself is the question the
// run waits on, as any question is.
export function holdsSeparate(reply: RunMessage | undefined): boolean {
  return reply?.role === "assistant" && !!reply.data?.separate;
}
// After "yes, separate" the confirmed statement starts a NEW run. The held statement's own words, which the hold stored, lead it, and the
// replies after the confirmation follow; the open debt flow, the held message's own turn, the question and the confirmation are left out, so
// no hint, guard or filler of the debt flow reaches the separate entry's later answers. A run without a confirmed separate entry is
// returned as it is.
export function confirmedSeparateRun<T extends RunMessage & { content: string; createdAt?: string }>(run: readonly T[]): readonly T[] {
  for (let index = run.length - 1; index >= 1; index--) {
    const hold = run[index - 1].role === "assistant" ? run[index - 1].data?.separate : undefined;
    if (run[index].role !== "user" || !hold || separateEntryChoice(run[index].content) !== "separate") continue;
    const held = { role: "user", content: hold.statement, createdAt: hold.at, followup: null } as unknown as T;
    return [held, ...run.slice(index + 1)];
  }
  return run;
}

// Whether the user message at `index` belongs to the pending question's own words: it is not answered by a quiet or holding reply and
// does not answer a holding reply.
function isOwnMessage(run: readonly RunMessage[], index: number): boolean {
  if (run[index].role !== "user") return false;
  const reply = index + 1 < run.length ? run[index + 1] : undefined;
  if (reply && (isQuietReply(reply) || holdsSeparate(reply))) return false;
  return !(index > 0 && holdsSeparate(run[index - 1]));
}

// What the code reads from the user's words, and which messages of the open run it may read.
// A hint overrides a field the model chose (account, date, time, category, amount, payer, bill details, the debt
// the user named, an opt-in) and so decides where money goes. It reads only the messages that belong to the
// pending question, or a bill or a finance question answered in between would move a repayment.
// A guard can only refuse or ask (uncertain or negated wording, a declined transaction), and it reads the whole
// open run, because a refusal said anywhere in the run must still block a write nobody confirmed afterwards.
export type UserTextUse = "hint" | "guard";

// The user messages of the open run that belong to the pending question: the statement that started it and the
// answers, re-asks and corrections addressed to it. The model still gets the whole run, since it can tell a
// handled turn from the question by its reply.
export function ownUserMessages<T extends RunMessage>(run: readonly T[]): T[] {
  return run.filter((_, index) => isOwnMessage(run, index));
}

// Every user message of the open run, quiet turns included.
export function guardUserMessages<T extends RunMessage>(run: readonly T[]): T[] {
  return run.filter((message) => message.role === "user");
}

export function userMessagesFor<T extends RunMessage>(use: UserTextUse, run: readonly T[]): T[] {
  return use === "hint" ? ownUserMessages(run) : guardUserMessages(run);
}

// A hint that chooses a value (account, date, time, category, an opt-in to Transactions) applies to the statement the
// write is for, never to an earlier different one in the same open run.
//
// The kind of the question pending decides whether a reply continues the statement it asks about. While a question of an
// answerable kind is pending, a reply is its answer whatever its digits, payment wording or number format say: "Actually
// 200", "use BPI 2", "use BPI 1234", "I paid 549" (a bill's amount), "5 October", "3 days ago" and "around 5" all answer, so
// the account, date and time the statement said still apply. A reply starts a new statement only when
//  (a) no question is pending (nothing earlier applies), or
//  (b) it is an explicit restart, which `startsNewStatement` defines by a narrow text test below.
// An unknown reply is an answer, so the failure direction is that an earlier cue is kept; the ask rules and the guards
// still stop a write nobody confirmed. Quiet turns are left out as in `ownUserMessages`: a read or a saved bill is its own
// request and neither feeds a hint nor starts a statement.

// What a reply states, read from its words alone. Account names are the caller's to give, because "BPI 2" holds a digit.
const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const DATES_AND_TIMES: RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}\b/gi,
  /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g,
  new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`, "gi"),
  new RegExp(`\\b(?:the\\s+)?\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTHS})\\b\\.?(?:,?\\s+\\d{4})?`, "gi"),
  /\b\d{1,3}\s+(?:day|days|week|weeks|month|months)\s+(?:ago|from\s+now)\b/gi,
  /\b(?:last|next|this|past)\s+\d{1,3}\s+(?:days?|weeks?|months?)\b/gi,
  /\b\d{1,2}(?::?\d{2})?\s*[ap]\.?m\.?(?!\w)/gi,
  /\b\d{1,2}:\d{2}\b/g,
  /\b(?:at|around|about|by|past|before|after|until|till)\s+\d{1,2}(?:\s*o'?clock)?\b/gi,
  /\b\d{1,2}\s*o'?clock\b/gi,
  /\b\d{1,2}(?:st|nd|rd|th)\b/gi,
];
// Words that make no purpose and name no one: the verbs of a request, the cue words of an account or a date, the
// pronouns and the payment verbs. What is left in a reply is its purpose or its counterparty.
const FILLER_WORDS: ReadonlySet<string> = new Set((
  "i me my we us you it that this the a an to into from in on at of for and or but with via by as is was are be been am do did does not no yes yeah yep sure ok okay "
  + "please just only about around also then so too very more now today yesterday tomorrow ago last next past "
  + "log logged record recorded add added enter entered put make set use using choose select switch change save track note "
  + "paid pay pays paying repaid repay returned return settled spent spend bought got get gave give "
  + "peso pesos php account card default cash total amount actually instead never mind nevermind scratch forget ignore rather oh hey hi hello"
).split(" "));

// The one explicit restart wording: a leading "instead", "actually", "never mind", "scratch that", "forget that" or
// "ignore that" (an "oh" or a "no" may come first), or a trailing "instead". The wording alone restarts nothing: "Maya
// instead" answers an account question and "Actually 200" corrects an amount, so the reply must also state a complete
// transaction, an amount with a purpose or a counterparty.
const RESTART_LEAD = /^\s*(?:(?:oh|no|nope|ok|okay|hmm)[,.\s]+)*(?:instead|actually|never\s*mind|nvm|scratch\s+that|forget\s+(?:that|it)|ignore\s+that)\b/i;
const RESTART_TRAIL = /\binstead\s*[.!]?\s*$/i;
export function hasRestartWording(reply: string): boolean {
  return RESTART_LEAD.test(reply) || RESTART_TRAIL.test(reply);
}

// What a reply says once its dates and times are taken out, and, for the amount test, its account names too: an account
// name may hold the digit ("BPI 2"), so a digit left after it is removed is a stated amount, while a word left before it is
// removed is a purpose or a counterparty that happens to be named like an account ("Maya paid me 200").
function withoutDatesAndTimes(reply: string): string {
  let text = reply;
  for (const pattern of DATES_AND_TIMES) text = text.replace(pattern, " ");
  return text;
}
function withoutAccountNames(text: string, accountNames: readonly string[]): string {
  for (const name of [...accountNames].sort((a, b) => b.length - a.length)) {
    const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    if (escaped) text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "giu"), " ");
  }
  return text;
}
function purposeWordsIn(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\s'’-]+/gu, " ").split(/\s+/).filter((word) => word.length > 1 && !FILLER_WORDS.has(word));
}

// The words of a reply that name a purpose or a counterparty, when the reply also holds an amount that is no date, no time
// and no part of an account's name. Empty when it holds no amount or no such word, which is every answer to an account, a
// date, a time, a payer, a yes or a bare amount. A reply that starts with an account or date command ("use", "choose",
// "switch to") answers, whatever follows.
const ANSWER_COMMAND = /^\s*(?:use|using|choose|select|switch|change|set|make\s+it|put\s+it)\b/i;
function statedPurposeWords(reply: string, accountNames: readonly string[]): string[] {
  if (ANSWER_COMMAND.test(reply)) return [];
  const text = withoutAccountNames(withoutDatesAndTimes(reply), accountNames);
  return /\d/.test(text) ? purposeWordsIn(text) : [];
}

// The words that could make a reply a different transaction stated in full, read without the two exemptions above: an
// account's name left in place (a payer or a purpose may be named like an account) and no command lead. Empty when the
// reply states no amount of its own.
function possiblePurposeWords(reply: string, accountNames: readonly string[]): string[] {
  const dated = withoutDatesAndTimes(reply);
  return /\d/.test(withoutAccountNames(dated, accountNames)) ? purposeWordsIn(dated) : [];
}

// Kinds whose reply may be a different transaction stated in full ("Log salary 5000" after "What amount?"): the question
// expects a small answer (an account, a date, an amount, a yes), so a message that states its own amount and its own
// purpose or counterparty is not one. The other kinds always take the reply as their answer unless it carries restart wording.
const MAY_RESTART_WITHOUT_WORDING: ReadonlySet<FollowupKind> = new Set(["clarification", "account_or_date", "ordinary_income", "repayment_amount"]);

// What reading a reply under a pending question concluded. `starts` is the verdict, from the narrow text rule below.
// `uncertain` says the reply is shaped like a restart even though the text rule cannot be trusted to read it: it states an
// amount and a purpose or counterparty word and either carries restart wording, or comes under a kind that allows a
// restart without wording with a word the statement did not name, and the rule's own exemptions (an account name that is
// also a payer, a command lead) did not clear it. A reply that is pure answer by its kind ("use BPI 2", "Coffee 120" under
// the coffee's clarification, "Actually 200", every reply under a bill or opt-in question without restart wording) is
// never uncertain. The caller never trusts an uncertain verdict when it would change what the write says (ambiguousHints).
export type StatementReading = { starts: boolean; uncertain: boolean };

// Whether `reply`, sent while `pending` was asked about `statement` (the user messages of the statement so far), starts a
// new statement. A restart states a complete transaction, an amount with a purpose or a counterparty, and either carries
// the restart wording or comes under one of the kinds in MAY_RESTART_WITHOUT_WORDING with a purpose or a counterparty the
// statement did not already name ("Coffee 120" under the coffee's amount question answers it, "Ben paid me 200" under
// Zed's income question does not).
export function readStatementStart(pending: FollowupKind | null, reply: string, statement: readonly string[], accountNames: readonly string[]): StatementReading {
  if (pending === null) return { starts: true, uncertain: false };
  const restartWording = hasRestartWording(reply);
  const known = new Set(statement.join(" ").toLowerCase().replace(/[^\p{L}\s'’-]+/gu, " ").split(/\s+/));
  const possible = possiblePurposeWords(reply, accountNames);
  const mayRestart = !ANSWER_COMMAND.test(reply) || restartWording;
  const uncertain = possible.length > 0 && mayRestart && (restartWording || MAY_RESTART_WITHOUT_WORDING.has(pending) && possible.some((word) => !known.has(word)));
  const words = statedPurposeWords(reply, accountNames);
  if (!words.length) return { starts: false, uncertain };
  if (restartWording) return { starts: true, uncertain };
  if (!MAY_RESTART_WITHOUT_WORDING.has(pending)) return { starts: false, uncertain };
  return { starts: words.some((word) => !known.has(word)), uncertain };
}

export function startsNewStatement(pending: FollowupKind | null, reply: string, statement: readonly string[], accountNames: readonly string[]): boolean {
  return readStatementStart(pending, reply, statement, accountNames).starts;
}

// ANSWER SHAPE. The debt flow records a yes ("add it to Transactions") and links a later turn to the debt it saved. Whether a later
// message may use either is decided by a WHITELIST, never by the wordings that are not answers: a refusal, a restart or a new
// expense can be phrased without end, and every list of them was missed by a new phrasing. A message is an answer to the debt
// flow's question only when, once the filler tokens, the debt's own counterparty and amount and the words the flow's statement
// already used are taken out, it consists only of
//  - an account name the user has (or an account the message names with "<name> account", which the code answers by asking for a
//    listed one),
//  - a date or a time the code's own recognisers read (DATES_AND_TIMES, today, yesterday, tomorrow, a weekday),
//  - the word "transactions", and
//  - the exact choice words: another, that one, the same one, earlier, new one.
// The offer to add the debt to Transactions also asks what the money was for, so its answer may carry a short purpose after "for"
// or "it was" (up to three words, none of them a refusal or a verb). Anything else, a verb phrase or a word the flow never used, is not an answer: it carries no
// consent and no link, and never writes on its own authority: inside an open debt flow the turn asks the separate-entry question (separateEntryDecision).
// `question` is what the pending question asks for: "offer" (the Transactions offer), an `Asks` the question stored, or "detail" for
// a question that stored none (an old row, the model's own question), which keeps the account, date and filler vocabulary.
// The choice words (another, that one, earlier, new one, the same one) are answers only to a question that offers the choice.
export type AnswerQuestion = "offer" | "detail" | Asks;
export type AnswerContext = {
  accountNames: readonly string[];
  // The saved debt's own counterparty and amount, which the answer may repeat.
  counterparty?: string;
  amountMinor?: number;
  // The user messages of the debt flow so far (debtFlowStatement). Their words are filler, except the ones in NEVER_FILLER.
  statement: readonly string[];
  // The names of the user's categories, which a category question's answer may be.
  categoryNames?: readonly string[];
};

// The longest transaction description the store takes, in characters.
export const DESCRIPTION_MAX_LENGTH = 180;

// A description that is too long is shortened by the code, never asked of the user: the user's free text is not an answer to anything. The
// cut is deterministic, at the last word boundary that fits, and applies to the model's own description.
export function shortenAtWord(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max);
  const boundary = /\s/.test(trimmed[max] ?? "") ? max : cut.search(/\s\S*$/);
  const head = (boundary > 0 ? cut.slice(0, boundary) : cut).replace(/[\s,;:.\-–—]+$/u, "");
  return head || cut.trim();
}

const ANSWER_FILLER: ReadonlySet<string> = new Set((
  "use using in into on to the my it please account accounts card default today tomorrow yesterday "
  + "yes yeah yep yup sure ok okay no nope nah thanks thank you it's "
  + "for with from at via by of and a an then also now is was am are "
  + "put choose select pick switch change add record go ahead transactions transaction "
  + "peso pesos php"
).split(" "));

// The choice words. They answer only the duplicate and ambiguity questions (the separate-entry question has its own exact list), so
// "Record another 500 using Wallet today" under an account question is not an answer to it.
const CHOICE_WORDS: ReadonlySet<string> = new Set("another that this one ones earlier new same separate".split(" "));
function offersChoice(question: AnswerQuestion): boolean {
  return question === "duplicate" || question === "ambiguity";
}

// Words that refuse, cancel or reverse. They are never filler, and the flow's own statement cannot make them filler either.
const NEVER_FILLER: ReadonlySet<string> = new Set((
  "don't dont do not never won't wont can't cant cannot skip cancel stop without instead rather forget leave remove delete undo "
  + "ignore scratch actually hindi ayoko wag huwag di maybe perhaps probably guess think might"
).split(" "));

const WEEKDAY_DATES = /\b(?:(?:last|next|this|on|past)\s+(?:mon|tues|wednes|thurs|fri|satur|sun)day|(?:last|next|this)\s+(?:week|month))\b/gi;
const UNKNOWN_ACCOUNT = /\b(?:into|in|to|on|using|use|via|from|with)\s+(?:my\s+)?(?:[\p{L}\p{N}'’.-]+\s+){0,2}[\p{L}\p{N}'’.-]+\s+(?:account|card)\b/giu;
const PURPOSE_INTRO: ReadonlySet<string> = new Set(["for", "was", "it's"]);
const AMOUNT_TOKEN = /(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?![\d,]|\.\d)/g;
// Whether a message states an amount at all, the minimum a new statement needs.
export function statesAmount(message: string): boolean {
  return new RegExp(AMOUNT_TOKEN.source).test(message);
}

function answerTokens(text: string): string[] {
  return text.split(/[^\p{L}\p{N}'’-]+/u).map((token) => token.replace(/^['’-]+|['’-]+$/g, "").replace(/’/g, "'")).filter(Boolean);
}

export function answerShaped(message: string, question: AnswerQuestion, context: AnswerContext): boolean {
  let text = message.normalize("NFC").toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/₱/g, " ");
  // Each question has its own vocabulary. No question takes free text.
  // The separate-entry question is answered by an exact list, nothing else.
  if (question === "separate") return separateEntryChoice(message) !== null;
  // A category is one the user has. "yes, Food" is the same answer.
  if (question === "category") return answerTokens(withoutAccountNames(text, context.categoryNames ?? [])).every((token) => ANSWER_FILLER.has(token));
  text = withoutDatesAndTimes(text).replace(WEEKDAY_DATES, " ");
  text = withoutAccountNames(text, context.accountNames).replace(UNKNOWN_ACCOUNT, " ");
  if (question === "amount") text = text.replace(AMOUNT_TOKEN, " ");
  else if (context.amountMinor !== undefined) {
    text = text.replace(AMOUNT_TOKEN, (token, whole: string, fraction: string | undefined) =>
      Math.round(Number(`${whole.replace(/,/g, "")}.${fraction ?? "0"}`) * 100) === context.amountMinor ? " " : token);
  }
  const choice = offersChoice(question);
  const allowed = new Set<string>(ANSWER_FILLER);
  if (choice) for (const word of CHOICE_WORDS) allowed.add(word);
  for (const word of [...answerTokens((context.counterparty ?? "").toLowerCase()), ...answerTokens(context.statement.join(" ").toLowerCase())]) {
    if (word.length > 1 && !NEVER_FILLER.has(word) && !/\d/.test(word) && (choice || !CHOICE_WORDS.has(word))) allowed.add(word);
  }
  const tokens = answerTokens(text);
  for (let index = 0; index < tokens.length; index++) {
    if (allowed.has(tokens[index])) {
      // The offer asks what the money was for: after "for", "it was" or "it's" up to three words, none of them filler or a refusal
      // word, are the purpose and need not have been said before. The purpose ends at the first filler word.
      if (question === "offer" && PURPOSE_INTRO.has(tokens[index])) {
        let next = index + 1;
        if (tokens[next] === "the" || tokens[next] === "my" || tokens[next] === "a" || tokens[next] === "an") next++;
        let taken = 0;
        while (taken < 3 && next < tokens.length && !NEVER_FILLER.has(tokens[next]) && !/\d/.test(tokens[next])) {
          if (tokens[next] === "and" && taken > 0) { next++; continue; }
          if (allowed.has(tokens[next])) break;
          next++; taken++;
        }
        index = next - 1;
      }
      continue;
    }
    return false;
  }
  return true;
}

// The user messages that belong to a saved debt's flow: the statement that saved it and every answer to a question the flow asked
// about it. A message belongs when the reply right after it carries a debt and is not a quiet turn, so a read or a re-ask in
// between adds no word to the filler.
export function debtFlowStatement<T extends RunMessage & { content: string; debtId?: string | null }>(run: readonly T[]): string[] {
  const messages: string[] = [];
  for (let index = 0; index + 1 < run.length; index++) {
    const reply = run[index + 1];
    if (run[index].role === "user" && reply.role === "assistant" && reply.debtId && !isQuietReply(reply) && isOwnMessage(run, index)) messages.push(run[index].content);
  }
  return messages;
}

// SEPARATE ENTRY. A message in an open debt flow that is not answer-shaped never writes on its own authority, however clear a new
// statement it looks, however it is worded, whatever the model made of it. When the call would write (a transaction, a debt, a
// payment, a bill, income) the code asks ONE question and writes nothing: record it as a separate new entry, or continue the saved
// debt's flow. The question stores the call and the words (ReplyData.separate), and only an exact reply decides.
export type SeparateChoice = "separate" | "that";
const SEPARATE_WORDS: readonly string[] = ["yes separate", "yes separately", "separate", "separately", "separate entry", "yes separate entry"];
const CONTINUE_DEBT_WORDS: readonly string[] = ["that debt", "the debt", "that one", "the same debt", "use that debt", "continue that debt", "continue"];
export function separateEntryChoice(reply: string): SeparateChoice | null {
  const normalized = normalizedPhrase(reply);
  return SEPARATE_WORDS.includes(normalized) ? "separate" : CONTINUE_DEBT_WORDS.includes(normalized) ? "that" : null;
}

const SEPARATE_OPENING = "You have an open question about ";
const SEPARATE_REPLIES = 'Reply "yes, separate" to record it, "that debt" to continue it, or say cancel.';

// The held call as the question names it, built from its structured fields (kind, amount, description, account, counterparty, bill
// name) and never from the user's raw words: 'Lunch, expense of ₱500.00 in Wallet'. null when the call names nothing worth saying.
export function heldCallLabel(call: { name: string; args: Record<string, unknown> }): string | null {
  const text = (value: unknown, max = 40): string => typeof value === "string"
    ? shortenAtWord(value.replace(/[\p{Cc}"“”]+/gu, " ").replace(/\s+/g, " ").trim(), max) : "";
  const money = (): string => {
    const { amount } = call.args;
    if (typeof amount !== "string" && typeof amount !== "number") return "";
    try { return formatPHP(parsePHPToMinor(String(amount))); } catch { return ""; }
  };
  const upper = (value: string) => value.replace(/\p{L}/u, (letter) => letter.toUpperCase());
  const amount = money();
  const person = text(call.args.counterparty);
  switch (call.name) {
    case "log_transaction": {
      const kind = call.args.kind === "income" || call.args.kind === "expense" ? call.args.kind : "entry";
      const account = text(call.args.account);
      const description = text(call.args.description);
      const movement = `${kind}${amount ? ` of ${amount}` : ""}${account ? ` in ${account}` : ""}`;
      return description ? `${upper(description)}, ${movement}` : upper(movement);
    }
    case "log_debt": {
      if (!person) return amount ? `Debt of ${amount}` : null;
      return call.args.direction === "you_owe" ? `You owe ${person}${amount ? ` ${amount}` : ""}`
        : call.args.direction === "owed_to_you" ? `${person} owes you${amount ? ` ${amount}` : ""}` : `Debt with ${person}${amount ? `, ${amount}` : ""}`;
    }
    case "record_debt_payment": return person ? `${person} paid you${amount ? ` ${amount}` : ""}` : null;
    case "record_debt_repayment": return person ? `You paid ${person}${amount ? ` ${amount}` : ""}` : null;
    case "create_bill": case "update_bill": {
      const name = text(call.args.name);
      return name ? `${upper(name)}, ${call.name === "create_bill" ? `bill${amount ? ` of ${amount}` : ""}` : "bill update"}` : null;
    }
    default: return null;
  }
}

export function separateEntryQuestion(debtLabel: string, held: string | null = null): string {
  return held
    ? `${SEPARATE_OPENING}${debtLabel}. Record "${held}" as a separate new entry? ${SEPARATE_REPLIES}`
    : `${SEPARATE_OPENING}${debtLabel}. Do you want me to record this as a separate new entry? ${SEPARATE_REPLIES}`;
}

// What a turn does with the separate-entry question. `separateOpen` is whether the run waits on that question, `choice` the exact
// reply to it, `flowOpen` whether a debt flow is open, `shaped` whether the message is answer-shaped for the question being asked,
// and `refusal` what refusalOutcome decided (a refusal wins over everything but the explicit "yes, separate").
//  - "record": the exact "yes, separate". The held statement is written as an ordinary new statement with no consent and no link.
//  - "continue": the exact "that debt". The saved debt's flow goes on.
//  - "holdNew": a message that would write and is no answer: in an open debt flow, or while the separate-entry question is open and the
//    message states an amount (`states`), where it REPLACES the held call. Ask the question about this call, naming it, write nothing.
//  - "askAgain": the separate-entry question is open and the message is neither choice and states no new statement (a model question, or a
//    write the model made of a message with no amount). Ask it
//    again about the same held call, naming it, write nothing.
//  - "proceed": everything else runs as before.
export type SeparateDecision = "proceed" | "record" | "continue" | "holdNew" | "askAgain";
export function separateEntryDecision(turn: { separateOpen: boolean; choice: SeparateChoice | null; flowOpen: boolean; shaped: boolean; refusal: RefusalOutcome; call: TurnCall; states: boolean }): SeparateDecision {
  if (turn.separateOpen && turn.choice === "separate") return "record";
  if (turn.refusal !== "proceed") return "proceed";
  if (turn.separateOpen && turn.choice === "that") return "continue";
  if (turn.call === "read") return "proceed";
  // A call the model made out of a message that states no amount (a stray word) is no newer statement and never replaces the hold.
  if (turn.separateOpen) return (turn.call === "write" || turn.call === "bill") && turn.states ? "holdNew" : "askAgain";
  if (!turn.flowOpen || turn.shaped) return "proceed";
  return turn.call === "write" || turn.call === "bill" ? "holdNew" : "proceed";
}

// The user messages of the open run whose hints may apply to the write the current message is for, and the other reading
// of the same run when the text rule was uncertain about it. `primary` is the rule's own verdict at every message, quiet
// turns left out, and never holds the current message, which the caller adds. It is empty when the current message starts
// its own statement. `other` is the same walk with every uncertain verdict turned over, and is null when that gives the
// same messages, so the write can have only one reading. Of the two, the longer one still carries the earlier statement.
export type HintReadings<T> = { primary: T[]; other: T[] | null };

export function hintReadingsFor<T extends RunMessage & { content: string }>(run: readonly T[], current: string, accountNames: readonly string[] = []): HintReadings<T> {
  const own = run.flatMap((message, index) => isOwnMessage(run, index)
    ? [{ message, pending: index > 0 ? run[index - 1].followup ?? null : null }] : []);
  const statementEnd = (start: number, end: number) => own.slice(start, end).map(({ message }) => message.content);
  const walk = (turnOver: boolean): T[] => {
    const starts = (pending: FollowupKind | null, reply: string, statement: readonly string[]) => {
      const reading = readStatementStart(pending, reply, statement, accountNames);
      return turnOver && reading.uncertain ? !reading.starts : reading.starts;
    };
    let start = 0;
    own.forEach(({ message, pending }, index) => { if (index > 0 && starts(pending, message.content, statementEnd(start, index))) start = index; });
    if (starts(run.at(-1)?.followup ?? null, current, statementEnd(start, own.length))) return [];
    return own.slice(start).map(({ message }) => message);
  };
  const primary = walk(false);
  const other = walk(true);
  return { primary, other: other.length === primary.length ? null : other };
}

export function hintMessagesFor<T extends RunMessage & { content: string }>(run: readonly T[], current: string, accountNames: readonly string[] = []): T[] {
  return hintReadingsFor(run, current, accountNames).primary;
}

// Where a write would put its money: the account, the date and the time, each as the write would store it. The reading of
// the earlier statement's hints and the reading without them are compared before any write. When they put the money in
// different places the text rule's verdict about the reply is not trusted: nothing is written and the user is asked, because
// a wrong guess either way writes the wrong account, date or time silently. A write with a single reading, or two that
// agree, is written as it is.
export type WritePlace = { account: string; date: string; time: string };

export function ambiguousHints(a: WritePlace, b: WritePlace): boolean {
  return a.account !== b.account || a.date !== b.date || a.time !== b.time;
}

// Which reading a reply to the question that named both choices picks, by an exact small list of words and nothing else. The
// earlier statement is chosen by "earlier", "earlier one", "the earlier" or "the earlier one", the restart (a new statement,
// with none of the earlier one's account, date, time or category) by "new one", "a new one" or "the new one". A reply that says
// neither is "unmarked": it is taken for the restart when it names the account and the date, as "use Wallet on 2026-10-09"
// does. A reply that says both, or says "not" (or "no", "don't", "never", "neither") anywhere beside either, is "unclear": the
// code will not guess which one is denied, so it asks again.
export const EARLIER_CHOICE_WORDS: readonly string[] = ["earlier", "earlier one", "the earlier", "the earlier one"];
export const NEW_CHOICE_WORDS: readonly string[] = ["new one", "a new one", "the new one"];
export type AmbiguityChoice = "earlier" | "new" | "unmarked" | "unclear";

const CHOICE_DENIAL = /\b(?:not|no|nope|never|neither|nor|dont|don t|isn t|isnt|wasn t|wasnt)\b/;

function choiceWordsIn(normalized: string, words: readonly string[]): boolean {
  return words.some((word) => ` ${normalized} `.includes(` ${word} `));
}

export function ambiguityChoice(reply: string): AmbiguityChoice {
  const normalized = normalizedPhrase(reply.replace(/['’]/g, " "));
  const earlier = choiceWordsIn(normalized, EARLIER_CHOICE_WORDS);
  const fresh = choiceWordsIn(normalized, NEW_CHOICE_WORDS);
  if (!earlier && !fresh) return "unmarked";
  if (earlier && fresh || CHOICE_DENIAL.test(normalized)) return "unclear";
  return earlier ? "earlier" : "new";
}

// The reply with its choice words taken out, so what is left can be read for an account and a date ("new one, Wallet, today").
export function withoutAmbiguityChoice(reply: string): string {
  let text = reply;
  for (const word of [...EARLIER_CHOICE_WORDS, ...NEW_CHOICE_WORDS].sort((a, b) => b.length - a.length)) {
    text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`, "giu"), " ");
  }
  return text;
}

// What the turn does with two readings. "write": they agree and no question was answered, or the message answering the question
// that named both choices chose between them. "ask": anything else. An answer is asked again when it says both choices or denies
// one ("unclear"), and when it says neither ("yes", "the first one") unless it names both an account and a date, which takes it
// for the restart ("use Wallet on 2026-10-09"). An answer with a choice word is taken at its word, but where the readings put the
// money in different accounts or dates it must also name them. The caller writes the reading the choice picks (AmbiguityChoice),
// so readings that differ in their time or their category alone are settled by the choice too, with nothing else to ask.
export type AmbiguityAnswer = { namesAccount: boolean; namesDate: boolean; choice: AmbiguityChoice };

export function ambiguityVerdict(a: WritePlace, b: WritePlace, answer: AmbiguityAnswer | null): "write" | "ask" {
  if (!answer) return ambiguousHints(a, b) ? "ask" : "write";
  if (answer.choice === "unclear") return "ask";
  if (answer.choice === "unmarked" && !(answer.namesAccount && answer.namesDate)) return "ask";
  return (a.account === b.account || answer.namesAccount) && (a.date === b.date || answer.namesDate) ? "write" : "ask";
}

// The one question that names both choices. `what` is the earlier statement's own wording ("coffee", "the payment from
// Maya"), `earlier` is where its hints would put the money. It stores nothing, says how to choose and asks for the account and
// date, so the answer is the next message, and says how to drop it.
const AMBIGUOUS_OPENING = "Do you mean the earlier ";
const AMBIGUOUS_CLOSING = ', or a new one? Reply "earlier" or "new one" with the account and date, or say cancel.';
export function ambiguousHintsQuestion(what: string, earlier: string): string {
  return `${AMBIGUOUS_OPENING}${what} in ${earlier}${AMBIGUOUS_CLOSING}`;
}

// Whether a stored assistant message is that question (its confirmation hint, if any, comes after it). The code wrote the
// message, so its fixed wording says it.
export function isAmbiguousHintsQuestion(content: string): boolean {
  return content.startsWith(AMBIGUOUS_OPENING) && content.includes(AMBIGUOUS_CLOSING);
}

// The assistant message the open run is waiting on: the last one that is not quiet. A turn that only read the ledger or saved a bill
// left the pending question pending and is not an answer to it (isQuietReply), so the next message answers the question and not the
// quiet reply, whatever stood last in the run.
export function openQuestionOf<T extends RunMessage>(run: readonly T[]): T | undefined {
  for (let index = run.length - 1; index >= 0; index--) {
    if (run[index].role === "assistant" && !isQuietReply(run[index])) return run[index];
  }
  return undefined;
}

// Whether the question the run is waiting on is the one that names both choices. Its kind says it can be (an account or date
// question, or a bill's account question) and its wording, which the code wrote, says that it is.
export function isAmbiguityQuestionOf(run: readonly (RunMessage & { content: string })[]): boolean {
  const open = openQuestionOf(run);
  return !!open && (open.followup === "account_or_date" || open.followup === "bill_account") && isAmbiguousHintsQuestion(open.content);
}

// What the question the run is waiting on asks for: the `asks` it stored, or for a row written before `asks` existed, the two
// questions the code words itself and can tell by their fixed text (the duplicate and the ambiguity question). null: unknown.
export function askedOf(run: readonly (RunMessage & { content: string })[]): Asks | null {
  const open = openQuestionOf(run);
  if (!open) return null;
  if (open.data?.asks) return open.data.asks;
  if (isDuplicateDebtQuestionOf(run)) return "duplicate";
  if (isAmbiguityQuestionOf(run)) return "ambiguity";
  return null;
}

// Refusal wording ("Ana did not pay me", "maybe he paid") blocks a write nobody confirmed. The block is one decision
// taken before the turn writes anything, never a reply that replaces one after it: a turn either writes nothing and
// says so, or writes and answers with what it wrote. The decision reads what the call is about to do, after every
// rewrite of it, and whether the refusal was said in earlier turns of the open run (quiet turns included) or in the
// message being answered.
export type TurnCall = "write" | "bill" | "read" | "ask";

// "bill" saves or updates a bill, "write" is any other call that can store money, "read" only reads the ledger,
// and "ask" is every call that stores nothing (a question, or a call the code does not know).
export function turnCallOf(name: string): TurnCall {
  if (name === "create_bill" || name === "update_bill") return "bill";
  if (["log_debt", "log_transaction", "record_debt_payment", "record_debt_repayment"].includes(name)) return "write";
  return name === "finance_question" ? "read" : "ask";
}

// The debt flow of a saved debt: the question that is pending after "Added to Debts only" (debt_transaction), and any account,
// date or generic question the flow asked about that debt, which stores the debt's id (debtId). The id is the debt a later
// answer links to and nothing else. It is never the user's opt-in to add the debt to Transactions, and which question carries it
// says nothing about whether the user agreed.
export function debtFlowContinues(pending: FollowupKind | null, carriesDebt: boolean): boolean {
  return pending === "debt_transaction" || ((pending === "account_or_date" || pending === "clarification") && carriesDebt);
}

// A message that refuses to record the money. It is a small ANCHORED set of exact forms, never a negation somewhere near a verb:
// "don't forget to log it", "I don't know, add it to Wallet", "I never save in cash, put it in Wallet" and "Spent 200 on lunch
// and don't forget to log it" all say "record it" and match nothing. The text is cut into clauses at . ! ? , ; : and a leading "no",
// "nope", "nah", "okay", "ok", "oh", "actually" or "sorry" is dropped, and the forms below must be a clause WHOLE:
//  - the bare answers "no", "nope", "nah", "no thanks", "no thank you", "hindi", "ayoko" (isOrdinaryIncomeDecline), "skip it",
//    "debts only" and "leave it in debts only", only as the message itself or its leading clause, because a "no" or a "skip it"
//    later in a message answers something else ("Wallet, no, GCash"),
//  - "don't / do not / won't / will not / never / no need to" + record, add, log or save + it, this or that (an optional "to
//    transactions" and an optional "yet" or "please" may follow), as any clause: "No, don't record it. The date was 2026-10-08.",
//    "Wallet, but don't record it".
// "forget", "know", "mind", "worry" and "need" without "to record" are no form. It is wording only and it never authorizes
// anything. It is read from the messages that answered the debt flow (debtFlowUserMessages), and it wins over a yes recorded
// earlier in the flow: the turn writes nothing (refusalOutcome).
const REFUSAL_VERBS = "(?:record|add|log|save)";
const REFUSAL_OBJECT = "(?:it|this|that)(?:\\s+(?:to|in|into)\\s+(?:my\\s+)?transactions?)?(?:\\s+(?:yet|now|please|anymore|for now))?";
const EXPLICIT_REFUSAL = new RegExp(`^(?:(?:please|i)\\s+)?(?:(?:don'?t|do not|won'?t|will not|never)\\s+(?:go ahead and\\s+)?|no need to\\s+)${REFUSAL_VERBS}\\s+${REFUSAL_OBJECT}$`);
const INTERJECTIONS: ReadonlySet<string> = new Set(["no", "nope", "nah", "okay", "ok", "oh", "actually", "sorry"]);
const LEAD_INTERJECTION = /^(?:(?:no(?!\s+need\b)|nope|nah|okay|ok|oh|actually|sorry)\s+)+/;
const LEADING_REFUSAL_FORMS: ReadonlySet<string> = new Set(["skip it", "leave it in debts only", "debts only"]);

export function isDebtRecordRefusal(text: string): boolean {
  if (isOrdinaryIncomeDecline(text)) return true;
  const clauses = text.replace(/[\u2018\u2019]/g, "'").toLowerCase().split(/[.!?,;:]+/).map((clause) => clause.replace(/\s+/g, " ").trim()).filter(Boolean);
  const afterInterjections = clauses.findIndex((clause) => !INTERJECTIONS.has(clause));
  if (afterInterjections < 0) return false;
  if (LEADING_REFUSAL_FORMS.has(clauses[afterInterjections].replace(LEAD_INTERJECTION, ""))) return true;
  return clauses.some((clause) => EXPLICIT_REFUSAL.test(clause.replace(LEAD_INTERJECTION, "").replace(/^(?:but|and)\s+/, "")));
}

// The user messages of the open run that answered the debt flow's own questions, which are the only ones refusal wording may be
// read from. A message answers when the reply before it is a question of the debt flow about a saved debt: the offer to add it to
// Transactions (debt_transaction) or an account, date or generic question that carries a debt id, and that includes a reply left
// pending by a quiet read, which carries the same question forward. The first message of the run, the statement itself, and a
// message that followed any other reply (a bill, another statement's question) are never read, so a negation said about something
// else cannot block a later answer. `answersOffer` marks the answer to the offer itself, where a plain no keeps its own meaning
// (the debt stays in Debts only) and is not a refusal.
export function debtFlowUserMessages<T extends RunMessage & { content: string; debtId?: string | null }>(run: readonly T[]): { message: T; answersOffer: boolean }[] {
  const answers: { message: T; answersOffer: boolean }[] = [];
  for (let index = 1; index < run.length; index++) {
    const message = run[index];
    const before = run[index - 1];
    if (message.role !== "user" || before.role !== "assistant" || !before.debtId) continue;
    if (before.followup === "debt_transaction") answers.push({ message, answersOffer: true });
    else if (before.followup === "account_or_date" || before.followup === "clarification") answers.push({ message, answersOffer: false });
  }
  return answers;
}

// The debt a message or a call names: its direction and its counterparty, each only when it names one.
export type DebtRef = { direction?: "owed_to_you" | "you_owe" | null; counterparty?: string | null };

// Everything one turn knows when it asks whether it answers the debt flow of a saved debt (debtFlowAnswers).
// `pending` and `carriesDebt` are the stored kind of the question the run waits on and whether it carries the saved debt's id.
// `refused` is refusal wording in the open run, the current message included. `shaped` is answerShaped's verdict on the current
// message for that question. `stated` is the debt the current message states in its own words, `saved` the debt the question
// carries, and `call` the provider's call: its kind and the debt it names, if it names one.
export type DebtFlowTurn = {
  pending: FollowupKind | null;
  carriesDebt: boolean;
  refused: boolean;
  shaped: boolean;
  stated: DebtRef | undefined;
  saved: DebtRef | undefined;
  call: { kind: TurnCall; names?: DebtRef };
};

function namesOtherDebt(saved: DebtRef | undefined, other: DebtRef | undefined): boolean {
  if (!saved || !other) return false;
  if (other.direction && saved.direction && other.direction !== saved.direction) return true;
  return !!other.counterparty && !!saved.counterparty && normalizeCounterparty(other.counterparty) !== normalizeCounterparty(saved.counterparty);
}

// Whether the current turn is an ANSWER to the debt flow's own question. Only an answer may use what the flow recorded: the yes or
// no said to the Transactions offer, and the saved debt's id the question carries. The test is a WHITELIST, not a list of the
// wordings that are not answers: the message must be answer-shaped for the question (answerShaped), which is an account, a date
// or a time, "transactions" or a choice word and nothing else once the filler and the flow's own words are taken out. A refusal
// worded any way, a restart, an expense that repeats the debt's amount and a purpose word, and a new debt are all something else,
// so none of them has to be recognised for safety. It also is not an answer when
//  (a) refusal wording is in the open run (the anchored set, an extra signal: the caller writes nothing, refusalOutcome), or
//  (b) the current message, or the provider's write, names a different counterparty or direction than the saved debt.
// A turn that is not an answer is its own statement: no consent and no link are carried to it. A call that only reads or asks
// names no debt, so the existing rules for those calls keep holding (debtContinuationRewrites).
export function debtFlowAnswers(turn: DebtFlowTurn): boolean {
  if (!debtFlowContinues(turn.pending, turn.carriesDebt)) return false;
  if (turn.refused || !turn.shaped) return false;
  if (namesOtherDebt(turn.saved, turn.stated)) return false;
  if (turn.call.kind === "write" && namesOtherDebt(turn.saved, turn.call.names)) return false;
  return true;
}

// A debt write never creates a second open debt that duplicates one this same open run already saved: the same counterparty (as
// the register compares it), the same direction and the same amount, read from the debt rows themselves. The saved debts of a
// run are the ones its replies carry (the stored debt_id), found by the caller. A settled debt, a debt that is not in the run and
// a debt that differs in any of the three are not duplicates, so a genuinely different debt is added as before. The wording
// of the turn cannot hide a duplicate: every path that would create a debt asks this first.
export type RunDebt = { id: string; direction: "owed_to_you" | "you_owe"; counterparty: string; amountMinor: number; status: "open" | "settled" };

export function duplicateOfRunDebt<T extends RunDebt>(savedInRun: readonly T[], next: { direction: RunDebt["direction"]; counterparty: string; amountMinor: number }): T | undefined {
  return savedInRun.find((debt) => debt.status === "open" && debt.direction === next.direction && debt.amountMinor === next.amountMinor
    && normalizeCounterparty(debt.counterparty) === normalizeCounterparty(next.counterparty));
}

// The debt ids the replies of an open run carry, each once, oldest first.
export function runDebtIds(run: readonly (RunMessage & { debtId?: string | null })[]): string[] {
  const ids: string[] = [];
  for (const message of run) if (message.role === "assistant" && message.debtId && !ids.includes(message.debtId)) ids.push(message.debtId);
  return ids;
}

// The one question a duplicate asks, stored as a clarification that carries the saved debt. The code wrote it, so its wording says it.
const DUPLICATE_OPENING = "You already added ";
const DUPLICATE_CLOSING = ' in this conversation. Add another, or use that one? Reply "another" or "that one", or cancel.';
export function duplicateDebtQuestion(debt: { direction: RunDebt["direction"]; counterparty: string }, formattedAmount: string): string {
  const what = debt.direction === "owed_to_you" ? `${debt.counterparty} owes you ${formattedAmount}` : `you owe ${debt.counterparty} ${formattedAmount}`;
  return `${DUPLICATE_OPENING}${what}${DUPLICATE_CLOSING}`;
}
export function isDuplicateDebtQuestion(content: string): boolean {
  return content.startsWith(DUPLICATE_OPENING) && content.includes(DUPLICATE_CLOSING);
}

// The answer to that question, by an exact list like ambiguityChoice: "another" adds a second debt, "that one" goes on with the
// saved one. Anything else is not an answer and the turn runs as an ordinary one (a repeat of the write asks again).
export type DuplicateChoice = "another" | "that";
const ANOTHER_DEBT_WORDS: readonly string[] = ["another", "another one", "add another", "add another one"];
const THAT_DEBT_WORDS: readonly string[] = ["that one", "use that one", "the same one", "same one"];
export function duplicateDebtChoice(reply: string): DuplicateChoice | null {
  const normalized = reply.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
  return ANOTHER_DEBT_WORDS.includes(normalized) ? "another" : THAT_DEBT_WORDS.includes(normalized) ? "that" : null;
}

// What the question the run is waiting on stored about the user's choice of another debt (ReplyData). `another`: the user chose
// "another" at the duplicate question and the question open now is still about that second debt, so a debt that repeats the
// first is not a duplicate for as long as that question stays open. `duplicateCall`: the write the duplicate question asked about.
export function openQuestionData(run: readonly RunMessage[]): ReplyData | null {
  return openQuestionOf(run)?.data ?? null;
}

// Whether the reply to the current turn must keep the choice of another debt: the turn is still working on the second debt (a debt
// write that made no debt yet and asks again), so the next answer must not merge it into the first. Once the second debt exists the
// question carries that debt and the flag has done its work.
export function keepsAnotherChoice(turn: { chosen: boolean; call: string; debtCreated: boolean; asks: boolean; debtOnQuestion: boolean }): boolean {
  return turn.chosen && turn.call === "log_debt" && !turn.debtCreated && turn.asks && !turn.debtOnQuestion;
}

// Whether the question the run is waiting on is the duplicate question.
export function isDuplicateDebtQuestionOf(run: readonly (RunMessage & { content: string })[]): boolean {
  const open = openQuestionOf(run);
  return !!open && open.followup === "clarification" && isDuplicateDebtQuestion(open.content);
}

// What the user said about adding the debt to Transactions in the statement being answered: "optIn" only from an opt-in the
// user gave (the statement's own words, or a yes to the stored debt_transaction offer), "optOut" from a no, null when they said
// neither. It is read from the user's messages and never from the question that is pending.
export type DebtTransactionAnswer = "optIn" | "optOut" | null;

// The user's yes or no to the stored "add it to Transactions" offer. One recognizer, used for the current message and for the
// messages of the run, so the answer means the same wherever it is read.
export const isDebtOfferYes = (text: string): boolean => /^\s*(?:yes|yeah|yep|sure|okay|ok|go ahead|add it|record it)\b/i.test(text);
export const isDebtOfferNo = (text: string): boolean => /^\s*(?:no|nope|nah)\b/i.test(text);

// A yes or a no said to the stored debt_transaction offer is a recorded answer, and it stays valid for the rest of that debt's
// flow: through the account, date or generic question the answer itself led to, however many times the flow asks again. The
// walk reads only what the run stored (the kind of each reply and the debt id it carried) and the user message that answered
// the offer. A reply's wording says nothing. It starts at an offer (a debt_transaction reply that carries a debt) and takes
// the next message that is not a quiet turn as its answer: a yes or a no records "optIn" or "optOut", anything else records
// nothing. It ends at any reply that is not an account_or_date or clarification question carrying the same debt (another kind,
// a different debt, no debt, a new offer for another debt, a cancel or a completed write, which end the run). Quiet turns
// (a read or a saved bill) answered their own request and are skipped. The offer being the last reply means the current message
// is its answer, which the caller reads itself, so the walk says null. The debt a question carries is link context only: the
// answer comes from the yes, never from the id.
type DebtChainTurn = RunMessage & { content: string; debtId?: string | null };

export function debtOfferChainAnswer(run: readonly DebtChainTurn[], shaped: (content: string) => boolean = () => true): DebtTransactionAnswer {
  let debtId: string | undefined;
  let awaitingAnswer = false;
  let answer: DebtTransactionAnswer = null;
  for (let index = 0; index < run.length; index++) {
    const message = run[index];
    const reply = run[index + 1];
    if (message.role !== "user" || reply?.role !== "assistant") continue;
    if (isQuietReply(reply)) continue;
    if (reply.followup === "debt_transaction" && reply.debtId) {
      // The offer opens the question, and the next message that is not a quiet turn is its answer.
      debtId = reply.debtId; awaitingAnswer = true; answer = null;
      continue;
    }
    if (debtId === undefined) continue;
    const carries = reply.debtId === debtId && (reply.followup === "account_or_date" || reply.followup === "clarification");
    if (awaitingAnswer) {
      awaitingAnswer = false;
      // A yes or a no counts only when it was answer-shaped when it was said: "yes, record my groceries for Ben" never was.
      answer = carries && shaped(message.content) ? isDebtOfferYes(message.content) ? "optIn" : isDebtOfferNo(message.content) ? "optOut" : null : null;
      if (answer === null) debtId = undefined;
    } else if (!carries) {
      debtId = undefined; answer = null;
    }
  }
  return debtId !== undefined && !awaitingAnswer ? answer : null;
}

// Whether the debt flow replaces the provider's call with the debt write for the saved debt. Only a call that writes (the model's
// own version of the same write) or asks (the model did not understand the answer) is replaced, and only when the user has said
// yes or no to Transactions in an answer to the debt flow (debtFlowAnswers): a yes writes the transaction, a no keeps the debt in
// Debts only. A turn that is its own statement, a call that only reads, a bill, or
// anything else is its own request. It runs as it is, and the pending question is left exactly as it was.
export function debtContinuationRewrites(call: TurnCall, answers: boolean, answer: DebtTransactionAnswer): boolean {
  return answers && answer !== null && (call === "write" || call === "ask");
}

// "proceed": no refusal applies, run the call. "askAgain": the call would write after a refusal said in an earlier
// turn; write nothing, say so, and leave the pending question exactly as it was, which cancel can still drop.
// "refuse": write nothing, say nothing was recorded, and end the question. "endQuestion": the refusal is in the
// message being answered and a bill in the same message is its own request, so the bill call runs, the refusal ends
// the pending question, and the reply says what was saved, or that nothing was when the bill still lacked details.
export type RefusalOutcome = "proceed" | "askAgain" | "refuse" | "endQuestion";

export function refusalOutcome(refusal: { earlier: boolean; now: boolean }, pending: FollowupKind | null, call: TurnCall): RefusalOutcome {
  if (!refusal.earlier && !refusal.now) return "proceed";
  if (call === "read") return pending ? "proceed" : "refuse";
  if (call === "ask") return "refuse";
  if (refusal.earlier) return pending ? "askAgain" : "refuse";
  return call === "bill" ? "endQuestion" : "refuse";
}

export const REFUSED_REPLY = "I didn't record anything because I couldn't confirm that the payment happened. If it did, tell me who paid and how much.";
export const DECLINED_REPLY = "Okay, I won't record the money.";
export const DEBT_REFUSED_AGAIN_REPLY = "You said earlier that you don't want this recorded, so I haven't recorded anything. Say cancel to drop this question.";
export const REFUSED_AGAIN_REPLY = "You said earlier that this payment didn't happen, so I haven't recorded anything. Say cancel to drop this question.";

// The reply of a turn that ends its pending question because the user refused or declined it. A reply that says
// nothing was recorded is only for a turn that wrote nothing. After a write it keeps the receipt and says the
// question was dropped.
export function endedQuestionReply(reason: "refused" | "declined", answer: string, wrote: boolean): string {
  if (!wrote) return reason === "refused" ? REFUSED_REPLY : DECLINED_REPLY;
  return `${answer}\n${reason === "refused" ? "I also dropped the earlier question about that payment." : "I also dropped the earlier question about recording the money."}`;
}

// What the open question run already saved. A debt is in Debts and a bill is in Bills, so a reply that drops the
// question must not say nothing was recorded when either exists.
export type RunSaved = { debt: boolean; bill: boolean };

// What a dropped question says it left behind. Most questions are asked before anything is saved, so nothing was
// recorded. The offer to add a just-saved debt to Transactions is different, because the debt is already in Debts,
// and so is every question that continues it ("add it to Transactions" asking for an account or a date). Saying
// nothing was recorded there would invite entering the debt again. A bill saved under a question that is not about
// a bill leaves that question pending, and the bill may have posted its due-today expense, so the wording about
// Transactions is only made for a debt alone.
function whatStays(pending: FollowupKind | null, saved: RunSaved): string | null {
  const debt = saved.debt || pending === "debt_transaction";
  if (debt && saved.bill) return "The debt stays in Debts and the bill stays in Bills.";
  if (debt) return "The debt stays in Debts, and nothing was added to Transactions.";
  if (saved.bill) return "The bill stays in Bills, and nothing else was recorded.";
  return null;
}

// What an expired question tells the user.
export function expiredReply(saved: RunSaved): string {
  const stays = whatStays(null, saved);
  return stays
    ? `That question has been open too long, so I dropped it. ${stays}`
    : "That question has been open too long, so I dropped it. Nothing was recorded. Please send the details again.";
}

// What a cancel tells the user about what happened to the dropped question.
export function cancelReply(pending: FollowupKind, saved: RunSaved): string {
  return `Okay, I dropped that question. ${whatStays(pending, saved) ?? "Nothing was recorded."}`;
}

// What a reply of the open question run already saved. The run is the messages since the last reply that asked
// nothing, and the saving reply is the one that carries the debt or the bill.
export function runSaved(messages: readonly { role: "user" | "assistant"; followup?: FollowupKind | null; debtId?: string | null; billId?: string | null }[]): RunSaved {
  const saved = { debt: false, bill: false };
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "assistant" && !messages[index].followup) break;
    if (messages[index].debtId) saved.debt = true;
    if (messages[index].billId) saved.bill = true;
  }
  return saved;
}

// The way out, appended when the code asks a question again while one is pending. The repayment and income
// questions the code forces on the user lead to each other, so any of them asked right after any of them
// carries it. Every other kind carries it only when the same question repeats. A first ask has none, and
// neither does a question the model worded itself, whatever kind it is stored under (during a repayment with
// no amount yet the model's own question is stored as the amount question), or the offer to add a debt to
// Transactions. The hint names what to reply to the code's own question, so it would be wrong under another.
// The income question asked again from its own account or date clarification is a plain re-ask too, so it carries the hint.
const LINKED_QUESTIONS: ReadonlySet<FollowupKind> = new Set<FollowupKind>(["repayment_amount", "repayment_payer", "ordinary_income"]);

export function cancelHint(pending: FollowupKind | null, asked: FollowupKind | null, modelWorded = false): string | null {
  if (modelWorded || pending === null || asked === null || asked === "clarification" || asked === "debt_transaction") return null;
  if (pending === "account_or_date" && asked === "ordinary_income") return "Or say cancel to drop this.";
  if (pending !== asked && !(LINKED_QUESTIONS.has(pending) && LINKED_QUESTIONS.has(asked))) return null;
  if (asked === "repayment_amount") return "Reply with the amount, or say cancel to drop this.";
  if (asked === "repayment_payer") return "Reply with the person's name, or say cancel to drop this.";
  return "Or say cancel to drop this.";
}
