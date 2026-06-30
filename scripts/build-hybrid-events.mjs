import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const root = process.cwd();
const dataDir = path.join(root, "data");
const kalmanCsv = path.join(dataDir, "ais_kalman_indonesia.csv");
const sarMatchesPath = path.join(dataDir, "ais_sar_matches.json");
const patchIndexPath = path.join(dataDir, "sar_patches", "patch_index.csv");
const outputPath = path.join(dataDir, "hybrid-events.json");

const GO_DARK_GAP_HOURS = Number(process.env.HYBRID_GO_DARK_GAP_HOURS || 6);
const SPOOFING_SPEED_KN = Number(process.env.HYBRID_SPOOFING_SPEED_KN || 60);
const TRAWLER_MIN_POINTS = Number(process.env.HYBRID_TRAWLER_MIN_POINTS || 20);
const MAX_EVENTS = Number(process.env.HYBRID_MAX_EVENTS || 200);

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

function confidence(value, min, max) {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0.45, Math.min(0.98, (value - min) / (max - min)));
}

function eventBase({ id, type, severity, point, reason, confidence: conf, method, evidence }) {
  return {
    id,
    type,
    severity,
    lat: point.lat,
    lon: point.lon,
    mmsi: point.mmsi,
    name: point.name || `${point.gearLabel || "Vessel"} ${point.mmsi}`,
    detectedAt: point.timeIso || new Date(point.timestamp * 1000).toISOString(),
    reason,
    confidence: Number(conf.toFixed(3)),
    method,
    dataset: point.datasetFile || "ais_kalman_indonesia.csv",
    evidence,
  };
}

function makePoint(row) {
  const lat = toNum(row.kalman_lat) ?? toNum(row.raw_lat);
  const lon = toNum(row.kalman_lon) ?? toNum(row.raw_lon);
  const timestamp = toNum(row.timestamp);
  if (!row.mmsi || !timestamp || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    mmsi: String(row.mmsi),
    timestamp,
    timeIso: row.time_iso,
    lat,
    lon,
    rawSpeedKn: toNum(row.raw_speed_kn),
    kalmanSpeedKn: toNum(row.kalman_speed_kn),
    kalmanJumpM: toNum(row.kalman_jump_m),
    kalmanImpliedSpeedKn: toNum(row.kalman_implied_speed_kn),
    kalmanCorrectionM: toNum(row.kalman_correction_m),
    gear: row.gear || "",
    gearLabel: row.gear_label || "",
    datasetFile: row.dataset_file || "",
    source: row.source || "",
  };
}

function pushTop(list, item, score, limit) {
  list.push({ item, score });
  list.sort((a, b) => b.score - a.score);
  if (list.length > limit) list.length = limit;
}

