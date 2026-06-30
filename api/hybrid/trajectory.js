import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { applyRateLimit } from "../_rate-limit.js";

const DEFAULT_MAX_POINTS = 2000;

function json(res, status, payload) {
  res.status(status).json(payload);
}

function asLatLon(coord) {
  if (!Array.isArray(coord) || coord.length < 2) return null;
  const lon = Number(coord[0]);
  const lat = Number(coord[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function samplePoints(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const step = Math.ceil(points.length / maxPoints);
  return points.filter((_, index) => index % step === 0 || index === points.length - 1);
}

function csvSplit(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeMmsi(value) {
  return String(value || "").replace(/[^0-9A-Za-z_-]/g, "_");
}

async function readPrecomputedTrajectory(mmsi, maxPoints) {
  const filePath = path.join(process.cwd(), "data", "hybrid-trajectories", `${safeMmsi(mmsi)}.json`);
  if (!fs.existsSync(filePath)) return null;

  const payload = JSON.parse(await fsp.readFile(filePath, "utf8"));
  const rawTrack = samplePoints(Array.isArray(payload.raw_track) ? payload.raw_track : [], maxPoints);
  const kalmanTrack = samplePoints(Array.isArray(payload.kalman_track) ? payload.kalman_track : [], maxPoints);

  return {
    ...payload,
    count: kalmanTrack.length,
    original_count: payload.original_count ?? payload.point_count ?? kalmanTrack.length,
    point_count: kalmanTrack.length,
    sampled: Boolean(payload.sampled || kalmanTrack.length !== (payload.kalman_track || []).length),
    source: "hybrid-trajectories",
    track: kalmanTrack,
    raw_track: rawTrack,
    kalman_track: kalmanTrack,
  };
}

async function readCsvComparison(mmsi, maxPoints) {
  const filePath = path.join(process.cwd(), "data", "ais_kalman_indonesia.csv");
  if (!fs.existsSync(filePath)) return null;

  const rows = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let headers = null;
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (!headers) {
      headers = csvSplit(line);
      continue;
    }

    const cols = csvSplit(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = cols[i] ?? ""; });
    if (String(row.mmsi || "") !== mmsi) continue;

    const rawLat = toNum(row.raw_lat);
    const rawLon = toNum(row.raw_lon);
    const kalmanLat = toNum(row.kalman_lat);
    const kalmanLon = toNum(row.kalman_lon);
    if (!Number.isFinite(rawLat) || !Number.isFinite(rawLon) || !Number.isFinite(kalmanLat) || !Number.isFinite(kalmanLon)) continue;

    rows.push({
      timestamp: row.time_iso || (row.timestamp ? new Date(Number(row.timestamp) * 1000).toISOString() : ""),
      epoch: Number(row.timestamp || 0),
      raw: { lat: rawLat, lon: rawLon },
      kalman: { lat: kalmanLat, lon: kalmanLon },
      speed: toNum(row.kalman_speed_kn) ?? toNum(row.raw_speed_kn),
      raw_speed: toNum(row.raw_speed_kn),
      kalman_speed: toNum(row.kalman_speed_kn),
      course: toNum(row.kalman_course_deg) ?? toNum(row.raw_course_deg),
      gear: row.gear,
      gear_label: row.gear_label,
      dataset_file: row.dataset_file,
      correction_m: toNum(row.kalman_correction_m),
      implied_speed_kn: toNum(row.kalman_implied_speed_kn),
    });
  }

  rows.sort((a, b) => a.epoch - b.epoch);
  if (!rows.length) return null;

  const sampledRows = samplePoints(rows, maxPoints);
  const rawTrack = sampledRows.map((row) => ({
    ...row.raw,
    timestamp: row.timestamp,
    speed: row.raw_speed,
    course: row.course,
    correction_m: row.correction_m,
    implied_speed_kn: row.implied_speed_kn,
  }));
  const kalmanTrack = sampledRows.map((row) => ({
    ...row.kalman,
    timestamp: row.timestamp,
    speed: row.kalman_speed,
    course: row.course,
    correction_m: row.correction_m,
    implied_speed_kn: row.implied_speed_kn,
  }));

  return {
    mmsi,
    count: kalmanTrack.length,
    original_count: rows.length,
    segment_count: null,
    sampled: sampledRows.length !== rows.length,
    source: "ais_kalman_indonesia.csv",
    gear: rows.find((r) => r.gear)?.gear || null,
    gear_label: rows.find((r) => r.gear_label)?.gear_label || null,
    dataset_file: rows.find((r) => r.dataset_file)?.dataset_file || null,
    track: kalmanTrack,
    raw_track: rawTrack,
    kalman_track: kalmanTrack,
  };
}

async function readGeojsonKalman(mmsi, maxPoints) {
  const filePath = path.join(process.cwd(), "data", "ais_kalman_indonesia_trajectories.geojson");
  const geojson = JSON.parse(await fsp.readFile(filePath, "utf8"));
  const features = (geojson.features || [])
    .filter((feature) => String(feature?.properties?.mmsi || "") === mmsi)
    .sort((a, b) => new Date(a.properties?.start_time || 0) - new Date(b.properties?.start_time || 0));

  const segments = features.map((feature) => {
    const props = feature.properties || {};
    const coords = Array.isArray(feature.geometry?.coordinates) ? feature.geometry.coordinates : [];
    const points = coords.map(asLatLon).filter(Boolean);
    return {
      segment_index: props.segment_index,
      point_count: props.point_count || points.length,
      start_time: props.start_time,
      end_time: props.end_time,
      duration_hours: props.duration_hours,
      distance_km: props.distance_km,
      avg_speed_kn: props.avg_kalman_speed_kn,
      max_speed_kn: props.max_kalman_speed_kn,
      gear: props.gear,
      gear_label: props.gear_label,
      points,
    };
  }).filter((segment) => segment.points.length > 0);

  const allPoints = segments.flatMap((segment) =>
    segment.points.map((point, index) => ({
      ...point,
      timestamp: index === 0 ? segment.start_time : index === segment.points.length - 1 ? segment.end_time : "",
      speed: segment.avg_speed_kn,
      segment_index: segment.segment_index,
    }))
  );

  const track = samplePoints(allPoints, maxPoints);
  return {
    mmsi,
    count: track.length,
    original_count: allPoints.length,
    segment_count: segments.length,
    sampled: track.length !== allPoints.length,
    source: "ais_kalman_indonesia_trajectories.geojson",
    segments: segments.map(({ points, ...meta }) => meta),
    track,
    kalman_track: track,
    raw_track: [],
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { error: "Method not allowed" });
  }

  const allowed = await applyRateLimit(req, res, {
    name: "hybrid-trajectory",
    limit: 60,
    windowSeconds: 10 * 60,
  });
  if (!allowed) return;

  const mmsi = String(req.query?.mmsi || "").trim();
  if (!mmsi) return json(res, 400, { error: "mmsi is required" });

  const maxPoints = Math.max(50, Math.min(5000, Number(req.query?.max_points || DEFAULT_MAX_POINTS)));
  try {
    const precomputed = await readPrecomputedTrajectory(mmsi, maxPoints);
    if (precomputed) return json(res, 200, precomputed);

    const comparison = await readCsvComparison(mmsi, maxPoints);
    return json(res, 200, comparison || await readGeojsonKalman(mmsi, maxPoints));
  } catch (err) {
    return json(res, 500, {
      error: "Hybrid trajectory failed",
      detail: err?.message || "failed to read trajectory geojson",
    });
  }
}
