import {
  BriefcaseBusiness,
  Bus,
  CarFront,
  CircleEllipsis,
  Clapperboard,
  Coffee,
  Gift,
  GraduationCap,
  HandCoins,
  HeartPulse,
  House,
  PiggyBank,
  Plane,
  Shirt,
  ShoppingBag,
  Smartphone,
  Tag,
  TrendingUp,
  Utensils,
  WalletCards,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { CategoryIconId } from "@/lib/category-icons";

const ICON_COMPONENTS: Record<CategoryIconId, LucideIcon> = {
  tag: Tag,
  "briefcase-business": BriefcaseBusiness,
  "hand-coins": HandCoins,
  utensils: Utensils,
  coffee: Coffee,
  "car-front": CarFront,
  bus: Bus,
  house: House,
  zap: Zap,
  "heart-pulse": HeartPulse,
  "shopping-bag": ShoppingBag,
  shirt: Shirt,
  "graduation-cap": GraduationCap,
  clapperboard: Clapperboard,
  plane: Plane,
  smartphone: Smartphone,
  "piggy-bank": PiggyBank,
  "trending-up": TrendingUp,
  gift: Gift,
  "wallet-cards": WalletCards,
  "circle-ellipsis": CircleEllipsis,
};

export function CategoryGlyph({ icon, size = 16 }: { icon: CategoryIconId | null; size?: number }) {
  const Icon = icon ? ICON_COMPONENTS[icon] : Tag;
  return <Icon aria-hidden="true" size={size} strokeWidth={1.9} />;
}
