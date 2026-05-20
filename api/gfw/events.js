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
const MAX_EVENTS = 200;

function toIsoDate(date) {
  return date.includes("T") ? date : `${date}T00:00:00Z`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function toDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function splitDateRange(start, end, chunkDays = 14) {
  const chunks = [];
  let cursor = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);

  while (cursor <= endDate) {
    const chunkStart = toDateOnly(cursor);
    const chunkEndDate = addDays(cursor, chunkDays);
    const chunkEnd = toDateOnly(chunkEndDate < endDate ? chunkEndDate : endDate);
    chunks.push([chunkStart, chunkEnd]);
    cursor = addDays(new Date(`${chunkEnd}T00:00:00Z`), 1);
  }
  return chunks;
}

function dedupeEvents(events) {
  const seen = new Set();
  const out = [];
  for (const ev of events) {
    const vesselId = ev?.vessel?.id || ev?.vessel?.ssvid || "";
    const key = ev?.id || `${vesselId}:${ev?.start || ""}:${ev?.position?.lat || ""}:${ev?.position?.lon || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ev);
  }
  return out;
}

function cacheKey(start, end) {
  return `gfw:events:idn:v2:${start}:${end}:fishing-encounter-loitering`;
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

async function fetchEventsChunk(token, start, end) {
  const url = new URL(`${GFW_BASE}/events`);
  url.searchParams.set("limit", "200");
  url.searchParams.set("offset", "0");
  url.searchParams.set("sort", "-start");

  const body = JSON.stringify({
    datasets: GFW_EVENT_DATASETS,
    startDate: toIsoDate(start),
    endDate: toIsoDate(end),
    geometry: INDONESIA_POLY,
    vesselTypes: ["FISHING"],
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const gfwRes = await fetch(url.toString(), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body,
    });

    if (gfwRes.ok) {
      const json = await gfwRes.json();
      return json?.entries ?? [];
    }

    const text = await gfwRes.text().catch(() => "");
    console.error(`[gfw] error ${gfwRes.status} (${start} -> ${end}): ${text.slice(0, 200)}`);
    if (![429, 500, 502, 503, 504, 524].includes(gfwRes.status) || attempt === 2) {
      throw new Error(`GFW ${gfwRes.status}: ${text.slice(0, 200)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
  }
  return [];
}

export default async function handler(req, res) {
  const start = req.query.start_date || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const end = req.query.end_date || new Date().toISOString().slice(0, 10);

  const allowed = await applyRateLimit(req, res, {
    name: "gfw-events",
    limit: 20,
    windowSeconds: 10 * 60,
  });
  if (!allowed) return;

  const key = cacheKey(start, end);
  const cached = await cacheGet(key);
  if (isFresh(cached)) {
    res.setHeader("x-cache", "HIT");
    res.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=600");
    res.setHeader("x-data-fetched-at", new Date(cached.fetchedAt).toISOString());
    return res.json(cached.payload);
  }

  const token = process.env.GFW_TOKEN;
  if (!token) return res.status(500).json({ events: [], error: "GFW_TOKEN not configured" });

  try {
    console.log(`[gfw] fetching ${start} -> ${end} ...`);
    const t0 = Date.now();

    const chunks = splitDateRange(start, end);
    const events = [];
    for (const [chunkStart, chunkEnd] of chunks) {
      const chunkEvents = await fetchEventsChunk(token, chunkStart, chunkEnd);
      events.push(...chunkEvents);
      if (dedupeEvents(events).length >= MAX_EVENTS) break;
    }

    const data = dedupeEvents(events)
      .sort((a, b) => new Date(b.start || 0) - new Date(a.start || 0))
      .slice(0, MAX_EVENTS);
    console.log(`[gfw] OK - ${data.length} events (${Date.now() - t0}ms)`);

    const payload = { events: data };
    await cacheSet(key, cacheEnvelope(payload), STALE_TTL_SECONDS);
    res.setHeader("x-cache", "MISS");
    res.setHeader("cache-control", "public, max-age=60, stale-while-revalidate=600");
    res.json(payload);
  } catch (e) {
    console.error("[gfw] catch:", e?.message);
    if (cached?.payload) {
      res.setHeader("x-cache", "STALE");
      res.setHeader("cache-control", "public, max-age=30, stale-while-revalidate=600");
      res.setHeader("x-data-fetched-at", new Date(cached.fetchedAt).toISOString());
      return res.json({
        ...cached.payload,
        warning: "Serving stale GFW data because live fetch failed",
      });
    }
    res.status(500).json({ events: [], error: e?.message || "events failed" });
  }
}
