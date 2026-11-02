import { useSyncExternalStore } from "react";

type Rate = { usdToGbp: number; asOf: string } | null;
let rate: Rate = null;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export function setExchangeRate(next: Rate) {
  if (!next || !Number.isFinite(next.usdToGbp) || next.usdToGbp <= 0) return;
  if (rate?.usdToGbp === next.usdToGbp && rate.asOf === next.asOf) return;
  rate = next;
  listeners.forEach((fn) => fn());
}

export function useExchangeRate() { return useSyncExternalStore(subscribe, () => rate); }

export function formatUsdInGbp(value: number | null): string {
  if (value == null) return "Unknown";
  if (!rate) return "GBP unavailable";
  const gbp = value * rate.usdToGbp;
  return `£${gbp < 1 ? gbp.toFixed(4) : gbp.toFixed(2)}`;
}
