import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const root = process.cwd();
const inputCsv = path.join(root, "data", "ais_kalman_indonesia.csv");
const outputDir = path.join(root, "data", "hybrid-trajectories");
const indexPath = path.join(outputDir, "index.json");
const maxPointsPerVessel = Number(process.env.HYBRID_TRAJECTORY_MAX_POINTS || 2000);

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

function sampleRows(rows, maxPoints) {
  if (rows.length <= maxPoints) return rows;
  const step = Math.ceil(rows.length / maxPoints);
  return rows.filter((_, index) => index % step === 0 || index === rows.length - 1);
}

function safeMmsi(value) {
  return String(value || "").replace(/[^0-9A-Za-z_-]/g, "_");
}

function buildPayload(mmsi, rows) {
  rows.sort((a, b) => a.epoch - b.epoch);
  const sampledRows = sampleRows(rows, maxPointsPerVessel);
  const first = rows.find((row) => row.gear || row.gear_label || row.dataset_file) || rows[0] || {};

  const rawTrack = sampledRows.map((row) => ({
    timestamp: row.timestamp,
    lat: row.raw_lat,
    lon: row.raw_lon,
    speed: row.raw_speed,
    course: row.course,
  }));

  const kalmanTrack = sampledRows.map((row) => ({
    timestamp: row.timestamp,
    lat: row.kalman_lat,
    lon: row.kalman_lon,
    speed: row.kalman_speed,
    course: row.course,
    correction_m: row.correction_m,
    implied_speed_kn: row.implied_speed_kn,
  }));

  return {
    mmsi,
    source: "ais_kalman_indonesia.csv",
    gear: first.gear || null,
    gear_label: first.gear_label || null,
    dataset_file: first.dataset_file || null,
    point_count: kalmanTrack.length,
    original_count: rows.length,
    sampled: sampledRows.length !== rows.length,
    start_time: rows[0]?.timestamp || null,
    end_time: rows[rows.length - 1]?.timestamp || null,
    raw_track: rawTrack,
    kalman_track: kalmanTrack,
  };
}

async function main() {
  if (!fs.existsSync(inputCsv)) throw new Error(`Missing input CSV: ${inputCsv}`);
  await fsp.mkdir(outputDir, { recursive: true });

  const byMmsi = new Map();
  const rl = readline.createInterface({
    input: fs.createReadStream(inputCsv, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let headers = null;
  let rowsRead = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (!headers) {
      headers = csvSplit(line);
      continue;
    }

    const cols = csvSplit(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = cols[i] ?? ""; });

    const mmsi = String(row.mmsi || "").trim();
    const rawLat = toNum(row.raw_lat);
    const rawLon = toNum(row.raw_lon);
    const kalmanLat = toNum(row.kalman_lat);
    const kalmanLon = toNum(row.kalman_lon);
    if (!mmsi || ![rawLat, rawLon, kalmanLat, kalmanLon].every(Number.isFinite)) continue;

    const item = {
      epoch: Number(row.timestamp || 0),
      timestamp: row.time_iso || (row.timestamp ? new Date(Number(row.timestamp) * 1000).toISOString() : ""),
      raw_lat: rawLat,
      raw_lon: rawLon,
      kalman_lat: kalmanLat,
      kalman_lon: kalmanLon,
      raw_speed: toNum(row.raw_speed_kn),
      kalman_speed: toNum(row.kalman_speed_kn),
      course: toNum(row.kalman_course_deg) ?? toNum(row.raw_course_deg),
      gear: row.gear || "",
      gear_label: row.gear_label || "",
      dataset_file: row.dataset_file || "",
      correction_m: toNum(row.kalman_correction_m),
      implied_speed_kn: toNum(row.kalman_implied_speed_kn),
    };

    if (!byMmsi.has(mmsi)) byMmsi.set(mmsi, []);
    byMmsi.get(mmsi).push(item);
    rowsRead++;
  }

  const index = {
    generatedAt: new Date().toISOString(),
    source: "data/ais_kalman_indonesia.csv",
    maxPointsPerVessel,
    vesselCount: byMmsi.size,
    rowsRead,
    vessels: [],
  };

  for (const [mmsi, rows] of byMmsi) {
    const payload = buildPayload(mmsi, rows);
    const file = `${safeMmsi(mmsi)}.json`;
    await fsp.writeFile(path.join(outputDir, file), `${JSON.stringify(payload)}\n`, "utf8");
    index.vessels.push({
      mmsi,
      file,
      point_count: payload.point_count,
      original_count: payload.original_count,
      sampled: payload.sampled,
      start_time: payload.start_time,
      end_time: payload.end_time,
      gear: payload.gear,
      gear_label: payload.gear_label,
    });
  }

  index.vessels.sort((a, b) => String(a.mmsi).localeCompare(String(b.mmsi)));
  await fsp.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  console.log(`Wrote ${byMmsi.size} trajectory files to ${path.relative(root, outputDir)}`);
  console.log(`Rows read: ${rowsRead}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
