---- MODULE Debts ----
(* One debt record in Tally, from creation to deletion. Amounts are small whole numbers standing for centavos.
   Code mapped to each action is listed in ../SKILL.md. *)
EXTENDS Naturals, Integers

CONSTANTS
  MaxAmount,            \* largest amount a debt may be given (bound)
  PayRequiresOpen,      \* TRUE = recordDebtPayment / recordDebtRepayment / recordDebtAdvanceTransaction refuse non-open debts
  DirectionLockedByTxn, \* TRUE = updateDebtInternal refuses a direction change once a linked transaction exists
  SettledHistoryFrozen  \* FALSE = code today. TRUE = hypothetical fix: editing a settled debt writes no adjustment, and reopening writes one that makes the history add up to the amount

VARIABLES
  dir,       \* "owed_to_you" or "you_owe"
  status,    \* debts.status: "open" or "settled"
  amount,    \* debts.amount_minor, the number the screen shows
  principal, \* debts.principal_minor, fixed at creation
  deltaSum,  \* sum of debt_payments.delta_minor (payments are negative, edits are signed adjustments)
  paid,      \* total of linked repayment transactions
  advAmt,    \* amount of the linked advance transaction, 0 when none
  cash,      \* net change in the user's financial accounts caused by transactions linked to this debt
  nTxn,      \* number of transactions with debt_id = this debt
  txnDir,    \* direction the debt had when its first linked transaction was written, "none" before that
  lateTxn,   \* ghost: a transaction was ever linked while the debt was settled
  deleted    \* the debts row is gone

vars == <<dir, status, amount, principal, deltaSum, paid, advAmt, cash, nTxn, txnDir, lateTxn, deleted>>

Amounts == 1..MaxAmount
Dirs == {"owed_to_you", "you_owe"}
Sign(d) == IF d = "owed_to_you" THEN 1 ELSE -1   \* receiving raises cash, paying out lowers it

\* createDebt, or recordDebtAdvance which also writes the linked advance transaction.
Init ==
  /\ dir \in Dirs /\ status = "open"
  /\ \E a \in Amounts, adv \in BOOLEAN :
       /\ amount = a /\ principal = a /\ deltaSum = 0 /\ paid = 0
       /\ advAmt = IF adv THEN a ELSE 0
       /\ cash = IF adv THEN -Sign(dir) * a ELSE 0
       /\ nTxn = IF adv THEN 1 ELSE 0
       /\ txnDir = IF adv THEN dir ELSE "none"
  /\ lateTxn = FALSE /\ deleted = FALSE

\* recordDebtAdvanceTransaction: one advance transaction for an existing debt, for exactly its current amount.
AddAdvance ==
  /\ ~deleted /\ advAmt = 0
  /\ (PayRequiresOpen => status = "open")
  /\ advAmt' = amount
  /\ cash' = cash - Sign(dir) * amount
  /\ nTxn' = nTxn + 1
  /\ txnDir' = IF txnDir = "none" THEN dir ELSE txnDir
  /\ lateTxn' = (lateTxn \/ status = "settled")
  /\ UNCHANGED <<dir, status, amount, principal, deltaSum, paid, deleted>>

\* recordDebtPayment (owed_to_you) and recordDebtRepayment (you_owe): debtAfterPayment, one linked transaction, one history row.
Pay(a) ==
  /\ ~deleted
  /\ (PayRequiresOpen => status = "open")
  /\ a \in 1..amount
  /\ status' = IF a < amount THEN "open" ELSE "settled"
  /\ amount' = IF a < amount THEN amount - a ELSE amount     \* a settled debt keeps its last positive amount
  /\ deltaSum' = deltaSum - a
  /\ paid' = paid + a
  /\ cash' = cash + Sign(dir) * a
  /\ nTxn' = nTxn + 1
  /\ txnDir' = IF txnDir = "none" THEN dir ELSE txnDir
  /\ lateTxn' = (lateTxn \/ status = "settled")
  /\ UNCHANGED <<dir, principal, advAmt, deleted>>

