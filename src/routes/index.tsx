import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import TopBar from "@/components/TopBar";
import Legend from "@/components/Legend";
import LoadingOverlay from "@/components/LoadingOverlay";
import ToolPanel from "@/components/ToolPanel";
import DetailSidebar from "@/components/DetailSidebar";
import type { AisShip, GfwEvent, Mode, Selection, TrackPoint } from "@/lib/types";

const MapView = lazy(() => import("@/components/MapView"));

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "MAP — AIS Indonesia" },
      { name: "description", content: "Pelacakan kapal realtime di perairan Indonesia: AIS Stream + Global Fishing Watch." },
      { property: "og:title", content: "MAP — AIS Indonesia" },
      { property: "og:description", content: "Realtime maritime tracking untuk perairan Indonesia." },
    ],
  }),
  component: Index,
});

const GFW_CACHE_KEY = "gfw-events-cache-v1";
const GFW_CACHE_TTL = 5 * 60 * 1000;

function Index() {
  const [mounted, setMounted] = useState(false);
  const [mode, setMode] = useState<Mode | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  const [ships, setShips] = useState<Map<string, AisShip>>(new Map());
  const [events, setEvents] = useState<GfwEvent[]>([]);
  const [online, setOnline] = useState(false);
  const [msgCount, setMsgCount] = useState(0);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [gfwLoading, setGfwLoading] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);

  const [trajectory, setTrajectory] = useState<TrackPoint[] | null>(null);
  const [trailShipKey, setTrailShipKey] = useState<string | null>(null);
  const [zoomTarget, setZoomTarget] = useState<{ lat: number; lon: number; key: number } | null>(null);

  const [aisKey, setAisKey] = useState("");
  const aisClientRef = useRef<any>(null);

  useEffect(() => { setMounted(true); }, []);

  // Load AIS key from localStorage / env
  useEffect(() => {
    const stored = typeof window !== "undefined" ? localStorage.getItem("ais_key") : null;
    const env = (import.meta as any).env?.VITE_AIS_KEY;
    setAisKey(stored || env || "");
  }, []);
  useEffect(() => {
    if (typeof window !== "undefined" && aisKey) localStorage.setItem("ais_key", aisKey);
  }, [aisKey]);

  // Mode switching: clear markers + selection
  useEffect(() => {
    setSelection(null);
    setTrajectory(null);
    setTrailShipKey(null);
    if (mode !== "ais") {
      stopAis();
      setShips(new Map());
      setOnline(false);
    }
    if (mode === "ais") startAis();
    if (mode === "gfw") loadGfw();
    else setEvents([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  async function startAis() {
    if (!aisKey) {
      alert("Masukkan AISStream API key dulu (klik 🔑 di topbar).");
      setMode(null);
      return;
    }
    const { AisStreamClient } = await import("@/lib/aisstream");
    const client = new AisStreamClient(aisKey, {
      onShip: (s) => {
        setShips((prev) => {
          const m = new Map(prev);
          m.set(s.mmsi, { ...s });
          return m;
        });
        setLastUpdate(Date.now());
        // Live-update sidebar if showing this ship
        setSelection((sel) => sel?.kind === "ais" && sel.ship.mmsi === s.mmsi ? { kind: "ais", ship: { ...s } } : sel);
      },
      onMessage: () => setMsgCount((n) => n + 1),
      onStatus: setOnline,
    });
    aisClientRef.current = client;
    client.start();

    // Periodic prune of stale ships in state
    const id = setInterval(() => {
      const cutoff = Date.now() - 10 * 60_000;
      setShips((prev) => {
        let changed = false;
        const m = new Map(prev);
        for (const [k, v] of m) {
          if (v.updatedAt < cutoff) { m.delete(k); changed = true; }
        }
        return changed ? m : prev;
      });
    }, 30_000);
    (client as any)._stateInterval = id;
  }

  function stopAis() {
    const c = aisClientRef.current;
    if (c) {
      if (c._stateInterval) clearInterval(c._stateInterval);
      c.stop();
    }
    aisClientRef.current = null;
  }

  async function loadGfw() {
    // Client cache
    try {
      const raw = localStorage.getItem(GFW_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.t && Date.now() - parsed.t < GFW_CACHE_TTL && Array.isArray(parsed.events)) {
          setEvents(parsed.events);
          setLastUpdate(parsed.t);
          return;
        }
      }
    } catch {}

    setGfwLoading(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const r = await fetch(`/api/gfw/events?start_date=2012-01-01&end_date=${today}`);
      const j = await r.json();
      const evs: GfwEvent[] = j.events || [];
      setEvents(evs);
      setLastUpdate(Date.now());
      try { localStorage.setItem(GFW_CACHE_KEY, JSON.stringify({ t: Date.now(), events: evs })); } catch {}
    } finally {
      setGfwLoading(false);
    }
  }

  const shipsArr = useMemo(() => Array.from(ships.values()), [ships]);

  // Plot from ToolPanel
  const plotTrajectory = useCallback(async (vesselId: string, start: string, end: string) => {
    setGfwLoading(true);
    try {
      const r = await fetch(`/api/gfw/track?vessel_id=${encodeURIComponent(vesselId)}&start_date=${start}&end_date=${end}`);
      const j = await r.json();
      if (j?.track?.length) setTrajectory(j.track);
    } finally {
      setGfwLoading(false);
    }
  }, []);

  const trailShip = trailShipKey ? ships.get(trailShipKey) ?? null : null;

  const trajectoryActive = !!trajectory || !!trailShipKey;

  function handleActivateTrajectory() {
    if (!selection) return;
    if (trajectoryActive) {
      setTrajectory(null);
      setTrailShipKey(null);
      return;
    }
    if (selection.kind === "ais") {
      // Use stored trail polyline
      setTrailShipKey(selection.ship.mmsi);
    } else if (selection.kind === "gfw" && selection.event.vesselId) {
      // Fetch full history (no date filter — use very wide range)
      const today = new Date().toISOString().slice(0, 10);
      setGfwLoading(true);
      fetch(`/api/gfw/track?vessel_id=${encodeURIComponent(selection.event.vesselId)}&start_date=2012-01-01&end_date=${today}`)
        .then(r => r.json())
        .then(j => { if (j?.track?.length) setTrajectory(j.track); })
        .finally(() => setGfwLoading(false));
    }
  }

  function handleZoom() {
    if (!selection) return;
    if (selection.kind === "ais") setZoomTarget({ lat: selection.ship.lat, lon: selection.ship.lon, key: Date.now() });
    else setZoomTarget({ lat: selection.event.lat, lon: selection.event.lon, key: Date.now() });
  }

  return (
    <div className="fixed inset-0">
      <Suspense fallback={<MapFallback />}>
        {mounted && (
          <MapView
            mode={mode ?? "ais"}
            ships={shipsArr}
            events={events}
            selectedKey={selection ? (selection.kind === "ais" ? selection.ship.mmsi : selection.event.id) : null}
            onSelectShip={(s) => setSelection({ kind: "ais", ship: s })}
            onSelectEvent={(e) => setSelection({ kind: "gfw", event: e })}
            trajectory={trajectory}
            trailShip={trailShip}
            zoomTarget={zoomTarget}
          />
        )}
      </Suspense>

      <TopBar
        mode={mode}
        online={mode === "ais" ? online : mode === "gfw" ? !gfwLoading : false}
        shipCount={mode === "ais" ? shipsArr.length : events.length}
        msgCount={msgCount}
        lastUpdate={lastUpdate}
        onSetMode={setMode}
        onTogglePanel={() => setPanelOpen(v => !v)}
        panelOpen={panelOpen}
        aisKey={aisKey}
        onAisKeyChange={setAisKey}
      />

      <Legend mode={mode} />

      <ToolPanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        onPlotTrajectory={(vid, s, e) => plotTrajectory(vid, s, e)}
        onClearTrajectory={() => { setTrajectory(null); setTrailShipKey(null); }}
      />

      <DetailSidebar
        selection={selection}
        onClose={() => setSelection(null)}
        onActivateTrajectory={handleActivateTrajectory}
        onZoom={handleZoom}
        trajectoryActive={trajectoryActive}
      />

      <LoadingOverlay show={gfwLoading} label="Mengambil data GFW…" />

      {!mode && mounted && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[1000] glass rounded-full px-4 py-2 text-xs text-muted-foreground">
          Pilih mode di atas: <span className="text-primary">AISStream Live</span> atau <span style={{ color: "var(--ais-fast)" }}>GFW Events</span>
        </div>
      )}
    </div>
  );
}

function MapFallback() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background">
      <div className="text-muted-foreground text-sm">Memuat peta…</div>
    </div>
  );
}
