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

const POLL_MS = 1_000;

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

function statusWord(state: string | null | undefined): string {
  const s = (state || "").toLowerCase();
  if (s === "moving") return "en route";
  if (s === "idling") return "holding";
  if (s === "off") return "out of service";
  return s || "unknown";
}

function LineBullet({
  line,
  size = "md",
}: {
  line: ShuttleKey;
  size?: "sm" | "md" | "lg";
}) {
  const meta = SHUTTLES[line];
  return (
    <span
      className={`${styles.bullet} ${styles[`bullet_${size}`]}`}
      style={{ background: meta.color }}
      aria-hidden
    >
      {meta.bullet}
    </span>
  );
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

      <aside className={styles.board}>
        <header className={styles.masthead}>
          <div className={styles.brandBlock}>
            <h1 className={styles.brand}>LARK</h1>
            <p className={styles.brandSub}>Chapel Hill shuttle</p>
          </div>
          <div className={styles.serviceRow} aria-label="Service lines">
            <LineBullet line="express" size="lg" />
            <LineBullet line="regular" size="lg" />
          </div>
        </header>

        <nav className={styles.lineSelect} aria-label="Filter lines">
          {(["both", "express", "regular"] as const).map((key) => {
            const on = focus === key;
            return (
              <button
                key={key}
                type="button"
                className={on ? styles.lineBtnOn : styles.lineBtn}
                onClick={() => setFocus(key)}
              >
                {key === "both" ? (
                  <>
                    <span className={styles.dualBullets}>
                      <LineBullet line="express" size="sm" />
                      <LineBullet line="regular" size="sm" />
                    </span>
                    <span>All trains</span>
                  </>
                ) : (
                  <>
                    <LineBullet line={key} size="sm" />
                    <span>{SHUTTLES[key].name}</span>
                  </>
                )}
              </button>
            );
          })}
        </nav>

        <div className={styles.rolls}>
          {(["express", "regular"] as ShuttleKey[]).map((key) => {
            if (focus !== "both" && focus !== key) return null;
            const s = byKey.get(key);
            const eta =
              s?.nextStop?.etaMin != null
                ? Math.max(0, Math.round(s.nextStop.etaMin))
                : null;
            return (
              <section key={key} className={styles.roll}>
                <div className={styles.rollHead}>
                  <LineBullet line={key} size="md" />
                  <div className={styles.rollTitle}>
                    <h2>{SHUTTLES[key].name.toUpperCase()}</h2>
                    <p className={styles.toward}>
                      {key === "express"
                        ? "to Memorial Hall / Lark"
                        : "to Union · Deck · Sitterson · Lark"}
                    </p>
                  </div>
                  <div
                    className={styles.liveTag}
                    data-state={(s?.state || "").toLowerCase()}
                  >
                    {statusWord(s?.state)}
                  </div>
                </div>

                <div className={styles.nextBlock}>
                  <div className={styles.nextLabel}>Next stop</div>
                  <div className={styles.nextRow}>
                    <div className={styles.nextName}>
                      {s?.nextStop?.name ?? "—"}
                    </div>
                    <div className={styles.eta}>
                      {eta != null ? (
                        <>
                          <span className={styles.etaNum}>{eta}</span>
                          <span className={styles.etaUnit}>min</span>
                        </>
                      ) : (
                        <span className={styles.etaUnit}>—</span>
                      )}
                    </div>
                  </div>
                </div>

                <div className={styles.metaGrid}>
                  <div>
                    <div className={styles.metaLabel}>Last reported</div>
                    <div className={styles.metaValue}>
                      {s?.address ?? "Waiting for signal"}
                    </div>
                  </div>
                  <div>
                    <div className={styles.metaLabel}>Updated</div>
                    <div className={styles.metaValue}>
                      {ageLabel(s?.locatedAt ?? null)}
                      {s?.speed ? ` · ${s.speed}` : ""}
                    </div>
                  </div>
                </div>
              </section>
            );
          })}
        </div>

        {error ? <p className={styles.error}>{error}</p> : null}

        <footer className={styles.footer}>
          Live every 1s · Motive share
          {live?.fetchedAt ? ` · ${ageLabel(live.fetchedAt)}` : ""}
        </footer>
      </aside>
    </main>
  );
}
