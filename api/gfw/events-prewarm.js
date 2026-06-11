import { defaultRange, refreshGfwEvents } from "./events.js";

function getHeader(req, name) {
  const headers = req.headers || {};
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || "";
}

function isAuthorizedCron(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return getHeader(req, "authorization") === `Bearer ${secret}`;
}

export default async function handler(req, res) {
  if (!isAuthorizedCron(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const range = defaultRange();
  const start = req.query.start_date || range.start;
  const end = req.query.end_date || range.end;

  try {
    const result = await refreshGfwEvents(start, end);
    const cached = result.cached;
    res.setHeader("cache-control", "no-store");
    res.json({
      ok: true,
      refreshed: result.refreshed,
      skipped: result.skipped,
      start_date: start,
      end_date: end,
      fetched_at: cached?.fetchedAt ? new Date(cached.fetchedAt).toISOString() : null,
      count: cached?.payload?.events?.length || 0,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "prewarm failed" });
  }
}
