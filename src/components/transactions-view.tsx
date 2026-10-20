"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, HandCoins, Plus, Pencil, Trash2, X, Search } from "lucide-react";
import type { Account, Category, Transaction } from "@/lib/store";
import { formatPHP, formatPHPFromMinorString, minorToInput } from "@/lib/money";
import { isUndoAvailable, todayInManila, timeInManila } from "@/lib/dates";
import { LEDGER_UPDATED_EVENT } from "@/lib/client-events";
import { ConfirmDialog, type ConfirmationRequest } from "./confirm-dialog";
import { ModalPresence } from "./modal-presence";
import { useAddIntent } from "@/lib/add-intent";
import { CategoryManager } from "./category-manager";
import { CategoryGlyph } from "./category-glyph";
import { transactionKindLabel } from "@/lib/transaction-model";

type Draft = { amount: string; description: string; accountId: string; categoryId: string; date: string; time: string };
const blank = (accounts: Account[]): Draft => ({amount:"",description:"",accountId:accounts.find(a=>a.isDefault)?.id??accounts[0]?.id??"",categoryId:"",date:todayInManila(),time:timeInManila()});
const transactionDateFormatter = new Intl.DateTimeFormat("en-US", { timeZone:"UTC", month:"long", day:"numeric", year:"numeric" });
const transactionTimeFormatter = new Intl.DateTimeFormat("en-US", { timeZone:"UTC", hour:"numeric", minute:"2-digit", hour12:true });
export function TransactionsView({initial,initialAccounts,initialCategories}:{initial:Transaction[];initialAccounts:Account[];initialCategories:Category[]}){
  const router=useRouter();
  const [transactions,setTransactions]=useState(initial);const [accounts,setAccounts]=useState(initialAccounts);const [categories,setCategories]=useState(initialCategories);
  const [search,setSearch]=useState("");const [open,setOpen]=useState(false);const [editing,setEditing]=useState<Transaction|null>(null);const [draft,setDraft]=useState<Draft>(blank(initialAccounts));const [error,setError]=useState("");const [busy,setBusy]=useState(false);const [confirmation,setConfirmation]=useState<ConfirmationRequest|null>(null);
  const [now,setNow]=useState(0);
  const refresh=useCallback(async()=>{const [t,a,c]=await Promise.all([fetch("/api/transactions").then(r=>r.json()),fetch("/api/accounts").then(r=>r.json()),fetch("/api/categories").then(r=>r.json())]);if(t.transactions)setTransactions(t.transactions);if(a.accounts)setAccounts(a.accounts);if(c.categories)setCategories(c.categories);},[]);
  useEffect(()=>{const update=()=>setNow(Date.now());update();const id=window.setInterval(update,1000);const refreshAfterAssistantTransaction=()=>{void refresh().catch(()=>undefined);};window.addEventListener(LEDGER_UPDATED_EVENT,refreshAfterAssistantTransaction);return()=>{window.clearInterval(id);window.removeEventListener(LEDGER_UPDATED_EVENT,refreshAfterAssistantTransaction);};},[refresh]);
  function startNew(){setEditing(null);setDraft(blank(accounts));setError("");setOpen(true);}
  useAddIntent("transaction",startNew);
  function startEdit(tx:Transaction){if(tx.kind==="transfer"){router.push("/accounts");return;}setEditing(tx);setDraft({amount:minorToInput(tx.amountMinor),description:tx.description,accountId:tx.accountId,categoryId:tx.categoryId??"",date:tx.date,time:tx.time??""});setError("");setOpen(true);}
  async function save(e:React.FormEvent){
    e.preventDefault();
    const category=categories.find(item=>item.id===draft.categoryId);
    if(editing?.kind!=="debt_repayment"&&!category){setError("Choose a category.");return;}
    setBusy(true);setError("");
    try{
      const movement={amount:draft.amount,description:draft.description,accountId:draft.accountId,date:draft.date,time:draft.time||null};
      const payload=editing?.kind==="debt_repayment"
        ?{...movement,kind:"debt_repayment"}
        :{...movement,kind:category!.type,categoryId:category!.id};
      const response=await fetch(editing?`/api/transactions/${editing.id}`:"/api/transactions",{method:editing?"PATCH":"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
      const result=await response.json();
      if(!response.ok)throw new Error(result.error??"Could not save transaction.");
      setOpen(false);await refresh();
    }catch(err){setError(err instanceof Error?err.message:"Could not save transaction.");}
    finally{setBusy(false);}
  }
  async function remove(tx:Transaction,undo=false){const response=await fetch(`/api/transactions/${tx.id}${undo?"?undo=1":""}`,{method:"DELETE"});const result=await response.json();if(!response.ok){const message=result.error??"Could not delete.";if(undo){setError(message);return;}throw new Error(message);}await refresh();}
  function requestRemove(tx:Transaction){const name=tx.description||tx.categoryName||tx.kind;setConfirmation({intent:"delete",title:"Delete this transaction?",description:`Permanently delete “${name}”? This cannot be recovered in Tally.`,confirmLabel:"Delete transaction",busyLabel:"Deleting…",onConfirm:()=>remove(tx)});}
  const shown=useMemo(()=>transactions.filter(tx=>`${tx.description} ${tx.categoryName??transactionKindLabel(tx.kind)} ${tx.accountName}`.toLowerCase().includes(search.toLowerCase())),[transactions,search]);
  const dateGroups=useMemo(()=>{
    const groups=new Map<string,{date:string;transactions:Transaction[];totalMinor:bigint}>();
    shown.forEach(tx=>{
      let group=groups.get(tx.date);
      if(!group){group={date:tx.date,transactions:[],totalMinor:0n};groups.set(tx.date,group);}
      group.transactions.push(tx);
      if(tx.kind==="income")group.totalMinor+=BigInt(tx.amountMinor);
      else if(tx.kind==="debt_repayment")group.totalMinor+=BigInt(tx.amountMinor);
      else if(tx.kind==="expense")group.totalMinor-=BigInt(tx.amountMinor);
    });
    return [...groups.values()];
  },[shown]);
  return <div className="page-stack"><section className="page-heading-row"><h1>Transactions</h1><button className="button button-primary" onClick={startNew}><Plus size={16}/> Add transaction</button></section>
    <article className="panel"><div className="content-toolbar"><div><h2 style={{margin:"0 0 4px",fontSize:14}}>Ledger activity</h2><span className="page-note">Debt repayments increase cash but stay separate from income and spending.</span></div><label style={{position:"relative",display:"flex",alignItems:"center"}}><Search size={15} style={{position:"absolute",left:11,color:"#9aa49e"}}/><input className="search-input" style={{paddingLeft:34}} value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search this ledger"/></label></div>
      {error&&!open&&<p className="error-text" role="alert" style={{marginTop:12}}>{error}</p>}
      <div className="table-wrap transaction-groups-wrap" style={{marginTop:8}}>
        <table aria-hidden="true" className="list-table transaction-layout-table transaction-column-head">
          <colgroup><col className="transaction-col-name"/><col className="transaction-col-category"/><col className="transaction-col-account"/><col className="transaction-col-amount"/><col className="transaction-col-actions"/></colgroup>
          <thead><tr><th>Transaction</th><th>Category or type</th><th>Account</th><th className="table-number">Amount</th><th><span className="sr-only">Actions</span></th></tr></thead>
        </table>
        {dateGroups.length>0&&<div className="transaction-date-groups">{dateGroups.map(group=>{
          const total=formatPHPFromMinorString(group.totalMinor.toString());
          return <section className="transaction-date-group transaction-group-card" key={group.date}>
            <h3 className="transaction-date-heading">
              <span className="transaction-date-label"><time dateTime={group.date}>{transactionDateFormatter.format(new Date(`${group.date}T00:00:00Z`))}</time><span aria-label={`${group.transactions.length} ${group.transactions.length===1?"transaction":"transactions"}`}>· {group.transactions.length}</span></span>
              <span className={`transaction-day-total ${group.totalMinor>0n?"positive":group.totalMinor<0n?"negative":""}`} aria-label={`Daily net ${group.totalMinor>0n?`+${total}`:total}`}>{group.totalMinor>0n?`+${total}`:total}</span>
            </h3>
            <table className="list-table transaction-layout-table transaction-group-table">
              <colgroup><col className="transaction-col-name"/><col className="transaction-col-category"/><col className="transaction-col-account"/><col className="transaction-col-amount"/><col className="transaction-col-actions"/></colgroup>
              <thead className="sr-only"><tr><th scope="col">Transaction</th><th scope="col">Category or type</th><th scope="col">Account</th><th scope="col">Amount</th><th scope="col">Actions</th></tr></thead>
              <tbody>{group.transactions.map(tx=><tr key={tx.id}>
                <td><div className="transaction-title-cell"><div className={`activity-icon ${tx.kind}`} aria-hidden="true">{tx.kind==="transfer"?<ArrowLeftRight size={16}/>:tx.kind==="debt_repayment"?<HandCoins size={16}/>:<CategoryGlyph icon={tx.categoryIcon} size={16}/>}</div><div><div className="table-title">{tx.description||tx.categoryName||transactionKindLabel(tx.kind)}</div>{tx.time&&<div className="table-muted">{transactionTimeFormatter.format(new Date(`1970-01-01T${tx.time}:00Z`))}</div>}<div className="transaction-mobile-meta" aria-hidden="true"><span className="transaction-mobile-category">{tx.categoryName??transactionKindLabel(tx.kind)}</span><span className="transaction-mobile-account">{tx.accountName}{tx.kind==="transfer"&&tx.destinationAccountName?` · To ${tx.destinationAccountName}`:""}</span></div></div></div></td>
                <td><span className={`badge transaction-category-badge ${tx.kind==="income"?"badge-green":tx.kind==="expense"?"badge-coral":"badge-violet"}`}>{tx.kind==="transfer"?<ArrowLeftRight size={13}/>:tx.kind==="debt_repayment"?<HandCoins size={13}/>:<CategoryGlyph icon={tx.categoryIcon} size={13}/>}<span>{tx.categoryName??transactionKindLabel(tx.kind)}</span></span></td>
                <td><div className="transaction-account-name">{tx.accountName}</div>{tx.kind==="transfer"&&tx.destinationAccountName&&<div className="table-muted">To {tx.destinationAccountName}</div>}</td>
                <td className={`table-number ${tx.kind==="expense"?"negative":tx.kind==="income"||tx.kind==="debt_repayment"?"positive":""}`}>{tx.kind==="expense"?"−":tx.kind==="income"||tx.kind==="debt_repayment"?"+":""}{formatPHP(tx.amountMinor)}</td>
                <td><div className="table-actions">{tx.kind==="transfer"?<Link className="button button-small" href="/accounts" aria-label="Manage transfer in Accounts">Manage</Link>:<>{tx.source==="assistant"&&isUndoAvailable(tx.undoUntil,now)&&<button className="button button-text button-small" onClick={()=>remove(tx,true)}>Undo</button>}<button className="icon-button" aria-label={`Edit ${tx.description||tx.categoryName||transactionKindLabel(tx.kind)}`} onClick={()=>startEdit(tx)}><Pencil size={15}/></button><button className="icon-button" disabled={Boolean(tx.debtId)} title={tx.debtId?"Delete the debt first to remove linked transaction history":undefined} aria-label={`Permanently delete ${tx.description||tx.categoryName||transactionKindLabel(tx.kind)}`} onClick={()=>requestRemove(tx)}><Trash2 size={15}/></button></>}</div></td>
              </tr>)}</tbody>
            </table>
          </section>;
        })}</div>}
        {!shown.length&&<div className="panel-empty"><strong>{transactions.length?"No matching transactions":"Your ledger is ready"}</strong>{transactions.length?"Try a different search.":"Add your first income, expense, or transfer."}</div>}
      </div>
    </article>
    <CategoryManager categories={categories} collapsible onChange={(next)=>{setCategories(next);setTransactions(current=>current.map(tx=>{const category=next.find(item=>item.id===tx.categoryId);return category?{...tx,categoryName:category.name,categoryIcon:category.icon}:tx;}));}}/>
    <ModalPresence open={open} onMouseDown={e=>{if(e.target===e.currentTarget)setOpen(false);}}><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="transaction-title"><div className="modal-heading"><div><h2 id="transaction-title">{editing?"Edit transaction":"Add transaction"}</h2><p>Saved to your private ledger.</p></div><button className="modal-close" onClick={()=>setOpen(false)} aria-label="Close"><X size={16}/></button></div><form onSubmit={save}><div className="form-grid"><label className="field-label">Amount in PHP<input autoFocus required disabled={Boolean(editing?.debtId)} inputMode="decimal" value={draft.amount} onChange={e=>setDraft({...draft,amount:e.target.value})} placeholder="250.00"/></label><label className="field-label">Financial account<select required value={draft.accountId} onChange={e=>setDraft({...draft,accountId:e.target.value})}><option value="">Choose account</option>{accounts.map(a=><option key={a.id} value={a.id}>{a.name}{a.isDefault?" · default":""}</option>)}</select></label><label className="field-label span-2">Description (optional)<input maxLength={180} value={draft.description} onChange={e=>setDraft({...draft,description:e.target.value})} placeholder="Add a note"/></label><label className="field-label">Date<input type="date" required value={draft.date} onChange={e=>setDraft({...draft,date:e.target.value})}/></label><label className="field-label">Time · Asia/Manila<input type="time" required={!editing||Boolean(draft.time)} value={draft.time} onChange={e=>setDraft({...draft,time:e.target.value})}/></label>{editing?.kind==="debt_repayment"?<div className="field-label span-2"><span>Type</span><strong>{transactionKindLabel(editing.kind)}</strong></div>:<label className="field-label span-2">Category<select required value={draft.categoryId} onChange={e=>setDraft({...draft,categoryId:e.target.value})}><option value="">Choose category</option>{categories.map(category=><option key={category.id} value={category.id}>{category.name} · {category.type}</option>)}</select></label>}</div>{editing?.debtId&&<p className="page-note">This transaction is linked to a debt. Its amount and deletion stay locked until the debt is deleted.</p>}{error&&<p className="error-text" role="alert" style={{marginTop:12}}>{error}</p>}<div className="modal-footer"><button type="button" className="button" onClick={()=>setOpen(false)}>Cancel</button><button disabled={busy} className="button button-primary">{busy?"Saving…":editing?"Save changes":"Save transaction"}</button></div></form></section></ModalPresence>
    <ConfirmDialog request={confirmation} onClose={() => setConfirmation(null)}/>
  </div>;
}
