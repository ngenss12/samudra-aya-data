import { cacheGet, cacheSet } from "../../_redis.js";
import { applyRateLimit } from "../../_rate-limit.js";
import { notifyInferenceAlerts } from "../../_inference-alerts.js";

const INFERENCE_BASE = process.env.INFERENCE_URL || "https://ngenss12-inferencegfw.hf.space";
const CACHE_KEY = "inference:batch:latest:v1";
const CACHE_TTL_SECONDS = 30;

export default async function handler(req, res) {
  const allowed = await applyRateLimit(req, res, {
    name: "inference-batch-latest",
    limit: 120,
    windowSeconds: 10 * 60,
  });
  if (!allowed) return;

  const cached = await cacheGet(CACHE_KEY);
  if (cached?.payload) {
    const notify = req.query?.notify !== "0";
    const alertResult = notify ? await notifyInferenceAlerts(cached.payload) : { skipped: "notify disabled" };
    res.setHeader("x-cache", "HIT");
    res.setHeader("cache-control", "public, max-age=15, stale-while-revalidate=60");
    return res.json({ ...cached.payload, telegram_alerts: alertResult });
  }

  try {
    const upstream = await fetch(`${INFERENCE_BASE}/inference/batch/latest`, {
      signal: AbortSignal.timeout(15000),
    });
    const data = await upstream.json().catch(() => null);

    if (!upstream.ok) {
      return res.status(upstream.status).json(data || {
        error: "Inference batch latest failed",
        detail: `HTTP ${upstream.status}`,
      });
    }

    const notify = req.query?.notify !== "0";
    const alertResult = notify ? await notifyInferenceAlerts(data) : { skipped: "notify disabled" };
    await cacheSet(CACHE_KEY, { payload: data, fetchedAt: Date.now() }, CACHE_TTL_SECONDS);
    res.setHeader("x-cache", "MISS");
    res.setHeader("cache-control", "public, max-age=15, stale-while-revalidate=60");
    res.json({ ...data, telegram_alerts: alertResult });
  } catch (err) {
    res.status(502).json({
      error: "Inference server unavailable",
      detail: err?.message || "batch latest failed",
    });
  }
}
