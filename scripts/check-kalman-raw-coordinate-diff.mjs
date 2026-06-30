import fs from "node:fs";
import readline from "node:readline";

const input = "data/ais_kalman_indonesia.csv";

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

function distanceMeters(lat1, lon1, lat2, lon2) {
  const r = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

const rl = readline.createInterface({
  input: fs.createReadStream(input, { encoding: "utf8" }),
  crlfDelay: Infinity,
});

let headers = null;
let idx = {};
let rows = 0;
let sameExact = 0;
let sameApprox = 0;
let different = 0;
let sumDistance = 0;
let maxDistance = -1;
let maxRow = null;
let gt1m = 0;
let gt10m = 0;
let gt100m = 0;
let gt1000m = 0;
const examples = [];

for await (const line of rl) {
  if (!headers) {
    headers = csvSplit(line);
    headers.forEach((h, i) => { idx[h] = i; });
    continue;
  }
  if (!line.trim()) continue;

  const cols = csvSplit(line);
  const rawLat = Number(cols[idx.raw_lat]);
  const rawLon = Number(cols[idx.raw_lon]);
  const kalmanLat = Number(cols[idx.kalman_lat]);
  const kalmanLon = Number(cols[idx.kalman_lon]);
  if (![rawLat, rawLon, kalmanLat, kalmanLon].every(Number.isFinite)) continue;

  rows++;
  const exact = rawLat === kalmanLat && rawLon === kalmanLon;
  if (exact) sameExact++;

  const distance = distanceMeters(rawLat, rawLon, kalmanLat, kalmanLon);
  if (distance < 0.01) sameApprox++;
  else different++;
  if (distance > 1) gt1m++;
  if (distance > 10) gt10m++;
  if (distance > 100) gt100m++;
  if (distance > 1000) gt1000m++;
  sumDistance += distance;

  if (distance > maxDistance) {
    maxDistance = distance;
    maxRow = {
      mmsi: cols[idx.mmsi],
      time: cols[idx.time_iso],
      raw: [rawLat, rawLon],
      kalman: [kalmanLat, kalmanLon],
      distance_m: Number(distance.toFixed(3)),
      correction_m: cols[idx.kalman_correction_m],
      reset_reason: cols[idx.kalman_reset_reason],
    };
  }

  if (examples.length < 8 && distance > 1) {
    examples.push({
      mmsi: cols[idx.mmsi],
      time: cols[idx.time_iso],
      raw: [rawLat, rawLon],
      kalman: [kalmanLat, kalmanLon],
      distance_m: Number(distance.toFixed(3)),
      correction_m: cols[idx.kalman_correction_m],
    });
  }
}

console.log(JSON.stringify({
  rows,
  sameExact,
  sameApproxUnder1cm: sameApprox,
  differentOver1cm: different,
  percentExact: Number((sameExact / rows * 100).toFixed(2)),
  avgDistanceM: Number((sumDistance / rows).toFixed(3)),
  gt1m,
  gt10m,
  gt100m,
  gt1000m,
  maxDistanceM: Number(maxDistance.toFixed(3)),
  maxRow,
  examples,
}, null, 2));
