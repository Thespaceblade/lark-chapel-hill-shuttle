/** Browser helpers for Web Push subscribe flow. */

export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

export function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false;
  const mq = window.matchMedia("(display-mode: standalone)").matches;
  const iosStandalone =
    "standalone" in navigator &&
    Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
  return mq || iosStandalone;
}

export function pushSupported(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export async function getPushSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}
