"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { LiveShuttle, ShuttleKey } from "@/lib/shuttles";
import { SHUTTLES } from "@/lib/shuttles";
import styles from "./page.module.css";

const ShuttleMap = dynamic(() => import("@/components/ShuttleMap"), {
  ssr: false,
  loading: () => <div className={styles.mapSkeleton} />,
});

type LiveResponse = {
  fetchedAt: string;
  shuttles: LiveShuttle[];
  error?: string;
};

type RoutesResponse = {
  express: { color: string; stops: Stop[]; line: [number, number][] };
  regular: { color: string; stops: Stop[]; line: [number, number][] };
};

type Stop = { key: string; name: string; lat: number; lon: number };

const POLL_MS = 10_000;

function ageLabel(iso: string | null): string {
  if (!iso) return "—";
  const sec = Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 1000),
  );
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

export default function HomePage() {
  const [live, setLive] = useState<LiveResponse | null>(null);
  const [routes, setRoutes] = useState<RoutesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<ShuttleKey | "both">("both");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/routes")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setRoutes(data);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function pull() {
      try {
        const res = await fetch("/api/live", { cache: "no-store" });
        const data = (await res.json()) as LiveResponse;
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (!cancelled) {
          setLive(data);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }
    pull();
    const id = setInterval(pull, POLL_MS);
    const age = setInterval(() => setTick((t) => t + 1), 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
      clearInterval(age);
    };
  }, []);

  const byKey = useMemo(() => {
    const map = new Map<ShuttleKey, LiveShuttle>();
    live?.shuttles.forEach((s) => map.set(s.key, s));
    return map;
  }, [live]);

  void tick;

  return (
    <main className={styles.shell}>
      <ShuttleMap
        routes={routes}
        shuttles={live?.shuttles ?? []}
        focus={focus}
      />

      <aside className={styles.panel}>
        <p className={styles.eyebrow}>Chapel Hill</p>
        <h1 className={styles.brand}>Lark</h1>
        <p className={styles.tag}>
          Live Express & Regular shuttle positions. Next-stop ETA from the
          intended loop.
        </p>

        <div className={styles.toggles}>
          {(["both", "express", "regular"] as const).map((key) => (
            <button
              key={key}
              type="button"
              className={focus === key ? styles.toggleOn : styles.toggle}
              onClick={() => setFocus(key)}
            >
              {key === "both" ? "Both" : SHUTTLES[key].name}
            </button>
          ))}
        </div>

        <div className={styles.cards}>
          {(["express", "regular"] as ShuttleKey[]).map((key) => {
            const s = byKey.get(key);
            return (
              <article
                key={key}
                className={styles.card}
                style={{ ["--bus" as string]: SHUTTLES[key].color }}
              >
                <header className={styles.cardHead}>
                  <h2>{SHUTTLES[key].name}</h2>
                  <span className={styles.state}>
                    {s?.state ?? "…"}
                    {s?.speed ? ` · ${s.speed}` : ""}
                  </span>
                </header>
                <p className={styles.where}>{s?.address ?? "Waiting for fix…"}</p>
                {s?.nextStop ? (
                  <p className={styles.next}>
                    Next <strong>{s.nextStop.name}</strong>
                    {s.nextStop.etaMin != null
                      ? ` · ~${s.nextStop.etaMin} min`
                      : ""}
                    <span className={styles.meta}>
                      {" "}
                      ({Math.round(s.nextStop.alongM)} m along loop)
                    </span>
                  </p>
                ) : (
                  <p className={styles.next}>Next stop unavailable</p>
                )}
                <p className={styles.meta}>
                  Updated {ageLabel(s?.locatedAt ?? null)}
                  {s?.offLoopM != null ? ` · ${s.offLoopM} m off loop` : ""}
                </p>
              </article>
            );
          })}
        </div>

        {error ? <p className={styles.error}>{error}</p> : null}
        <p className={styles.footer}>
          Refreshes every 10s · Motive live share
          {live?.fetchedAt ? ` · fetched ${ageLabel(live.fetchedAt)}` : ""}
        </p>
      </aside>
    </main>
  );
}
