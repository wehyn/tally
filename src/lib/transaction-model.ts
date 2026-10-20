import { z } from "zod";

export const transactionKinds = ["income", "expense", "transfer", "debt_repayment"] as const;
export const manualTransactionKinds = ["income", "expense", "transfer"] as const;

export const transactionKindSchema = z.enum(transactionKinds);
export const manualTransactionKindSchema = z.enum(manualTransactionKinds);

export type TransactionKind = z.infer<typeof transactionKindSchema>;
export type ManualTransactionKind = z.infer<typeof manualTransactionKindSchema>;

const transactionKindLabels = {
  income: "Income",
  expense: "Spending",
  transfer: "Transfer",
  debt_repayment: "Debt repayment",
} satisfies Record<TransactionKind, string>;

export function transactionKindLabel(kind: TransactionKind): string {
  return transactionKindLabels[kind];
}

export function isManualTransactionKind(kind: unknown): kind is ManualTransactionKind {
  return kind === "income" || kind === "expense" || kind === "transfer";
}
