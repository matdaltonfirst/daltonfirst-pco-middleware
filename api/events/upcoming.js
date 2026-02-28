export default async function handler(req, res) {
  try {
    const PCO_APP_ID = process.env.PCO_APP_ID;
    const PCO_SECRET = process.env.PCO_SECRET;

    // Protect endpoint with middleware API key
    const MIDDLEWARE_API_KEY = process.env.MIDDLEWARE_API_KEY;
    if (MIDDLEWARE_API_KEY) {
      const key = req.headers["x-api-key"];
      if (key !== MIDDLEWARE_API_KEY) {
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    if (!PCO_APP_ID || !PCO_SECRET) {
      return res.status(500).json({ error: "Missing PCO credentials in env vars" });
    }

    const auth = Buffer.from(`${PCO_APP_ID}:${PCO_SECRET}`).toString("base64");

    // Optional query params:
    // /api/events/upcoming?days=30&limit=25&include_registrations=1
    const days = Math.min(parseInt(req.query.days || "30", 10), 180);
    const limit = Math.min(parseInt(req.query.limit || "25", 10), 100);
    const includeRegistrations = String(req.query.include_registrations || "1") !== "0";

    const now = new Date();
    const cutoff = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    const headers = {
      Authorization: `Basic ${auth}`,
      Accept: "application/json"
    };

    // ---- Helper: fetch JSON with error details ----
    async function fetchJson(url) {
      const resp = await fetch(url, { headers });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`PCO request failed (${resp.status}): ${text}`);
      }
      return await resp.json();
    }

    // ---- 1) CALENDAR EVENTS (paginate until we collect enough upcoming) ----
    async function getUpcomingCalendarEvents() {
      const collected = [];

      // Pull multiple pages because PCO often returns older events first
      // We'll stop when we have enough, or we hit max pages.
      const perPage = 100;
      const maxPages = 6; // up to 600 events scanned

      for (let page = 1; page <= maxPages; page++) {
        const url = `https://api.planningcenteronline.com/calendar/v2/events?per_page=${perPage}&page=${page}`;
        const json = await fetchJson(url);

        const pageEvents = (json?.data || [])
          .map((e) => {
            const a = e.attributes || {};
            return {
              source: "calendar",
              id: e.id,
              name: a.name || "",
              description: a.description || "",
              start_time: a.starts_at || "",
              end_time: a.ends_at || "",
              location: a.location || "",
              registration_url: a.registration_url || a.url || ""
            };
          })
          .filter((e) => {
            if (!e.start_time) return false;
            const dt = new Date(e.start_time);
            return dt >= now && dt <= cutoff;
          });

        collected.push(...pageEvents);

        // If we’re already beyond what we need, stop early
        if (collected.length >= limit) break;

        // If this page returned nothing at all, still continue a bit
        // (sometimes future events are buried)
        if ((json?.data || []).length < perPage) break; // no more pages
      }

      return collected;
    }

    // ---- 2) REGISTRATIONS (these are often the “real” promo events) ----
    // We’ll pull registrations and map what we can.
    // Different churches configure registrations differently, so we keep it flexible.
    async function getUpcomingRegistrations() {
      const collected = [];

      const perPage = 100;
      const maxPages = 4;

      for (let page = 1; page <= maxPages; page++) {
        const url = `https://api.planningcenteronline.com/registrations/v2/registrations?per_page=${perPage}&page=${page}`;
        const json = await fetchJson(url);

        const regs = (json?.data || [])
          .map((r) => {
            const a = r.attributes || {};

            // These fields vary; we’ll do best-effort and keep the important bits.
            const startGuess =
              a.starts_at ||
              a.start_at ||
              a.event_starts_at ||
              a.open_at ||
              a.opens_at ||
              "";

            const endGuess =
              a.ends_at ||
              a.end_at ||
              a.event_ends_at ||
              a.close_at ||
              a.closes_at ||
              "";

            return {
              source: "registrations",
              id: r.id,
              name: a.name || a.title || "",
              description: a.description || "",
              start_time: startGuess,
              end_time: endGuess,
              location: a.location || "",
              registration_url: a.public_url || a.url || a.registration_url || ""
            };
          })
          .filter((e) => {
            // Only include registrations that appear to be upcoming within the window.
            // If we can’t detect a start_time, we skip it (keeps the feed clean).
            if (!e.start_time) return false;
            const dt = new Date(e.start_time);
            return dt >= now && dt <= cutoff;
          });

        collected.push(...regs);

        if (collected.length >= limit) break;
        if ((json?.data || []).length < perPage) break;
      }

      return collected;
    }

    // Pull + merge
    const calendarEvents = await getUpcomingCalendarEvents();
    const registrationEvents = includeRegistrations ? await getUpcomingRegistrations() : [];

    const merged = [...calendarEvents, ...registrationEvents]
      .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))
      .slice(0, limit);

    return res.status(200).json({
      days,
      limit,
      include_registrations: includeRegistrations,
      events: merged
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "Server error",
      details: String(err?.message || err)
    });
  }
}
