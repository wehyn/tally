export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NODE_ENV === "production") {
    const { startBillScheduler } = await import("./lib/bill-scheduler");
    startBillScheduler();
  }
}
