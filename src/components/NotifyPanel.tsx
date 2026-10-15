"use client";

import { useEffect, useMemo, useState } from "react";
import type { ShuttleKey } from "@/lib/shuttles";
import { SHUTTLES } from "@/lib/shuttles";
import type { NotifyLine } from "@/lib/notify/types";
import {
  getPushSubscription,
  isStandaloneDisplay,
  pushSupported,
  urlBase64ToUint8Array,
} from "@/lib/notify/client";
import styles from "@/app/page.module.css";

type Stop = { key: string; name: string };

type Props = {
  stopsByLine: { express: Stop[]; regular: Stop[] };
};

const STORAGE_KEY = "lark-notify-prefs-v1";

type Prefs = {
  enabled: boolean;
  line: NotifyLine;
  stopKey: string;
  horizons: number[];
};

const DEFAULT_PREFS: Prefs = {
  enabled: false,
  line: "both",
  stopKey: "lark",
  horizons: [5, 2],
};

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return {
      enabled: Boolean(parsed.enabled),
      line:
        parsed.line === "express" ||
        parsed.line === "regular" ||
        parsed.line === "both"
          ? parsed.line
          : "both",
      stopKey: typeof parsed.stopKey === "string" ? parsed.stopKey : "lark",
      horizons: Array.isArray(parsed.horizons)
        ? parsed.horizons.map(Number).filter((h) => h === 2 || h === 5 || h === 10)
        : [5, 2],
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export default function NotifyPanel({ stopsByLine }: Props) {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [standalone, setStandalone] = useState(false);
  const [supported, setSupported] = useState(false);

  const stopOptions = useMemo(() => {
    const map = new Map<string, string>();
    const lines: ShuttleKey[] =
      prefs.line === "both" ? ["express", "regular"] : [prefs.line];
    for (const line of lines) {
      for (const s of stopsByLine[line] || []) {
        if (!map.has(s.key)) map.set(s.key, s.name);
      }
    }
    return [...map.entries()].map(([key, name]) => ({ key, name }));
  }, [prefs.line, stopsByLine]);

  useEffect(() => {
    setPrefs(loadPrefs());
    setStandalone(isStandaloneDisplay());
    setSupported(pushSupported());
    fetch("/api/notify/vapid")
      .then(async (r) => {
        if (!r.ok) {
          setConfigured(false);
          return;
        }
        const data = (await r.json()) as { configured?: boolean };
        setConfigured(Boolean(data.configured));
      })
      .catch(() => setConfigured(false));
  }, []);

  useEffect(() => {
    if (!stopOptions.some((s) => s.key === prefs.stopKey) && stopOptions[0]) {
      setPrefs((p) => ({ ...p, stopKey: stopOptions[0].key }));
    }
  }, [stopOptions, prefs.stopKey]);

  const persist = (next: Prefs) => {
    setPrefs(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  const enable = async () => {
    setBusy(true);
    setStatus(null);
    try {
      if (!supported) {
        setStatus("Notifications need a modern browser.");
        return;
      }
      if (!standalone) {
        setStatus("Add LARK to your Home Screen, open it from there, then try again.");
        return;
      }
      if (configured === false) {
        setStatus("Alerts are not set up on this server yet.");
        return;
      }

      const vapidRes = await fetch("/api/notify/vapid");
      if (!vapidRes.ok) {
        setStatus("Alerts are not set up on this server yet.");
        setConfigured(false);
        return;
      }
      const { publicKey } = (await vapidRes.json()) as { publicKey: string };

      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus("Permission denied — enable notifications in Settings.");
        return;
      }

      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(
            publicKey,
          ) as BufferSource,
        });
      }

      const json = sub.toJSON();
      const stopName =
        stopOptions.find((s) => s.key === prefs.stopKey)?.name || prefs.stopKey;
      const horizons = prefs.horizons.length ? prefs.horizons : [5, 2];

      const res = await fetch("/api/notify/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: json.endpoint,
          keys: json.keys,
          line: prefs.line,
          stopKey: prefs.stopKey,
          stopName,
          horizons,
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { error?: string } | null;
        setStatus(err?.error || "Could not save alert.");
        return;
      }

      persist({ ...prefs, enabled: true, horizons });
      setStatus("Alerts on — we’ll nudge you at 5 and 2 min.");
    } catch (err) {
      console.error(err);
      setStatus(err instanceof Error ? err.message : "Could not enable alerts.");
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const sub = await getPushSubscription();
      if (sub) {
        await fetch("/api/notify/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        try {
          await sub.unsubscribe();
        } catch {
          /* ignore */
        }
      }
      persist({ ...prefs, enabled: false });
      setStatus("Alerts off.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Could not disable alerts.");
    } finally {
      setBusy(false);
    }
  };

  const toggleHorizon = (h: number) => {
    const set = new Set(prefs.horizons);
    if (set.has(h)) set.delete(h);
    else set.add(h);
    const horizons = [...set].sort((a, b) => b - a);
    persist({ ...prefs, horizons: horizons.length ? horizons : [5, 2] });
  };

  return (
    <section className={styles.notifyPanel} aria-label="Arrival alerts">
      <div className={styles.notifyHead}>
        <div className={styles.nextLabel}>Notify</div>
        <button
          type="button"
          className={prefs.enabled ? styles.notifyBtnOn : styles.notifyBtn}
          disabled={busy}
          onClick={() => (prefs.enabled ? void disable() : void enable())}
        >
          {prefs.enabled ? "On" : "Off"}
        </button>
      </div>

      {!standalone ? (
        <p className={styles.notifyHint}>
          Add to Home Screen, open LARK from there, then turn alerts on.
        </p>
      ) : configured === false ? (
        <p className={styles.notifyHint}>
          Server alerts are not configured yet (VAPID / Redis).
        </p>
      ) : null}

      <div className={styles.notifyControls}>
        <label className={styles.notifyField}>
          <span className={styles.metaLabel}>Line</span>
          <select
            className={styles.notifySelect}
            value={prefs.line}
            disabled={busy || prefs.enabled}
            onChange={(e) =>
              persist({
                ...prefs,
                line: e.target.value as NotifyLine,
              })
            }
          >
            <option value="both">All</option>
            <option value="express">{SHUTTLES.express.name}</option>
            <option value="regular">{SHUTTLES.regular.name}</option>
          </select>
        </label>

        <label className={styles.notifyField}>
          <span className={styles.metaLabel}>Stop</span>
          <select
            className={styles.notifySelect}
            value={prefs.stopKey}
            disabled={busy || prefs.enabled || !stopOptions.length}
            onChange={(e) => persist({ ...prefs, stopKey: e.target.value })}
          >
            {stopOptions.map((s) => (
              <option key={s.key} value={s.key}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className={styles.notifyHorizons} aria-label="Alert times">
        {[5, 2].map((h) => {
          const on = prefs.horizons.includes(h);
          return (
            <button
              key={h}
              type="button"
              className={on ? styles.notifyChipOn : styles.notifyChip}
              disabled={busy || prefs.enabled}
              onClick={() => toggleHorizon(h)}
            >
              {h} min
            </button>
          );
        })}
      </div>

      {status ? <p className={styles.notifyStatus}>{status}</p> : null}
    </section>
  );
}
