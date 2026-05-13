import type { TrackPoint, TrackResponse, VesselSearchResult } from "./types";

const GFW_BASE = "https://gateway.api.globalfishingwatch.org/v3";

function authHeaders() {
  const token = process.env.GFW_TOKEN;
  if (!token) throw new Error("GFW_TOKEN is not configured");
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

export async function searchVessels(query: string, limit = 20): Promise<VesselSearchResult[]> {
  const url = new URL(`${GFW_BASE}/vessels/search`);
  url.searchParams.set("query", query);
  url.searchParams.set("limit", String(Math.min(50, Math.max(1, limit))));
  url.searchParams.set("datasets[0]", "public-global-vessel-identity:latest");
  const res = await fetch(url.toString(), { headers: authHeaders() });
  if (!res.ok) throw new Error(`GFW search failed: ${res.status}`);
  const json: any = await res.json();
  const entries: any[] = json?.entries ?? json?.data ?? [];
  return entries.slice(0, limit).map((e: any) => {
    const sd = e?.selfReportedInfo?.[0] ?? e?.registryInfo?.[0] ?? e ?? {};
    return {
      vessel_id: e?.selfReportedInfo?.[0]?.id || e?.id || e?.vesselId || "",
      ship_name: sd?.shipname || e?.shipname || e?.name,
      mmsi: sd?.ssvid || e?.ssvid || e?.mmsi,
      imo: sd?.imo || e?.imo,
      flag: sd?.flag || e?.flag,
      callsign: sd?.callsign || e?.callsign,
    } as VesselSearchResult;
  }).filter(v => v.vessel_id);
}

function computeBounds(track: TrackPoint[]): TrackResponse["bounds"] {
  if (!track.length) return null;
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const p of track) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  return [[minLat, minLon], [maxLat, maxLon]];
}

export async function getTrack(vesselId: string, startDate: string, endDate: string): Promise<TrackResponse> {
  // Try /vessels/{id}/tracks first
  const tracksUrl = new URL(`${GFW_BASE}/vessels/${encodeURIComponent(vesselId)}/tracks`);
  tracksUrl.searchParams.set("start-date", startDate);
  tracksUrl.searchParams.set("end-date", endDate);
  tracksUrl.searchParams.set("datasets[0]", "public-global-fishing-tracks:latest");
  tracksUrl.searchParams.set("format", "POINT");

  let track: TrackPoint[] = [];
  let source = "tracks";
  const res = await fetch(tracksUrl.toString(), { headers: authHeaders() });

  if (res.ok) {
    const json: any = await res.json();
    const entries: any[] = json?.entries ?? json?.features ?? json?.data ?? [];
    track = entries.map((e: any) => {
      const lat = e?.lat ?? e?.latitude ?? e?.geometry?.coordinates?.[1];
      const lon = e?.lon ?? e?.longitude ?? e?.geometry?.coordinates?.[0];
      return {
        lat: Number(lat),
        lon: Number(lon),
        timestamp: e?.timestamp ?? e?.properties?.timestamp,
        speed: e?.speed ?? e?.properties?.speed,
        course: e?.course ?? e?.properties?.course,
      };
    }).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  } else if (res.status === 404) {
    // Fallback to events
    source = "events";
    const eventsRes = await fetch(`${GFW_BASE}/events`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        datasets: ["public-global-fishing-events:latest"],
        vessels: [vesselId],
        "start-date": startDate,
        "end-date": endDate,
      }),
    });
    if (eventsRes.ok) {
      const j: any = await eventsRes.json();
      const entries: any[] = j?.entries ?? [];
      track = entries.map((e: any) => ({
        lat: Number(e?.position?.lat),
        lon: Number(e?.position?.lon),
        timestamp: e?.start,
      })).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    }
  } else {
    throw new Error(`GFW track failed: ${res.status}`);
  }

  return {
    vessel_id: vesselId,
    start_date: startDate,
    end_date: endDate,
    source,
    count: track.length,
    bounds: computeBounds(track),
    track,
  };
}

// Fetch fishing/encounter/loitering events for Indonesian waters
export async function getIndonesianEvents(startDate: string, endDate: string) {
  const datasets = [
    "public-global-fishing-events:latest",
    "public-global-encounters-events:latest",
    "public-global-loitering-events:latest",
  ];
  // Indonesia bounding polygon (95E-141E, 11S-6N)
  const geom = {
    type: "Polygon",
    coordinates: [[
      [95, -11], [141, -11], [141, 6], [95, 6], [95, -11],
    ]],
  };
  const all: any[] = [];
  for (const ds of datasets) {
    try {
      const res = await fetch(`${GFW_BASE}/events`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          datasets: [ds],
          "start-date": startDate,
          "end-date": endDate,
          geometry: geom,
          limit: 1000,
        }),
      });
      if (res.ok) {
        const j: any = await res.json();
        const entries: any[] = j?.entries ?? [];
        all.push(...entries);
      }
    } catch (e) {
      console.error(`GFW events ${ds} failed`, e);
    }
  }
  return all;
}