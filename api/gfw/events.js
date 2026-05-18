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

let cache = null;
const TTL = 10 * 60 * 1000;

export default async function handler(req, res) {
  const start = req.query.start_date || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const end   = req.query.end_date   || new Date().toISOString().slice(0, 10);

  if (cache && Date.now() - cache.time < TTL) {
    res.setHeader("x-cache", "HIT");
    res.setHeader("cache-control", "public, max-age=600");
    return res.json(cache.payload);
  }

  const token = process.env.GFW_TOKEN;
  if (!token) return res.status(500).json({ events: [], error: "GFW_TOKEN not configured" });

  try {
    const url = new URL(`${GFW_BASE}/events`);
    url.searchParams.set("limit",  "200");
    url.searchParams.set("offset", "0");
    url.searchParams.set("sort",   "-start");

    console.log(`[gfw] fetching ${start} → ${end} …`);
    const t0 = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);

    const gfwRes = await fetch(url.toString(), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        datasets:    GFW_EVENT_DATASETS,
        startDate:   start.includes("T") ? start : `${start}T00:00:00Z`,
        endDate:     end.includes("T")   ? end   : `${end}T00:00:00Z`,
        vesselTypes: ["FISHING"],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!gfwRes.ok) {
      const text = await gfwRes.text().catch(() => "");
      console.error(`[gfw] error ${gfwRes.status}: ${text.slice(0, 200)}`);
      return res.status(500).json({ events: [], error: `GFW ${gfwRes.status}: ${text.slice(0, 200)}` });
    }

    const json = await gfwRes.json();
    const IDN_LAT = [-11.0, 6.0], IDN_LON = [95.0, 141.0];
    const all  = json?.entries ?? [];
    const data = all.filter(e => {
      const lat = e?.position?.lat ?? e?.lat;
      const lon = e?.position?.lon ?? e?.lon;
      if (lat == null || lon == null) return false;
      return lat >= IDN_LAT[0] && lat <= IDN_LAT[1] && lon >= IDN_LON[0] && lon <= IDN_LON[1];
    });
    console.log(`[gfw] OK — ${data.length}/${all.length} Indonesia events (${Date.now() - t0}ms)`);

    const payload = { events: data };
    cache = { payload, time: Date.now() };
    res.setHeader("x-cache", "MISS");
    res.setHeader("cache-control", "public, max-age=600");
    res.json(payload);
  } catch (e) {
    console.error(`[gfw] catch:`, e?.message);
    res.status(500).json({ events: [], error: e?.message || "events failed" });
  }
}