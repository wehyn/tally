const AMOUNT_PATTERN = /^(?:₱\s*)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;

export function parsePHPToMinor(input: string, options: { allowZero?: boolean } = {}): number {
  const value = input.trim();
  const match = AMOUNT_PATTERN.exec(value);
  if (!match) throw new Error("Enter a valid PHP amount with up to two decimal places.");

  const whole = Number(match[1].replaceAll(",", ""));
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const minor = whole * 100 + fraction;
  if (!Number.isSafeInteger(minor) || minor < 0 || (minor === 0 && !options.allowZero)) throw new Error(options.allowZero ? "Amount cannot be negative or exceed the supported range." : "Amount must be greater than zero and within the supported range.");
  return minor;
}

export function formatPHP(minor: number): string {
  if (!Number.isSafeInteger(minor)) throw new Error("Money must be an integer number of minor units.");
  return formatPHPFromMinorString(String(minor));
}

export function formatPHPFromMinorString(minor: string): string {
  if (!/^-?\d+$/.test(minor)) throw new Error("Money must be an integer number of minor units.");
  const amount = BigInt(minor);
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const whole = absolute / 100n;
  const cents = String(absolute % 100n).padStart(2, "0");
  const grouped = new Intl.NumberFormat("en-PH", { maximumFractionDigits: 0 }).format(whole);
  return `${negative ? "-" : ""}₱${grouped}.${cents}`;
}

export function minorToInput(minor: number): string {
  if (!Number.isSafeInteger(minor)) throw new Error("Money must be an integer number of minor units.");
  const absolute = Math.abs(minor);
  return `${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}
