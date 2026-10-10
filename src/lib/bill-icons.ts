export const BILL_ICONS = [
  "calendar", "home", "wifi", "phone", "electricity", "water", "tv", "music", "card",
  "netflix", "shopee", "pldt", "gym", "streaming", "shopping", "transport", "insurance", "gas", "medical", "school", "cloud", "trash",
] as const;
export type BillIcon = typeof BILL_ICONS[number];

export const DEFAULT_BILL_ICON_FOREGROUND_COLOR = "#5e9872";
export const DEFAULT_BILL_ICON_BACKGROUND_COLOR = "#f0f5f0";

const BILL_ICON_EMOJI_CHARACTERS = /^[#*0-9\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\uFE0F\u200D\u20E3]+$/u;
const BILL_ICON_EMOJI_MARK = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20E3]/u;

export const isBillIcon = (value: unknown): value is BillIcon => typeof value === "string" && BILL_ICONS.some((icon) => icon === value);
export const isBillIconColor = (value: unknown): value is string => typeof value === "string" && /^#[\da-f]{6}$/i.test(value);

export function isBillIconEmoji(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40 || !BILL_ICON_EMOJI_CHARACTERS.test(value) || !BILL_ICON_EMOJI_MARK.test(value)) return false;
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].length === 1;
}
