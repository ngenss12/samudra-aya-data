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
  const start = req.query.start_date || "2012-01-01";
  const end = req.query.end_date || new Date().toISOString().slice(0, 10);

  if (cache && Date.now() - cache.time < TTL) {
    res.setHeader("x-cache", "HIT");
    res.setHeader("cache-control", "public, max-age=600");
    return res.json(cache.payload);
  }

  const token = process.env.GFW_TOKEN;
  if (!token) return res.status(500).json({ events: [], error: "GFW_TOKEN not configured" });

  try {
    const url = new URL(`${GFW_BASE}/events`);
    url.searchParams.set("limit", "200");
    url.searchParams.set("offset", "0");
    url.searchParams.set("sort", "-start");

    const gfwRes = await fetch(url.toString(), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        datasets: GFW_EVENT_DATASETS,
        startDate: start.includes("T") ? start : `${start}T00:00:00Z`,
        endDate: end.includes("T") ? end : `${end}T00:00:00Z`,
        geometry: INDONESIA_POLY,
        vesselTypes: ["FISHING"],
      }),
    });

    if (!gfwRes.ok) {
      const text = await gfwRes.text().catch(() => "");
      return res.status(500).json({ events: [], error: `GFW ${gfwRes.status}: ${text.slice(0, 200)}` });
    }

    const json = await gfwRes.json();
    const raw = json?.entries ?? [];

    const events = raw.map((e) => {
      const startT = e?.start ? new Date(e.start).getTime() : 0;
      const endT = e?.end ? new Date(e.end).getTime() : 0;
      const dur = startT && endT ? (endT - startT) / 3600000 : undefined;
      return {
        id: e?.id || `${e?.vessel?.id}-${e?.start}`,
        type: (e?.type || "").toUpperCase(),
        start: e?.start,
        end: e?.end,
        durationHours: dur,
        lat: Number(e?.position?.lat),
        lon: Number(e?.position?.lon),
        vesselId: e?.vessel?.id,
        mmsi: e?.vessel?.ssvid,
        flag: e?.vessel?.flag,
        shipName: e?.vessel?.name,
      };
    }).filter((ev) => Number.isFinite(ev.lat) && Number.isFinite(ev.lon));

    const payload = { events };
    cache = { payload, time: Date.now() };
    res.setHeader("x-cache", "MISS");
    res.setHeader("cache-control", "public, max-age=600");
    res.json(payload);
  } catch (e) {
    res.status(500).json({ events: [], error: e?.message || "events failed" });
  }
}