async function scanKalmanEvents() {
  if (!fs.existsSync(kalmanCsv)) throw new Error(`Missing ${kalmanCsv}`);

  const goDark = [];
  const spoofing = [];
  const trawlers = new Map();
  const byMmsiLast = new Map();

  const rl = readline.createInterface({
    input: fs.createReadStream(kalmanCsv, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let headers = null;
  let rows = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    if (!headers) {
      headers = csvSplit(line);
      continue;
    }

    const cols = csvSplit(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = cols[i] ?? ""; });
    const point = makePoint(row);
    if (!point) continue;
    rows++;

    const last = byMmsiLast.get(point.mmsi);
    if (last) {
      const gapHours = (point.timestamp - last.timestamp) / 3600;
      if (gapHours >= GO_DARK_GAP_HOURS) {
        const severity = gapHours >= 24 ? "HIGH" : "MEDIUM";
        const conf = confidence(gapHours, GO_DARK_GAP_HOURS, 48);
        pushTop(goDark, eventBase({
          id: `godark-${point.mmsi}-${Math.round(last.timestamp)}`,
          type: "GO_DARK",
          severity,
          point: last,
          reason: `AIS gap ${gapHours.toFixed(1)} jam sebelum sinyal berikutnya muncul.`,
          confidence: conf,
          method: "ais_gap_rule",
          evidence: {
            gapHours: Number(gapHours.toFixed(2)),
            nextSeenAt: point.timeIso,
            lastSpeedKnots: last.kalmanSpeedKn ?? last.rawSpeedKn,
            gear: last.gear,
          },
        }), gapHours, 60);
      }

      const dtHours = Math.max(0.0001, (point.timestamp - last.timestamp) / 3600);
      const implied = point.kalmanImpliedSpeedKn || 0;
      if (implied >= SPOOFING_SPEED_KN && dtHours <= 6) {
        const conf = confidence(implied, SPOOFING_SPEED_KN, 120);
        pushTop(spoofing, eventBase({
          id: `spoofing-${point.mmsi}-${Math.round(point.timestamp)}`,
          type: "SPOOFING",
          severity: implied >= 90 ? "HIGH" : "MEDIUM",
          point,
          reason: `Loncatan Kalman menghasilkan implied speed ${implied.toFixed(1)} knot.`,
          confidence: conf,
          method: "implied_speed_rule",
          evidence: {
            impliedSpeedKnots: Number(implied.toFixed(2)),
            deltaHours: Number(dtHours.toFixed(2)),
            jumpMeters: point.kalmanJumpM,
            correctionMeters: point.kalmanCorrectionM,
          },
        }), implied, 50);
      }
    }

    const speed = point.kalmanSpeedKn ?? point.rawSpeedKn;
    const trawlerLike = /trawler/i.test(point.gear) || /trawler/i.test(point.datasetFile);
    if (trawlerLike) {
      const stat = trawlers.get(point.mmsi) || {
        mmsi: point.mmsi,
        count: 0,
        slowCount: 0,
        first: point,
        last: point,
        sumSpeed: 0,
      };
      stat.count++;
      if (Number.isFinite(speed)) {
        stat.slowCount++;
        stat.sumSpeed += speed;
      }
      stat.last = point;
      trawlers.set(point.mmsi, stat);
    }

    byMmsiLast.set(point.mmsi, point);
  }

  const trawlerEvents = [...trawlers.values()]
    .filter((s) => s.count >= TRAWLER_MIN_POINTS)
    .map((s) => {
      const avgSpeed = s.slowCount ? s.sumSpeed / s.slowCount : null;
      const durationHours = Math.max(0, (s.last.timestamp - s.first.timestamp) / 3600);
      const score = s.count * Math.max(1, durationHours);
      return {
        score,
        item: eventBase({
          id: `trawler-${s.mmsi}-${Math.round(s.last.timestamp)}`,
          type: "TRAWLER_ACTIVITY",
          severity: s.count >= 80 ? "HIGH" : "MEDIUM",
          point: s.last,
          reason: `Terdeteksi ${s.count} titik trawler/low-speed dalam lintasan AIS Kalman.`,
          confidence: Math.min(0.95, 0.55 + Math.log10(Math.max(1, s.count)) / 3),
          method: "speed_gear_pattern_rule",
          evidence: {
            pointCount: s.count,
            avgSpeedKnots: avgSpeed == null ? null : Number(avgSpeed.toFixed(2)),
            durationHours: Number(durationHours.toFixed(2)),
            gear: s.last.gear,
          },
        }),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 50);

  return {
    rows,
    events: [...goDark, ...spoofing, ...trawlerEvents].map((x) => x.item),
    counts: {
      goDark: goDark.length,
      spoofing: spoofing.length,
      trawler: trawlerEvents.length,
    },
  };
}

function normalizePatchPath(value) {
  if (!value) return null;
  const name = path.basename(String(value).replaceAll("\\", "/"));
  return `/data/sar_patches/${name}`;
}

async function readSarPatchEvents() {
  if (!fs.existsSync(patchIndexPath)) return [];
  const text = await fsp.readFile(patchIndexPath, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = csvSplit(lines[0]);
  const events = [];

  for (const line of lines.slice(1)) {
    const cols = csvSplit(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = cols[i] ?? ""; });
    const lat = toNum(row.crop_lat) ?? toNum(row.kalman_lat) ?? toNum(row.ais_lat);
    const lon = toNum(row.crop_lon) ?? toNum(row.kalman_lon) ?? toNum(row.ais_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const mmsi = row.mmsi || null;
    events.push({
      id: `sar-patch-${mmsi || "unknown"}-${events.length + 1}`,
      type: row.source === "false_positives" ? "SAR_NO_AIS" : "AIS_SAR_MATCH",
      severity: row.source === "false_positives" ? "MEDIUM" : "LOW",
      lat,
      lon,
      mmsi,
      name: `${row.gear_label || "SAR"} patch ${mmsi || ""}`.trim(),
      detectedAt: row.scene_time || row.ais_time || new Date().toISOString(),
      reason: row.source === "false_positives"
        ? "Patch SAR tercatat sebagai kandidat tanpa pasangan AIS yang kuat."
        : "Patch SAR memiliki pasangan AIS/Kalman.",
      confidence: 0.62,
      method: "sar_patch_index",
      dataset: "sar_patches/patch_index.csv",
      evidence: {
        gear: row.gear,
        gearLabel: row.gear_label,
        aisTime: row.ais_time,
        sceneTime: row.scene_time,
        timeDeltaHours: toNum(row.time_delta_hours),
        patchSize: toNum(row.patch_size),
        sceneName: row.scene_name,
        patchPng: normalizePatchPath(row.patch_png),
        previewPng: normalizePatchPath(row.preview_png),
      },
    });
  }
  return events;
}

async function readSarMatchEvents() {
  if (!fs.existsSync(sarMatchesPath)) return [];
  const json = JSON.parse(await fsp.readFile(sarMatchesPath, "utf8"));
  const matches = Array.isArray(json.matches) ? json.matches : [];
  return matches.slice(0, 20).map((match, index) => {
    const ais = match.ais || {};
    const candidate = match.candidates?.[0] || {};
    return {
      id: `ais-sar-match-${ais.mmsi || "unknown"}-${index + 1}`,
      type: "AIS_SAR_MATCH",
      severity: "LOW",
      lat: Number(ais.lat),
      lon: Number(ais.lon),
      mmsi: ais.mmsi ? String(ais.mmsi) : null,
      name: `${ais.gear_label || "AIS"} ${ais.mmsi || ""}`.trim(),
      detectedAt: candidate.start_time || ais.time_iso || new Date().toISOString(),
      reason: "AIS point memiliki kandidat scene Sentinel-1 dari ASF Search.",
      confidence: 0.58,
      method: "ais_sar_metadata_match",
      dataset: "ais_sar_matches.json",
      evidence: {
        gear: ais.gear,
        speedKnots: ais.speed,
        course: ais.course,
        sceneName: candidate.scene_name,
        timeDeltaHours: candidate.time_delta_hours,
        processingLevel: candidate.processing_level,
      },
    };
  }).filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lon));
}

async function main() {
  await fsp.mkdir(dataDir, { recursive: true });
  const kalman = await scanKalmanEvents();
  const sarPatchEvents = await readSarPatchEvents();
  const sarMatchEvents = await readSarMatchEvents();

  const events = [...kalman.events, ...sarPatchEvents, ...sarMatchEvents]
    .sort((a, b) => {
      const sev = { HIGH: 3, MEDIUM: 2, LOW: 1 };
      return (sev[b.severity] || 0) - (sev[a.severity] || 0)
        || Number(b.confidence || 0) - Number(a.confidence || 0)
        || new Date(b.detectedAt) - new Date(a.detectedAt);
    })
    .slice(0, MAX_EVENTS);

  const payload = {
    generatedAt: new Date().toISOString(),
    source: "samudra-aya local hybrid detector",
    inputs: {
      kalmanCsv: "data/ais_kalman_indonesia.csv",
      sarMatches: fs.existsSync(sarMatchesPath) ? "data/ais_sar_matches.json" : null,
      patchIndex: fs.existsSync(patchIndexPath) ? "data/sar_patches/patch_index.csv" : null,
    },
    thresholds: {
      goDarkGapHours: GO_DARK_GAP_HOURS,
      spoofingSpeedKnots: SPOOFING_SPEED_KN,
      trawlerMinPoints: TRAWLER_MIN_POINTS,
    },
    stats: {
      kalmanRowsScanned: kalman.rows,
      kalmanRuleCounts: kalman.counts,
      sarPatchEvents: sarPatchEvents.length,
      sarMatchEvents: sarMatchEvents.length,
      outputEvents: events.length,
    },
    events,
  };

  await fsp.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Wrote ${path.relative(root, outputPath)} (${events.length} events).`);
  console.log(JSON.stringify(payload.stats, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
