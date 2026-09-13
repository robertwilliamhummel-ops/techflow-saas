// Display formatting shared by every email template caller.

export function formatCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}
