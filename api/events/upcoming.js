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

    const includeRegistrations = String(req.query.include_registrations || "0") === "1";
    const limitPerDay = Math.min(parseInt(req.query.limit_per_day || "20", 10), 50);
    const debug = String(req.query.debug || "0") === "1";

    const TZ = "America/New_York";

    const headers = {
      Authorization: `Basic ${auth}`,
      Accept: "application/json"
    };

    async function fetchJson(url) {
      const resp = await fetch(url, { headers });
      const text = await resp.text();
      if (!resp.ok) throw new Error(`PCO request failed (${resp.status}): ${text}`);
      return JSON.parse(text);
    }

    function decodeEntities(text) {
      if (!text) return "";
      return String(text)
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
    }

    function stripHtml(html) {
      if (!html) return "";
      const stripped = String(html)
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n")
        .replace(/<\/li>/gi, "\n")
        .replace(/<li>/gi, "- ")
        .replace(/<[^>]+>/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

      return decodeEntities(stripped).replace(/[ \t]{2,}/g, " ").trim();
    }

    function toEasternDisplay(isoString) {
      if (!isoString) return "";
      const d = new Date(isoString);
      return new Intl.DateTimeFormat("en-US", {
        timeZone: TZ,
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      }).format(d);
    }

    // YYYY-MM-DD in Eastern
    function nyDateStringFromIso(isoString) {
      if (!isoString) return "";
      const d = new Date(isoString);
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(d);
    }

    // YYYY-MM-DD for "today" in Eastern
    function nyTodayString() {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(new Date());
    }

    function utcDateFromYmd(ymd) {
      const [y, m, d] = ymd.split("-").map((n) => parseInt(n, 10));
      return new Date(Date.UTC(y, m - 1, d));
    }

    function ymdFromUtcDate(dt) {
      const y = dt.getUTCFullYear();
      const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
      const d = String(dt.getUTCDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }

    function addDaysYmd(startYmd, daysToAdd) {
      const base = utcDateFromYmd(startYmd);
      base.setUTCDate(base.getUTCDate() + daysToAdd);
      return ymdFromUtcDate(base);
    }

    function getMondayOfWeekYmd(ymd) {
      const base = utcDateFromYmd(ymd);
      const dow = base.getUTCDay(); // 0 Sun .. 6 Sat
      const diffToMonday = (dow + 6) % 7; // Mon => 0, Tue => 1, Sun => 6
      base.setUTCDate(base.getUTCDate() - diffToMonday);
      return ymdFromUtcDate(base);
    }

    function dedupeById(items) {
      const seen = new Set();
      const out = [];
      for (const item of items) {
        if (!item?.id) continue;
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        out.push(item);
      }
      return out;
    }

    // Determine week range
    const startParam = String(req.query.start || "").trim(); // YYYY-MM-DD optional
    const anchor = startParam || nyTodayString();
    const weekStart = getMondayOfWeekYmd(anchor);
    const weekEnd = addDaysYmd(weekStart, 6);

    // Helper: check if NY date string is within week range (inclusive)
    function inWeek(nyYmd) {
      return nyYmd && nyYmd >= weekStart && nyYmd <= weekEnd;
    }

    // Calendar instances
    async function getCalendarInstancesForWeek() {
      const perPage = 100;
      const maxEventPages = 10;
      const maxInstancePages = 4;

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
                const nyYmd = nyDateStringFromIso(start);

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
                  date_local: nyYmd,
                  location: a.location || eventLocation || "",
                  registration_url: eventRegUrl || eventUrl || ""
                };
              })
              .filter((e) => inWeek(e.date_local));

            collected.push(...mapped);

            if (instances.length < perPage) break;
          }
        }

        if (parents.length < perPage) break;
      }

      const deduped = dedupeById(collected).sort(
        (a, b) => (a.start_epoch ?? 0) - (b.start_epoch ?? 0)
      );

      return { events: deduped, parentEventsScanned, instancesScanned };
    }

    // Registrations (optional)
    async function getRegistrationsForWeek() {
      const perPage = 100;
      const maxPages = 6;
      const collected = [];

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
            const nyYmd = nyDateStringFromIso(startGuess);

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
              date_local: nyYmd,
              location: a.location || "",
              registration_url: a.public_url || a.url || a.registration_url || ""
            };
          })
          .filter((e) => inWeek(e.date_local));

        collected.push(...regs);

        if ((json?.data || []).length < perPage) break;
      }

      return dedupeById(collected).sort((a, b) => (a.start_epoch ?? 0) - (b.start_epoch ?? 0));
    }

    const cal = await getCalendarInstancesForWeek();

    let regs = [];
    if (includeRegistrations) {
      try {
        regs = await getRegistrationsForWeek();
      } catch {
        regs = [];
      }
    }

    const allEvents = dedupeById([...cal.events, ...regs]).sort(
      (a, b) => (a.start_epoch ?? 0) - (b.start_epoch ?? 0)
    );

    // Group by day
    const days = [];
    for (let i = 0; i < 7; i++) {
      const date = addDaysYmd(weekStart, i);
      const label = new Intl.DateTimeFormat("en-US", {
        timeZone: TZ,
        weekday: "long",
        month: "long",
        day: "numeric"
      }).format(new Date(`${date}T12:00:00Z`)); // safe midday anchor

      const dayEvents = allEvents
        .filter((e) => e.date_local === date)
        .slice(0, limitPerDay);

      days.push({ date, label, events: dayEvents });
    }

    const response = {
      timezone: TZ,
      week_start: weekStart,
      week_end: weekEnd,
      include_registrations: includeRegistrations,
      limit_per_day: limitPerDay,
      days
    };

    if (debug) {
      response.debug = {
        calendar_parent_events_scanned: cal.parentEventsScanned,
        calendar_instances_scanned: cal.instancesScanned,
        total_events: allEvents.length
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
