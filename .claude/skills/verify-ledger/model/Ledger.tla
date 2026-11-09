---- MODULE Ledger ----
\* Model of one user's financial accounts and transactions in src/lib/store.ts.
\* Every action is one db.transaction(...).immediate() call, so one action = one atomic step.
EXTENDS Integers, FiniteSets

CONSTANTS a1, a2, f1,
          OwnAccts,   \* accounts this user can create (ids)
          Foreign,    \* an account that belongs to someone else (never owned)
          Slots,      \* transaction row slots
          Amounts,    \* positive amounts used
          Bases       \* values for opening balance / "set balance"

VARIABLES acct,      \* set of owned account ids (financial_accounts rows)
          isDef,     \* is_default column per account id
          userDef,   \* users.default_account_id ("none" when no account)
          base,      \* opening_minor + balance_adjustment_minor_exact per account
          billUse,   \* a bill references the account (bills.account_id)
          txn,       \* transactions rows by slot, kind "none" = empty slot
          born       \* ghost: the user has created at least one account

vars == <<acct, isDef, userDef, base, billUse, txn, born>>
AllAccts == OwnAccts \cup {Foreign}
Cats == {"ci", "ce"}                      \* ci = income category, ce = expense category
CatType == [ci |-> "income", ce |-> "expense"]
Empty == [kind |-> "none", from |-> "none", to |-> "none", cat |-> "none", amt |-> 0, src |-> "manual", linked |-> FALSE, undo |-> FALSE]

RECURSIVE SumOver(_, _)
SumOver(S, f) == IF S = {} THEN 0 ELSE LET x == CHOOSE x \in S : TRUE IN f[x] + SumOver(S \ {x}, f)

\* listAccounts: balance = base + income + debt_repayment - expense - outgoing transfer + incoming transfer
Flow(a) == SumOver(Slots, [s \in Slots |-> LET t == txn[s] IN
    IF t.kind \in {"income", "debt_repayment"} /\ t.from = a THEN t.amt
    ELSE IF t.kind = "expense" /\ t.from = a THEN -t.amt
    ELSE IF t.kind = "transfer" /\ t.from = a THEN -t.amt
    ELSE IF t.kind = "transfer" /\ t.to = a THEN t.amt ELSE 0])
Bal(a) == base[a] + Flow(a)
Used(a) == \E s \in Slots : txn[s].kind # "none" /\ (txn[s].from = a \/ txn[s].to = a)

Init == /\ acct = {} /\ isDef = [a \in AllAccts |-> FALSE] /\ userDef = "none"
        /\ base = [a \in AllAccts |-> 0] /\ billUse = [a \in AllAccts |-> FALSE]
        /\ txn = [s \in Slots |-> Empty] /\ born = FALSE

\* createAccount: first account becomes default
CreateAccount(a, b) ==
    /\ a \in OwnAccts \ acct /\ b \in Bases
    /\ acct' = acct \cup {a}
    /\ base' = [base EXCEPT ![a] = b]
    /\ IF acct = {} THEN /\ isDef' = [isDef EXCEPT ![a] = TRUE] /\ userDef' = a
       ELSE UNCHANGED <<isDef, userDef>>
    /\ born' = TRUE /\ UNCHANGED <<billUse, txn>>

\* setDefaultAccount: clears all, sets one, mirrors to users.default_account_id
SetDefault(a) ==
    /\ a \in acct
    /\ isDef' = [x \in AllAccts |-> x = a] /\ userDef' = a
    /\ UNCHANGED <<acct, base, billUse, txn, born>>

\* updateAccount with balanceMinor: adjusts base so balance equals v
SetBalance(a, v) ==
    /\ a \in acct /\ v \in Bases
    /\ base' = [base EXCEPT ![a] = v - Flow(a)]
    /\ UNCHANGED <<acct, isDef, userDef, billUse, txn, born>>

\* deleteAccount guards: bill use, keep at least one, no history
DeleteAccount(a, next) ==
    /\ a \in acct /\ ~billUse[a] /\ Cardinality(acct) > 1 /\ ~Used(a)
    /\ acct' = acct \ {a}
    /\ next \in acct \ {a}
    /\ IF isDef[a] THEN /\ isDef' = [x \in AllAccts |-> x = next] /\ userDef' = next
       ELSE UNCHANGED <<isDef, userDef>>
    /\ base' = [base EXCEPT ![a] = 0]
    /\ UNCHANGED <<billUse, txn, born>>

\* environment: bills (other subsystem) start or stop referencing an account
BillToggle(a) == /\ a \in acct /\ billUse' = [billUse EXCEPT ![a] = ~billUse[a]] /\ UNCHANGED <<acct, isDef, userDef, base, txn, born>>

\* assertTransactionInput
Valid(k, f, t, c) ==
    /\ f \in acct
    /\ CASE k = "transfer" -> t \in acct /\ t # f /\ c = "none"
         [] k = "debt_repayment" -> t = "none" /\ c = "none"
         [] k \in {"income", "expense"} -> t = "none" /\ c \in Cats /\ CatType[c] = k

\* createTransaction (manual kinds only; assistant rows are undoable)
CreateTxn(s, k, f, t, c, n, src) ==
    /\ txn[s].kind = "none" /\ k \in {"income", "expense", "transfer"} /\ n \in Amounts
    /\ Valid(k, f, t, c)
    /\ txn' = [txn EXCEPT ![s] = [kind |-> k, from |-> f, to |-> t, cat |-> c, amt |-> n, src |-> src, linked |-> FALSE, undo |-> src = "assistant"]]
    /\ UNCHANGED <<acct, isDef, userDef, base, billUse, born>>

