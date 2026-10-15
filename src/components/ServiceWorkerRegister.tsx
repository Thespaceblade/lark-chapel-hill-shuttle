"use client";

import { useEffect } from "react";

/** Registers the push service worker in secure contexts. */
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    if (!window.isSecureContext) return;

    const run = async () => {
      try {
        await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      } catch (err) {
        console.warn("LARK service worker registration failed", err);
      }
    };
    void run();
  }, []);

  return null;
}