\* updateDebt with a new amount, in any status: writes an "adjustment" history row, no transaction.
EditAmount(n) ==
  /\ ~deleted /\ n \in Amounts /\ n # amount
  /\ amount' = n
  /\ deltaSum' = IF SettledHistoryFrozen /\ status = "settled" THEN deltaSum ELSE deltaSum + (n - amount)
  /\ UNCHANGED <<dir, status, principal, paid, advAmt, cash, nTxn, txnDir, lateTxn, deleted>>

\* updateDebt with status "settled" (Settle button). Amount is kept.
Settle ==
  /\ ~deleted /\ status = "open"
  /\ status' = "settled"
  /\ UNCHANGED <<dir, amount, principal, deltaSum, paid, advAmt, cash, nTxn, txnDir, lateTxn, deleted>>

\* updateDebt with status "open" (Reopen button). Amount is kept; the code writes no history row.
Reopen ==
  /\ ~deleted /\ status = "settled"
  /\ status' = "open"
  /\ deltaSum' = IF SettledHistoryFrozen THEN amount - principal ELSE deltaSum
  /\ UNCHANGED <<dir, amount, principal, paid, advAmt, cash, nTxn, txnDir, lateTxn, deleted>>

\* updateDebt with a new direction.
EditDirection ==
  /\ ~deleted
  /\ (DirectionLockedByTxn => nTxn = 0)
  /\ dir' = IF dir = "owed_to_you" THEN "you_owe" ELSE "owed_to_you"
  /\ UNCHANGED <<status, amount, principal, deltaSum, paid, advAmt, cash, nTxn, txnDir, lateTxn, deleted>>

\* deleteDebt: history rows go with the debt, linked transactions stay in the ledger with debt_id cleared.
Delete ==
  /\ ~deleted
  /\ deleted' = TRUE
  /\ nTxn' = 0
  /\ UNCHANGED <<dir, status, amount, principal, deltaSum, paid, advAmt, cash, txnDir, lateTxn>>

Done == deleted /\ UNCHANGED vars

Next == AddAdvance \/ (\E a \in Amounts : Pay(a)) \/ (\E n \in Amounts : EditAmount(n))
        \/ Settle \/ Reopen \/ EditDirection \/ Delete \/ Done

Spec == Init /\ [][Next]_vars

\* Smaller model for drawing the main flow: payments, settle, reopen, delete only.
FlowNext == (\E a \in Amounts : Pay(a)) \/ Settle \/ Reopen \/ Delete \/ Done
FlowOwedSpec == Init /\ dir = "owed_to_you" /\ [][FlowNext]_vars
FlowOweSpec == Init /\ dir = "you_owe" /\ [][FlowNext]_vars

\* Keeps TLC finite: history sums and transaction counts stay small.
Bounded == deltaSum \in -2*MaxAmount..2*MaxAmount /\ nTxn <= 3

\* ---- Rules ----
AmountPositive == amount \in Amounts
\* While open, the number on screen is what the payment history adds up to.
OpenAmountMatchesHistory == status = "open" => amount = principal + deltaSum
\* The payment history never adds up to less than nothing.
HistoryNeverNegative == principal + deltaSum >= 0
\* Linked transactions move cash by exactly what the payments and advance say.
CashMatchesLinkedTransactions == cash = IF dir = "owed_to_you" THEN paid - advAmt ELSE advAmt - paid
\* Once a transaction is linked, the debt keeps the direction it had.
DirectionStableOnceLinked == txnDir \in {"none", dir}
\* A settled debt receives no new advance or repayment transaction.
NoActivityOnSettled == ~lateTxn
\* Deleting a debt never leaves a transaction pointing at it.
NoLinkAfterDelete == deleted => nTxn = 0
====