\* recordDebtPayment: debt_repayment row, linked to a debt, never undoable
CreateRepayment(s, f, n) ==
    /\ txn[s].kind = "none" /\ n \in Amounts /\ Valid("debt_repayment", f, "none", "none")
    /\ txn' = [txn EXCEPT ![s] = [kind |-> "debt_repayment", from |-> f, to |-> "none", cat |-> "none", amt |-> n, src |-> "assistant", linked |-> TRUE, undo |-> FALSE]]
    /\ UNCHANGED <<acct, isDef, userDef, base, billUse, born>>

\* updateTransaction
EditTxn(s, k, f, t, c, n) ==
    /\ txn[s].kind # "none" /\ n \in Amounts /\ Valid(k, f, t, c)
    /\ (k = "debt_repayment") => (txn[s].kind = "debt_repayment")
    /\ txn[s].linked => (k = txn[s].kind /\ n = txn[s].amt)
    /\ txn' = [txn EXCEPT ![s] = [txn[s] EXCEPT !.kind = k, !.from = f, !.to = t, !.cat = c, !.amt = n]]
    /\ UNCHANGED <<acct, isDef, userDef, base, billUse, born>>

\* deleteTransaction (undoOnly = TRUE is the 10-second assistant Undo)
DeleteTxn(s, undoOnly) ==
    /\ txn[s].kind # "none" /\ ~txn[s].linked
    /\ undoOnly => (txn[s].src = "assistant" /\ txn[s].undo)
    /\ txn' = [txn EXCEPT ![s] = Empty]
    /\ UNCHANGED <<acct, isDef, userDef, base, billUse, born>>

\* environment: the 10 seconds pass
ExpireUndo(s) == /\ txn[s].undo /\ txn' = [txn EXCEPT ![s].undo = FALSE] /\ UNCHANGED <<acct, isDef, userDef, base, billUse, born>>

Next == \/ \E a \in OwnAccts, b \in Bases : CreateAccount(a, b)
        \/ \E a \in OwnAccts : SetDefault(a)
        \/ \E a \in OwnAccts, v \in Bases : SetBalance(a, v)
        \/ \E a, n \in OwnAccts : DeleteAccount(a, n)
        \/ \E a \in OwnAccts : BillToggle(a)
        \/ \E s \in Slots, k \in {"income", "expense", "transfer"}, f \in AllAccts, t \in AllAccts \cup {"none"}, c \in Cats \cup {"none"}, n \in Amounts, src \in {"manual", "assistant"} : CreateTxn(s, k, f, t, c, n, src)
        \/ \E s \in Slots, f \in AllAccts, n \in Amounts : CreateRepayment(s, f, n)
        \/ \E s \in Slots, k \in {"income", "expense", "transfer", "debt_repayment"}, f \in AllAccts, t \in AllAccts \cup {"none"}, c \in Cats \cup {"none"}, n \in Amounts : EditTxn(s, k, f, t, c, n)
        \/ \E s \in Slots, u \in BOOLEAN : DeleteTxn(s, u)
        \/ \E s \in Slots : ExpireUndo(s)

Spec == Init /\ [][Next]_vars

\* ---- Invariants ----
\* Promise: with any account there is exactly one default and users.default_account_id names it.
OneDefault ==
    /\ \A a \in AllAccts \ acct : ~isDef[a]
    /\ IF acct = {} THEN userDef = "none"
       ELSE /\ Cardinality({a \in acct : isDef[a]}) = 1 /\ userDef \in acct /\ isDef[userDef]
\* Promise: once the user has an account they always have one (logging requires an account).
KeepOneAccount == born => acct # {}
\* Promise: every transaction uses owned accounts and a category of the matching type.
TxnRefsValid == \A s \in Slots : LET t == txn[s] IN t.kind # "none" =>
    /\ t.from \in acct
    /\ t.kind = "transfer" => (t.to \in acct /\ t.to # t.from /\ t.cat = "none")
    /\ t.kind = "debt_repayment" => (t.to = "none" /\ t.cat = "none")
    /\ t.kind \in {"income", "expense"} => (t.to = "none" /\ t.cat \in Cats /\ CatType[t.cat] = t.kind)
\* Promise: a transfer moves money between accounts without changing the combined balance;
\* the combined balance is opening money plus income and repayments minus spending.
TransfersNeutral ==
    SumOver(acct, [a \in acct |-> Bal(a)]) =
      SumOver(acct, [a \in acct |-> base[a]])
      + SumOver(Slots, [s \in Slots |-> IF txn[s].kind \in {"income", "debt_repayment"} THEN txn[s].amt ELSE IF txn[s].kind = "expense" THEN -txn[s].amt ELSE 0])
\* Promise: a debt-linked row is never undoable, and Undo only exists for assistant rows.
UndoShape == \A s \in Slots : txn[s].undo => (txn[s].src = "assistant" /\ ~txn[s].linked /\ txn[s].kind # "none")
\* Promise: a deleted account leaves no transaction behind that still points at it.
NoOrphan == \A s \in Slots : txn[s].kind # "none" => (txn[s].from \in acct /\ (txn[s].to = "none" \/ txn[s].to \in acct))
Bound == \A a \in acct : Bal(a) \in -4..6
\* Extra bound for the small chart config only: no bill references, no balance adjustments.
ChartBound == /\ \A a \in AllAccts : ~billUse[a] /\ base[a] = 0
====
