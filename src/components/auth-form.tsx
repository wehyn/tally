"use client";
import Link from "next/link";
import { ArrowRight, Eye, EyeOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

type Mode = "login" | "register" | "reset";
export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter(); const [username,setUsername] = useState(""); const [password,setPassword] = useState("");
  const [token,setToken] = useState(""); const [showPassword,setShowPassword] = useState(false); const [busy,setBusy] = useState(false); const [error,setError] = useState("");
  const isReset = mode === "reset"; const isRegister = mode === "register";
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError(""); setBusy(true);
    try {
      const endpoint = isReset ? "/api/auth/reset" : `/api/auth/${mode}`;
      const body = isReset ? { username, token, password } : { username, password };
      const response = await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
      const result = await response.json(); if(!response.ok) throw new Error(result.error??"Unable to continue.");
      if(isReset) router.replace("/login?reset=done"); else {router.replace("/dashboard");router.refresh();}
    } catch(cause) { setError(cause instanceof Error?cause.message:"Unable to continue."); }
    finally { setBusy(false); }
  }
  return <div className="auth-page"><section className="auth-story"><Link href="/" className="brand"><span className="brand-mark">t</span><span>Tally</span></Link><div className="auth-story-copy"><div className="eyebrow">A CALMER WAY TO TRACK MONEY</div><h1>See your money<br/>with a little more<br/>clarity.</h1><p>Your records stay yours. Shared goals bring people together without opening up anyone’s personal ledger.</p></div><div className="auth-foot">Private by default · Built for your home server</div></section><section className="auth-panel"><div className="auth-card"><div className="eyebrow">{isReset?"ACCOUNT RECOVERY":isRegister?"GET STARTED":"WELCOME BACK"}</div><h2 className="auth-title">{isReset?"Choose a new password":isRegister?"Create your account":"Sign in to Tally"}</h2><p className="auth-subtitle">{isReset?"Use the one-time reset credential provided by your administrator.":isRegister?"Your ledger is private to you, even from the instance admin.":"Pick up where you left off."}</p>{error&&<div className="auth-error" role="alert">{error}</div>}
    <form className="auth-form" onSubmit={submit}><label className="field-label">Username<input autoComplete="username" required minLength={isRegister?3:1} maxLength={32} value={username} onChange={e=>setUsername(e.target.value)} placeholder="Your username"/></label>
      {isReset&&<label className="field-label">One-time reset credential<input autoComplete="one-time-code" required value={token} onChange={e=>setToken(e.target.value)} placeholder="Paste reset credential"/></label>}
      <label className="field-label">{isReset?"New password":"Password"}<div className="password-field"><input autoComplete={isRegister?"new-password":"current-password"} type={showPassword?"text":"password"} required minLength={isRegister||isReset?12:1} maxLength={128} value={password} onChange={e=>setPassword(e.target.value)} placeholder={isRegister||isReset?"At least 12 characters":"Your password"}/><button type="button" className="password-toggle" onClick={()=>setShowPassword(!showPassword)} aria-label={showPassword?"Hide password":"Show password"}>{showPassword?<EyeOff size={16}/>:<Eye size={16}/>}</button></div></label>
      <button className="button button-primary full-width" disabled={busy}>{busy?"Please wait…":isReset?"Update password":isRegister?"Create account":"Sign in"}<ArrowRight size={15}/></button></form>
      {!isReset?<div className="auth-switch">{isRegister?"Already have an account? ":"New to Tally? "}<Link href={isRegister?"/login":"/register"}>{isRegister?"Sign in":"Create an account"}</Link>{!isRegister&&<div style={{marginTop:12}}><Link href="/reset">Use a one-time password reset</Link></div>}</div>:<div className="auth-switch"><Link href="/login">Back to sign in</Link></div>}
    </div></section></div>;
}
