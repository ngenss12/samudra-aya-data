import { cacheGet, cacheSet } from "./_redis.js";
import { sendTelegramMessage } from "./_telegram.js";

const ALERT_TTL_SECONDS = Number(process.env.INFERENCE_ALERT_TTL_SECONDS || 24 * 60 * 60);
const MIN_CONFIDENCE = Number(process.env.INFERENCE_ALERT_MIN_CONFIDENCE || 0.6);

function htmlSafe(value) {
  return String(value ?? "-")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function isSpoofing(task) {
  return String(task?.pred_label || "").toLowerCase().includes("spoof");
}

function isGoDark(task) {
  const label = String(task?.pred_label || "").toLowerCase();
  if (label.includes("not_dark") || label.includes("not dark") || label.includes("normal")) return false;
  return label.includes("go_dark") || label.includes("go dark") || label === "dark" || label === "go-dark";
}

function confidence(task) {
  const value = Number(task?.confidence);
  return Number.isFinite(value) ? value : 0;
}

function alertKey(vessel, type, task) {
  return `telegram:inference-alert:v1:${type}:${vessel?.mmsi || "unknown"}:${task?.pred_label || "unknown"}`;
}

function formatInferenceTelegramMessage(vessel, type, task) {
  const lat = Number(vessel?.last_lat);
  const lon = Number(vessel?.last_lon);
  const hasPosition = Number.isFinite(lat) && Number.isFinite(lon);
  const mapUrl = hasPosition ? `https://www.google.com/maps?q=${lat.toFixed(5)},${lon.toFixed(5)}` : null;
  const gear = vessel?.tasks?.gear;
  const title = type === "SPOOFING" ? "SPOOFING INFERENCE ALERT" : "GO DARK INFERENCE ALERT";
  const conf = confidence(task);

  return [
    `<b>[HIGH] ${title}</b>`,
    "",
    `<b>MMSI:</b> ${htmlSafe(vessel?.mmsi)}`,
    gear ? `<b>Gear:</b> ${htmlSafe(gear.pred_label)} (${(confidence(gear) * 100).toFixed(1)}%)` : null,
    `<b>Prediksi:</b> ${htmlSafe(task?.pred_label)} (${(conf * 100).toFixed(1)}%)`,
    hasPosition ? `<b>Koordinat:</b> ${lat.toFixed(5)}, ${lon.toFixed(5)}` : `<b>Koordinat:</b> Tidak tersedia`,
    vessel?.n_sequences != null ? `<b>Sequences:</b> ${htmlSafe(vessel.n_sequences)}` : null,
    vessel?.n_used != null ? `<b>Used:</b> ${htmlSafe(vessel.n_used)}` : null,
    "",
    `<b>Sumber:</b> AI inference batch latest`,
    `<b>Waktu:</b> ${htmlSafe(new Date().toLocaleString("id-ID"))}`,
    "",
    type === "SPOOFING"
      ? "Indikasi model: pola trajectory AIS menyerupai manipulasi/spoofing posisi."
      : "Indikasi model: pola trajectory AIS menyerupai aktivitas go dark.",
    mapUrl ? `\n<a href="${mapUrl}">Buka lokasi di peta</a>` : null,
  ].filter(Boolean).join("\n");
}

async function sendOnce(vessel, type, task) {
  if (confidence(task) < MIN_CONFIDENCE) {
    return { sent: false, skipped: "confidence below threshold", type, mmsi: vessel?.mmsi };
  }

  const key = alertKey(vessel, type, task);
  const existing = await cacheGet(key);
  if (existing) {
    return { sent: false, skipped: "deduped", type, mmsi: vessel?.mmsi };
  }

  const message = formatInferenceTelegramMessage(vessel, type, task);
  const telegram = await sendTelegramMessage(message);
  if (telegram.ok) await cacheSet(key, { sentAt: Date.now() }, ALERT_TTL_SECONDS);

  return {
    sent: Boolean(telegram.ok),
    type,
    mmsi: vessel?.mmsi,
    telegram: telegram.ok ? { ok: true } : telegram,
  };
}

export async function notifyInferenceAlerts(data) {
  const vessels = Array.isArray(data?.vessels) ? data.vessels : [];
  const results = [];

  for (const vessel of vessels) {
    const spoof = vessel?.tasks?.spoofing;
    const dark = vessel?.tasks?.godark;

    if (isSpoofing(spoof)) results.push(await sendOnce(vessel, "SPOOFING", spoof));
    if (isGoDark(dark)) results.push(await sendOnce(vessel, "GO_DARK", dark));
  }

  return {
    checked: vessels.length,
    alerts: results,
    sent: results.filter((r) => r.sent).length,
  };
}
