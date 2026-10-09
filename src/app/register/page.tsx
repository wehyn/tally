import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { AuthForm } from "@/components/auth-form";
export default async function RegisterPage(){if(await currentUser())redirect("/dashboard");return <AuthForm mode="register"/>;}
