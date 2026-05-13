import { createFileRoute } from "@tanstack/react-router";
import { getIndonesianEvents } from "@/lib/gfw.server";
import type { GfwEvent } from "@/lib/types";

export const Route = createFileRoute("/api/gfw/events")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const start = url.searchParams.get("start_date") || "2012-01-01";
        const end = url.searchParams.get("end_date") || new Date().toISOString().slice(0, 10);
        try {
          const raw = await getIndonesianEvents(start, end);
          const events: GfwEvent[] = raw.map((e: any) => {
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
          }).filter(ev => Number.isFinite(ev.lat) && Number.isFinite(ev.lon));
          return Response.json({ events });
        } catch (e: any) {
          return Response.json({ events: [], error: e?.message || "events failed" }, { status: 500 });
        }
      },
    },
  },
});