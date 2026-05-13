import { useEffect, useState } from "react";
import type { GfwrQuery, VesselSearchResult } from "@/lib/types";

type Props = {
  open: boolean;
  onClose: () => void;
  onPlotTrajectory: (vesselId: string, start: string, end: string, label: string) => void;
  onClearTrajectory: () => void;
};

function isoDaysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export default function ToolPanel({ open, onClose, onPlotTrajectory, onClearTrajectory }: Props) {
  const [tab, setTab] = useState<"query" | "trajectory">("trajectory");
  const [queries, setQueries] = useState<GfwrQuery[]>([]);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<VesselSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<VesselSearchResult | null>(null);
  const [start, setStart] = useState(isoDaysAgo(30));
  const [end, setEnd] = useState(isoDaysAgo(0));
  const [summary, setSummary] = useState<string>("");

  useEffect(() => {
    if (tab === "query" && queries.length === 0) {
      fetch("/api/gfwr/queries").then(r => r.json()).then(j => setQueries(j.queries || []));
    }
  }, [tab, queries.length]);

  async function doSearch() {
    if (!search.trim()) return;
    setSearching(true); setResults(null);
    try {
      const r = await fetch(`/api/gfw/vessels/search?query=${encodeURIComponent(search)}&limit=20`);
      const j = await r.json();
      setResults(j.vessels || []);
    } finally { setSearching(false); }
  }

  return (
    <aside
      className="fixed top-3 left-3 z-[1100] transition-transform duration-300"
      style={{
        transform: open ? "translateX(0)" : "translateX(calc(-100% - 20px))",
        width: "min(380px, calc(100vw - 28px))",
        maxHeight: "calc(100vh - 24px)",
      }}
    >
      <div className="glass rounded-2xl flex flex-col h-full max-h-[calc(100vh-24px)]">
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <div className="text-sm font-medium">Query &amp; Track</div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-lg leading-none">×</button>
        </div>
        <div className="px-3 flex gap-1 border-b border-border">
          <TabBtn active={tab === "query"} onClick={() => setTab("query")}>GFWR Query</TabBtn>
          <TabBtn active={tab === "trajectory"} onClick={() => setTab("trajectory")}>Trajectory</TabBtn>
        </div>

        <div className="overflow-y-auto thin-scroll p-3 text-sm flex-1">
          {tab === "query" && (
            <div className="space-y-2">
              {queries.length === 0 && <div className="text-muted-foreground text-xs">Memuat katalog…</div>}
              {queries.map((q) => (
                <div key={q.id} className="rounded-lg border border-border bg-card/60 p-3">
                  <div className="flex items-center justify-between">
                    <div className="font-medium text-foreground">{q.name}</div>
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{q.category}</span>
                  </div>
                  {q.description && <div className="text-xs text-muted-foreground mt-1">{q.description}</div>}
                  <div className="text-[11px] mt-2 font-mono text-primary/90 break-all">{q.endpoint}</div>
                  <div className="text-[11px] mt-1 text-muted-foreground">
                    <span className="text-foreground/70">datasets:</span> {q.datasets.join(", ")}
                  </div>
                  <div className="text-[11px] mt-1 text-muted-foreground">
                    <span className="text-foreground/70">params:</span> {Object.entries(q.params).map(([k,v]) => `${k}=${v}`).join(" · ")}
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === "trajectory" && (
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-muted-foreground mb-1">Cari kapal (MMSI / IMO / nama)</label>
                <div className="flex gap-2">
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && doSearch()}
                    placeholder="contoh: 525xxxxx atau MV NUSANTARA"
                    className="flex-1 bg-input border border-border rounded-md px-2 py-1.5 outline-none focus:border-primary"
                  />
                  <button
                    onClick={doSearch}
                    disabled={searching}
                    className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50"
                  >
                    {searching ? "…" : "Cari"}
                  </button>
                </div>
              </div>

              {results && (
                <div className="space-y-1.5 max-h-56 overflow-y-auto thin-scroll">
                  {results.length === 0 && <div className="text-xs text-muted-foreground">Tidak ada hasil.</div>}
                  {results.map((v) => {
                    const sel = selected?.vessel_id === v.vessel_id;
                    return (
                      <button
                        key={v.vessel_id}
                        onClick={() => setSelected(v)}
                        className="w-full text-left rounded-lg border p-2 transition"
                        style={{
                          borderColor: sel ? "var(--primary)" : "var(--border)",
                          background: sel ? "color-mix(in oklab, var(--primary) 12%, transparent)" : "transparent",
                        }}
                      >
                        <div className="flex items-center justify-between">
                          <div className="text-sm font-medium">{v.ship_name || "(tanpa nama)"}</div>
                          {v.flag && <div className="text-[10px] text-muted-foreground">🏳 {v.flag}</div>}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          MMSI {v.mmsi || "—"} · IMO {v.imo || "—"}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">Mulai</label>
                  <input type="date" value={start} onChange={(e) => setStart(e.target.value)}
                    className="w-full bg-input border border-border rounded-md px-2 py-1.5 outline-none focus:border-primary" />
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">Selesai</label>
                  <input type="date" value={end} onChange={(e) => setEnd(e.target.value)}
                    className="w-full bg-input border border-border rounded-md px-2 py-1.5 outline-none focus:border-primary" />
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  disabled={!selected}
                  onClick={async () => {
                    if (!selected) return;
                    setSummary("Memuat trajektori…");
                    const r = await fetch(`/api/gfw/track?vessel_id=${encodeURIComponent(selected.vessel_id)}&start_date=${start}&end_date=${end}`);
                    const j = await r.json();
                    if (j?.track) {
                      onPlotTrajectory(selected.vessel_id, start, end, selected.ship_name || selected.vessel_id);
                      setSummary(`✓ ${j.count} titik · sumber ${j.source}`);
                    } else {
                      setSummary(`✗ ${j?.error || "gagal"}`);
                    }
                  }}
                  className="flex-1 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50"
                >
                  Plot Trajectory
                </button>
                <button
                  onClick={() => { onClearTrajectory(); setSummary(""); setSelected(null); setResults(null); setSearch(""); }}
                  className="px-3 py-1.5 rounded-md border border-border text-xs hover:bg-accent"
                >
                  Clear
                </button>
              </div>

              {summary && <div className="text-xs text-muted-foreground">{summary}</div>}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="px-3 py-2 text-xs transition border-b-2"
      style={{
        borderColor: active ? "var(--primary)" : "transparent",
        color: active ? "var(--foreground)" : "var(--muted-foreground)",
      }}
    >
      {children}
    </button>
  );
}