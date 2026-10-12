import { ArrowLeftRight, Tags, Wallet } from "lucide-react";
import { SectionLanding } from "@/components/section-landing";

export default function MoneyPage() {
  return <SectionLanding
    title="Money"
    description="Track activity, manage your accounts, and organize your categories."
    destinations={[
      { href: "/transactions", label: "Transactions", description: "Review your income and spending.", icon: ArrowLeftRight },
      { href: "/accounts", label: "Accounts", description: "Manage balances and transfers.", icon: Wallet },
      { href: "/transactions#category-manager", label: "Categories", description: "Organize labels for your activity.", icon: Tags },
    ]}
  />;
}
