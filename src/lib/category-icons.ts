export const CATEGORY_ICON_OPTIONS = [
  { id: "tag", label: "General" },
  { id: "briefcase-business", label: "Work" },
  { id: "hand-coins", label: "Income" },
  { id: "utensils", label: "Food" },
  { id: "coffee", label: "Coffee" },
  { id: "car-front", label: "Car" },
  { id: "bus", label: "Transit" },
  { id: "house", label: "Home" },
  { id: "zap", label: "Utilities" },
  { id: "heart-pulse", label: "Health" },
  { id: "shopping-bag", label: "Shopping" },
  { id: "shirt", label: "Clothing" },
  { id: "graduation-cap", label: "Education" },
  { id: "clapperboard", label: "Entertainment" },
  { id: "plane", label: "Travel" },
  { id: "smartphone", label: "Technology" },
  { id: "piggy-bank", label: "Savings" },
  { id: "trending-up", label: "Investing" },
  { id: "gift", label: "Gift" },
  { id: "wallet-cards", label: "Wallet" },
  { id: "circle-ellipsis", label: "Other" },
] as const;

export type CategoryIconId = (typeof CATEGORY_ICON_OPTIONS)[number]["id"];
export type CategoryType = "income" | "expense";
export const CATEGORY_ICON_IDS = CATEGORY_ICON_OPTIONS.map(({ id }) => id) as [CategoryIconId, ...CategoryIconId[]];

const DEFAULT_ICON_BY_CATEGORY: Partial<Record<`${CategoryType}:${string}`, CategoryIconId>> = {
  "income:salary": "briefcase-business",
  "income:other income": "hand-coins",
  "expense:food": "utensils",
  "expense:transport": "car-front",
  "expense:housing": "house",
  "expense:utilities": "zap",
  "expense:health": "heart-pulse",
  "expense:shopping": "shopping-bag",
  "expense:education": "graduation-cap",
  "expense:entertainment": "clapperboard",
  "expense:travel": "plane",
  "expense:other": "circle-ellipsis",
};

const VALID_ICON_IDS = new Set<string>(CATEGORY_ICON_OPTIONS.map(({ id }) => id));

export function isCategoryIconId(value: unknown): value is CategoryIconId {
  return typeof value === "string" && VALID_ICON_IDS.has(value);
}

export function defaultCategoryIcon(type: CategoryType, name: string): CategoryIconId {
  return DEFAULT_ICON_BY_CATEGORY[`${type}:${name.trim().toLowerCase()}`] ?? "tag";
}
