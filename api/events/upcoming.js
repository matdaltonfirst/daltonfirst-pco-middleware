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

    const days = Math.min(parseInt(req.query.days || "30", 10), 180);
    const limit = Math.min(parseInt(req.query.limit || "25", 10), 100);
    const includeRegistrations = String(req.query.include_registrations || "1") !== "0";
    const debug = String(req.query.debug || "0") === "1";

    const now = new Date();
    const cutoff = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    const headers = {
      Authorization: `Basic ${auth}`,
      Accept: "application/json"
    };

    async function fetchJson(url) {
      const resp = await fetch(url, { headers });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`PCO request failed (${resp.status}): ${text}`);
      }
      return await resp.json();
    }

    async function getUpcomingCalendarEvents() {
      const collected = [];
      const perPage = 100;
      const maxPages = 15; // scan deeper

      let scanned = 0;
      let kept = 0;
      let firstFewStarts = [];

      for (let page = 1; page <= maxPages; page++) {
        const url = `https://api.planningcenteronline.com/calendar/v2/events?per_page=${perPage}&page=${page}`;
        const json = await fetchJson(url);

        const raw = json?.data || [];
        scanned += raw.length;

        const mapped = raw.map((e) => {
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
        });

        if (debug && firstFewStarts.length < 20) {
          for (const m of mapped) {
            if (m.start_time) firstFewStarts.push(m.start_time);
            if (firstFewStarts.length >= 20) break;
          }
        }

        const upcoming = mapped.filter((e) => {
          if (!e.start_time) return false;
          const dt = new Date(e.start_time);
          return dt >= now && dt <= cutoff;
        });

        kept += upcoming.length;
        collected.push(...upcoming);

        if (collected.length >= limit) break;
        if (raw.length < perPage) break; // no more pages
      }

      return { events: collected, scanned, kept, firstFewStarts };
    }

    async function getUpcomingRegistrations() {
      const collected = [];
      const perPage = 100;
      const maxPages = 6;

      for (let page = 1; page <= maxPages; page++) {
        const url = `https://api.planningcenteronline.com/registrations/v2/registrations?per_page=${perPage}&page=${page}`;
        const json = await fetchJson(url);

        const regs = (json?.data || [])
          .map((r) => {
            const a = r.attributes || {};
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

    const cal = await getUpcomingCalendarEvents();

    let registrationEvents = [];
    if (includeRegistrations) {
      try {
        registrationEvents = await getUpcomingRegistrations();
      } catch {
        registrationEvents = [];
      }
    }

    const merged = [...cal.events, ...registrationEvents]
      .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))
      .slice(0, limit);

    const response = {
      days,
      limit,
      include_registrations: includeRegistrations,
      events: merged
    };

    if (debug) {
      response.debug = {
        calendar_scanned: cal.scanned,
        calendar_kept: cal.kept,
        sample_calendar_starts_at: cal.firstFewStarts
      };
    }

    return res.status(200).json(response);
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "Server error",
      details: String(err?.message || err)
    });
  }
}
