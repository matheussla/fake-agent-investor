export function formatPrice(value: string): string {
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 8 });
}
