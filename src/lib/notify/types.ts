import type { ShuttleKey } from "@/lib/shuttles";

export type NotifyLine = ShuttleKey | "both";

export type NotifySubscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  line: NotifyLine;
  stopKey: string;
  stopName: string;
  /** Minutes thresholds, e.g. [5, 2]. */
  horizons: number[];
  createdAt: string;
  updatedAt: string;
};

export type PushSubscriptionJSON = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};
