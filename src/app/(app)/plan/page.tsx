import { CalendarDays, HandCoins, Target } from "lucide-react";
import { SectionLanding } from "@/components/section-landing";

export default function PlanPage() {
  return <SectionLanding
    title="Plan"
    description="Stay on top of upcoming payments, balances owed, and shared goals."
    destinations={[
      { href: "/bills", label: "Bills", description: "Keep track of recurring payments and due dates.", icon: CalendarDays },
      { href: "/debts", label: "Debts", description: "Track money you owe and money owed to you.", icon: HandCoins },
      { href: "/goals", label: "Shared goals", description: "Save toward something together.", icon: Target },
    ]}
  />;
}
