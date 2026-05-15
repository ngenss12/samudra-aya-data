const GFW_BASE = "https://gateway.api.globalfishingwatch.org/v3";
const GFW_IDENTITY_DATASET = "public-global-vessel-identity:latest";

export default async function handler(req, res) {
  const query = (req.query.query || "").trim();
  const limit = Math.min(50, Number(req.query.limit || "20"));

  if (!query) return res.json({ entries: [] });

  const token = process.env.GFW_TOKEN;
  if (!token) return res.status(500).json({ entries: [], error: "GFW_TOKEN not configured" });

  try {
    const url = new URL(`${GFW_BASE}/vessels/search`);
    url.searchParams.set("query", query);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("datasets[0]", GFW_IDENTITY_DATASET);
    url.searchParams.set("includes[0]", "MATCH_CRITERIA");
    url.searchParams.set("includes[1]", "OWNERSHIP");

    const gfwRes = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });

    if (!gfwRes.ok) throw new Error(`GFW search failed: ${gfwRes.status}`);

    const json = await gfwRes.json();
    const raw = json?.entries ?? json?.data ?? [];

    const entries = raw.slice(0, limit).map((e) => {
      const sd = e?.selfReportedInfo?.[0] ?? e?.registryInfo?.[0] ?? e ?? {};
      return {
        vessel_id: e?.selfReportedInfo?.[0]?.id || e?.id || e?.vesselId || "",
        ship_name: sd?.shipname || sd?.shipName || e?.shipname || e?.name,
        mmsi: sd?.ssvid || e?.ssvid || e?.mmsi,
        imo: sd?.imo || e?.imo,
        flag: sd?.flag || e?.flag,
        callsign: sd?.callsign || e?.callsign,
      };
    }).filter((v) => v.vessel_id);

    res.json({ entries });
  } catch (e) {
    res.status(500).json({ entries: [], error: e?.message || "search failed" });
  }
}
