import fs from "node:fs/promises";
import path from "node:path";
import { applyRateLimit } from "../_rate-limit.js";

const DEFAULT_LIMIT = 200;

function json(res, status, payload) {
  res.status(status).json(payload);
}

function parseBbox(value) {
  if (!value) return null;
  const nums = String(value).split(",").map((v) => Number(v.trim()));
  if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) return null;
  const [minLon, minLat, maxLon, maxLat] = nums;
  return { minLon, minLat, maxLon, maxLat };
}

function inBbox(event, bbox) {
  if (!bbox) return true;
  return event.lon >= bbox.minLon && event.lon <= bbox.maxLon && event.lat >= bbox.minLat && event.lat <= bbox.maxLat;
}

function normalizeEvent(raw, index) {
  const lat = Number(raw.lat ?? raw.position?.lat ?? raw.sar?.lat);
  const lon = Number(raw.lon ?? raw.position?.lon ?? raw.sar?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const type = String(raw.type || raw.event_type || "OTHER").toUpperCase();
  const vessel = raw.vessel || {};
  const evidence = raw.evidence || {};

  return {
    id: String(raw.id || `hybrid-${index + 1}`),
    source: "hybrid",
    type,
    severity: String(raw.severity || "MEDIUM").toUpperCase(),
    lat,
    lon,
    mmsi: raw.mmsi ?? vessel.mmsi ?? null,
    name: raw.name || raw.vessel_name || vessel.name || "Unknown",
    flag: raw.flag || vessel.flag || null,
    detectedAt: raw.detectedAt || raw.detected_at || raw.createdAt || raw.timestamp || new Date().toISOString(),
    reason: raw.reason || evidence.reason || "Precomputed hybrid event",
    confidence: Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : null,
    method: raw.method || raw.detector || "rule_precompute",
    dataset: raw.dataset || raw.source_dataset || null,
    evidence,
  };
}

async function readPrecomputedEvents() {
  const configured = process.env.HYBRID_EVENTS_PATH || "";
  const filePath = configured
    ? path.resolve(configured)
    : path.join(process.cwd(), "data", "hybrid-events.json");

  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const events = Array.isArray(parsed) ? parsed : parsed.events;
    if (!Array.isArray(events)) throw new Error("hybrid events JSON must be an array or { events: [] }");
    return {
      source: configured ? "HYBRID_EVENTS_PATH" : "data/hybrid-events.json",
      demo: false,
      events,
    };
  } catch (err) {
    if (err?.code !== "ENOENT") console.warn("[hybrid] failed to read precomputed events:", err?.message || err);
    return {
      source: configured ? "HYBRID_EVENTS_PATH" : "fallback-demo",
      demo: true,
      events: fallbackEvents(),
    };
  }
}

function fallbackEvents() {
  const now = Date.now();
  return [
    {
      id: "hybrid-demo-godark-001",
      type: "GO_DARK",
      severity: "HIGH",
      lat: -5.42,
      lon: 106.82,
      mmsi: "525100901",
      name: "Demo Dark Vessel",
      detectedAt: new Date(now - 45 * 60_000).toISOString(),
      reason: "AIS gap 8.7 jam setelah aktivitas lambat di area pengawasan.",
      confidence: 0.86,
      method: "ais_gap_rule",
      dataset: "demo_precomputed",
      evidence: { gapHours: 8.7, lastSpeedKnots: 3.1 },
    },
    {
      id: "hybrid-demo-spoofing-001",
      type: "SPOOFING",
      severity: "HIGH",
      lat: -2.68,
      lon: 111.94,
      mmsi: "525200447",
      name: "Demo Spoofing Candidate",
      detectedAt: new Date(now - 82 * 60_000).toISOString(),
      reason: "Loncatan posisi menghasilkan implied speed 93 knot.",
      confidence: 0.79,
      method: "implied_speed_rule",
      dataset: "demo_precomputed",
      evidence: { impliedSpeedKnots: 93, jumpKm: 74 },
    },
    {
      id: "hybrid-demo-trawler-001",
      type: "TRAWLER_ACTIVITY",
      severity: "MEDIUM",
      lat: 3.25,
      lon: 99.38,
      mmsi: "525300612",
      name: "Demo Trawler Pattern",
      detectedAt: new Date(now - 130 * 60_000).toISOString(),
      reason: "Kecepatan 2-5 knot dengan pola lintasan berulang.",
      confidence: 0.72,
      method: "speed_turn_pattern_rule",
      dataset: "demo_precomputed",
      evidence: { avgSpeedKnots: 3.8, durationHours: 2.4 },
    },
    {
      id: "hybrid-demo-group-001",
      type: "GROUP_ACTIVITY",
      severity: "MEDIUM",
      lat: -6.95,
      lon: 112.65,
      mmsi: null,
      name: "Demo Vessel Group",
      detectedAt: new Date(now - 3 * 60 * 60_000).toISOString(),
      reason: "Empat kapal berada dalam radius 4.2 km pada rentang waktu berdekatan.",
      confidence: 0.68,
      method: "spatiotemporal_cluster_rule",
      dataset: "demo_precomputed",
      evidence: { vesselCount: 4, radiusKm: 4.2, windowMinutes: 24 },
    },
  ];
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { error: "Method not allowed" });
  }

  const ok = await applyRateLimit(req, res, {
    name: "hybrid-events",
    limit: 60,
    windowSeconds: 60,
  });
  if (!ok) return;

  const { type, severity, bbox } = req.query || {};
  const limit = Math.min(DEFAULT_LIMIT, Math.max(1, Number(req.query?.limit || DEFAULT_LIMIT)));
  const bboxObj = parseBbox(bbox);

  const loaded = await readPrecomputedEvents();
  let events = loaded.events
    .map(normalizeEvent)
    .filter(Boolean)
    .filter((event) => !type || event.type === String(type).toUpperCase())
    .filter((event) => !severity || event.severity === String(severity).toUpperCase())
    .filter((event) => inBbox(event, bboxObj))
    .sort((a, b) => new Date(b.detectedAt) - new Date(a.detectedAt))
    .slice(0, limit);

  json(res, 200, {
    events,
    count: events.length,
    source: loaded.source,
    demo: loaded.demo,
    generatedAt: new Date().toISOString(),
    note: loaded.demo
      ? "No precomputed hybrid event file found. Set HYBRID_EVENTS_PATH or create data/hybrid-events.json."
      : "Loaded precomputed hybrid events.",
  });
}
