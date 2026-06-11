import { cacheGet, cacheSet } from "../_redis.js";
import { applyRateLimit } from "../_rate-limit.js";

const GFW_BASE = "https://gateway.api.globalfishingwatch.org/v3";
const GFW_EVENT_DATASETS = [
  "public-global-fishing-events:latest",
  "public-global-encounters-events:latest",
  "public-global-loitering-events:latest",
];
const INDONESIA_POLY = {
  type: "Polygon",
  coordinates: [[[95.0, -11.0], [141.0, -11.0], [141.0, 6.0], [95.0, 6.0], [95.0, -11.0]]],
};

const FRESH_TTL_SECONDS = 10 * 60;
const STALE_TTL_SECONDS = 6 * 60 * 60;
const REFRESHING_TTL_SECONDS = 2 * 60;
const MAX_EVENTS = 200;

function toIsoDate(date) {
  return date.includes("T") ? date : `${date}T00:00:00Z`;
}

function cacheKey(start, end) {
  return `gfw:events:idn:v2:${start}:${end}:fishing-encounter-loitering`;
}

function refreshingKey(start, end) {
  return `gfw:events:idn:refreshing:${start}:${end}`;
}

function cacheEnvelope(payload) {
  return {
    payload,
    fetchedAt: Date.now(),
  };
}

function isFresh(entry) {
  return entry?.payload && Date.now() - Number(entry.fetchedAt || 0) < FRESH_TTL_SECONDS * 1000;
}

function publicPayload(entry, extra = {}) {
  return {
    ...entry.payload,
    ...extra,
    events: (entry.payload.events || []).slice(0, MAX_EVENTS),
    fetched_at: new Date(entry.fetchedAt).toISOString(),
  };
}

async function fetchGfwEvents(start, end) {
  const token = process.env.GFW_TOKEN;
  if (!token) throw new Error("GFW_TOKEN not configured");

  const url = new URL(`${GFW_BASE}/events`);
  url.searchParams.set("limit", "200");
  url.searchParams.set("offset", "0");
  url.searchParams.set("sort", "-start");

  console.log(`[gfw] fetching ${start} -> ${end} ...`);
  const t0 = Date.now();

  const gfwRes = await fetch(url.toString(), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      datasets: GFW_EVENT_DATASETS,
      startDate: toIsoDate(start),
      endDate: toIsoDate(end),
      geometry: INDONESIA_POLY,
      vesselTypes: ["FISHING"],
    }),
  });

  if (!gfwRes.ok) {
    const text = await gfwRes.text().catch(() => "");
    console.error(`[gfw] error ${gfwRes.status}: ${text.slice(0, 200)}`);
    throw new Error(`GFW ${gfwRes.status}: ${text.slice(0, 200)}`);
  }

  const json = await gfwRes.json();
  const data = (json?.entries ?? []).slice(0, MAX_EVENTS);
  console.log(`[gfw] OK - ${data.length} events (${Date.now() - t0}ms)`);
  return { events: data };
}

export async function refreshGfwEvents(start, end) {
  const key = cacheKey(start, end);
  const lockKey = refreshingKey(start, end);
  const refreshing = await cacheGet(lockKey);
  if (refreshing) {
    const cached = await cacheGet(key);
    return { refreshed: false, skipped: "refresh already running", cached };
  }

  await cacheSet(lockKey, { startedAt: Date.now() }, REFRESHING_TTL_SECONDS);
  const payload = await fetchGfwEvents(start, end);
  const entry = cacheEnvelope(payload);
  await cacheSet(key, entry, STALE_TTL_SECONDS);
  return { refreshed: true, cached: entry };
}

export function defaultRange() {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 30);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

export default async function handler(req, res) {
  const range = defaultRange();
  const start = req.query.start_date || range.start;
  const end = req.query.end_date || range.end;
  const forceRefresh = req.query.refresh === "1" || req.query.refresh === "true";

  const key = cacheKey(start, end);
  const cached = await cacheGet(key);
  if (cached?.payload && !forceRefresh) {
    const fresh = isFresh(cached);
    res.setHeader("x-cache", fresh ? "HIT" : "STALE");
    res.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=600");
    res.setHeader("x-data-fetched-at", new Date(cached.fetchedAt).toISOString());
    return res.json(publicPayload(cached, fresh ? {} : { warning: "Serving cached GFW data while server refreshes" }));
  }

  const allowed = await applyRateLimit(req, res, {
    name: "gfw-events",
    limit: 20,
    windowSeconds: 10 * 60,
  });
  if (!allowed) return;

  try {
    const { cached: refreshed } = await refreshGfwEvents(start, end);
    res.setHeader("x-cache", "MISS");
    res.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=600");
    res.setHeader("x-data-fetched-at", new Date(refreshed.fetchedAt).toISOString());
    res.json(publicPayload(refreshed));
  } catch (e) {
    console.error("[gfw] catch:", e?.message);
    if (cached?.payload) {
      res.setHeader("x-cache", "STALE");
      res.setHeader("cache-control", "public, max-age=30, stale-while-revalidate=600");
      res.setHeader("x-data-fetched-at", new Date(cached.fetchedAt).toISOString());
      return res.json(publicPayload(cached, { warning: "Serving stale GFW data because live fetch failed" }));
    }
    res.status(500).json({ events: [], error: e?.message || "events failed" });
  }
}
