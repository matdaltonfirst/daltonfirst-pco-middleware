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

    // registrations opt-in via query param
    const includeRegistrations = String(req.query.include_registrations || "0") === "1";
    const debug = String(req.query.debug || "0") === "1";

    const now = new Date();
    const cutoff = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    const headers = {
      Authorization: `Basic ${auth}`,
      Accept: "application/json"
    };

    async function fetchJson(url) {
      const resp = await fetch(url, { headers });
      const text = await resp.text();
      if (!resp.ok) {
        throw new Error(`PCO request failed (${resp.status}): ${text}`);
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`PCO returned non-JSON: ${text}`);
      }
    }

    function stripHtml(html) {
      if (!html) return "";
      // very small + safe html strip (good enough for PCO descriptions)
      return String(html)
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    function toEasternDisplay(isoString) {
      if (!isoString) return "";
      const d = new Date(isoString);
      // Format in America/New_York for your comms team
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      }).format(d);
    }

    // ---- CALENDAR: pull event instances (occurrences) ----
    async function getUpcomingCalendarInstances() {
      const perPage = 100;
      const maxEventPages = 10; // parent events pages
      const maxInstancePages = 4; // instances per event
      const instanceLimitPerEvent = 200;

      const collected = [];
      let parentEventsScanned = 0;
      let instancesScanned = 0;

      for (let page = 1; page <= maxEventPages; page++) {
        const eventsUrl = `https://api.planningcenteronline.com/calendar/v2/events?per_page=${perPage}&page=${page}`;
        const eventsJson = await fetchJson(eventsUrl);
        const parents = eventsJson?.data || [];
        parentEventsScanned += parents.length;

        for (const ev of parents) {
          const eventId = ev.id;
          const evAttr = ev.attributes || {};
          const eventName = evAttr.name || "";
          const eventDescHtml = evAttr.description || "";
          const eventLocation = evAttr.location || "";
          const eventUrl = evAttr.url || "";
          const eventRegUrl = evAttr.registration_url || "";

          let instanceCountForThisEvent = 0;

          for (let ip = 1; ip <= maxInstancePages; ip++) {
            const instUrl =
              `https://api.planningcenteronline.com/calendar/v2/events/${eventId}/event_instances?per_page=${perPage}&page=${ip}`;
            const instJson = await fetchJson(instUrl);
            const instances = instJson?.data || [];

            instancesScanned += instances.length;

            const mapped = instances
              .map((inst) => {
                const a = inst.attributes || {};
                const start = a.starts_at || "";
                const end = a.ends_at || "";
                return {
                  source: "calendar",
                  id: `${eventId}:${inst.id}`,
                  name: eventName || a.name || "",
                  description_html: eventDescHtml || "",
                  description_text: stripHtml(eventDescHtml || ""),
                  start_time: start,
                  end_time: end,
                  start_epoch: start ? new Date(start).getTime() : null,
                  start_local: toEasternDisplay(start),
                  end_local: toEasternDisplay(end),
                  location: a.location || eventLocation || "",
                  registration_url: eventRegUrl || eventUrl || ""
                };
              })
              .filter((e) => {
                if (!e.start_time) return false;
                const dt = new Date(e.start_time);
                return dt >= now && dt <= cutoff;
              });

            collected.push(...mapped);

            instanceCountForThisEvent += instances.length;
            if (collected.length >= limit) break;
            if (instances.length < perPage) break;
            if (instanceCountForThisEvent >= instanceLimitPerEvent) break;
          }

          if (collected.length >= limit) break;
        }

        if (collected.length >= limit) break;
        if (parents.length < perPage) break;
      }

      const sorted = collected
        .sort((a, b) => (a.start_epoch ?? 0) - (b.start_epoch ?? 0))
        .slice(0, limit);

      return {
        events: sorted,
        parentEventsScanned,
        instancesScanned
      };
    }

    // ---- REGISTRATIONS (optional; best-effort) ----
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

            const descHtml = a.description || "";

            return {
              source: "registrations",
              id: r.id,
              name: a.name || a.title || "",
              description_html: descHtml,
              description_text: stripHtml(descHtml),
              start_time: startGuess,
              end_time: endGuess,
              start_epoch: startGuess ? new Date(startGuess).getTime() : null,
              start_local: toEasternDisplay(startGuess),
              end_local: toEasternDisplay(endGuess),
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

      return collected
        .sort((a, b) => (a.start_epoch ?? 0) - (b.start_epoch ?? 0))
        .slice(0, limit);
    }

    const cal = await getUpcomingCalendarInstances();

    let registrationEvents = [];
    if (includeRegistrations) {
      try {
        registrationEvents = await getUpcomingRegistrations();
      } catch {
        registrationEvents = [];
      }
    }

    const merged = [...cal.events, ...registrationEvents]
      .sort((a, b) => (a.start_epoch ?? 0) - (b.start_epoch ?? 0))
      .slice(0, limit);

    const response = {
      days,
      limit,
      include_registrations: includeRegistrations,
      timezone: "America/New_York",
      events: merged
    };

    if (debug) {
      response.debug = {
        calendar_parent_events_scanned: cal.parentEventsScanned,
        calendar_instances_scanned: cal.instancesScanned,
        returned_calendar_events: cal.events.length,
        returned_registration_events: registrationEvents.length
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
