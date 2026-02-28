// api/events/upcoming.js
export default async function handler(req, res) {
  try {
    const PCO_APP_ID = process.env.PCO_APP_ID;
    const PCO_SECRET = process.env.PCO_SECRET;

    // Optional protection so strangers can’t call your endpoint
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

    // Basic Auth for Planning Center
    const auth = Buffer.from(`${PCO_APP_ID}:${PCO_SECRET}`).toString("base64");

    const TZ = "America/New_York";

    const days = Math.min(parseInt(req.query.days || "30", 10), 180);
    const limit = Math.min(parseInt(req.query.limit || "25", 10), 200);

    // 1 = include registrations, 0 = exclude
    const includeRegistrations = String(req.query.include_registrations || "0") === "1";

    // Optional grouping
    // group_by=week will include weeks[] buckets using the returned events
    const groupBy = String(req.query.group_by || "").toLowerCase(); // "week" or ""
    const weeksToReturn = Math.min(parseInt(req.query.weeks || "6", 10), 12);

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
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(new Date(isoString));
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

    // Simple date helpers using UTC for stable math on YYYY-MM-DD strings
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

    function mondayOfWeekYmd(ymd) {
      const base = utcDateFromYmd(ymd);
      const dow = base.getUTCDay(); // 0 Sun..6 Sat
      const diffToMonday = (dow + 6) % 7; // Mon=0 ... Sun=6
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

    // ---- CALENDAR: pull event instances (occurrences) ----
    async function getUpcomingCalendarInstances() {
      const perPage = 100;
      const maxEventPages = 10;
      const maxInstancePages = 4;
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
                  date_local: nyDateStringFromIso(start),
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
            if (instances.length < perPage) break;
            if (instanceCountForThisEvent >= instanceLimitPerEvent) break;
          }
        }

        if (parents.length < perPage) break;
      }

      const deduped = dedupeById(collected).sort(
        (a, b) => (a.start_epoch ?? 0) - (b.start_epoch ?? 0)
      );

      return {
        events: deduped,
        parentEventsScanned,
        instancesScanned,
        collectedCount: collected.length,
        dedupedCount: deduped.length
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
              date_local: nyDateStringFromIso(startGuess),
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

        if ((json?.data || []).length < perPage) break;
      }

      return dedupeById(collected).sort((a, b) => (a.start_epoch ?? 0) - (b.start_epoch ?? 0));
    }

    // Fetch + merge
    const cal = await getUpcomingCalendarInstances();

    let regs = [];
    if (includeRegistrations) {
      try {
        regs = await getUpcomingRegistrations();
      } catch {
        regs = [];
      }
    }

    // Merge, dedupe, sort, limit
    const merged = dedupeById([...cal.events, ...regs])
      .sort((a, b) => (a.start_epoch ?? 0) - (b.start_epoch ?? 0))
      .slice(0, limit);

    // Optional: week buckets (built from returned merged list)
    let weeks = undefined;
    if (groupBy === "week") {
      const todayNY = nyTodayString();
      const startMonday = mondayOfWeekYmd(todayNY);

      weeks = Array.from({ length: weeksToReturn }).map((_, i) => {
        const weekStart = addDaysYmd(startMonday, i * 7);
        const weekEnd = addDaysYmd(weekStart, 6);

        const weekEvents = merged.filter((ev) => {
          const d = ev.date_local || "";
          return d && d >= weekStart && d <= weekEnd;
        });

        return { week_start: weekStart, week_end: weekEnd, events: weekEvents };
      });
    }

    const response = {
      days,
      limit,
      include_registrations: includeRegistrations,
      timezone: TZ,
      group_by: groupBy || null,
      weeks,
      events: merged
    };

    if (debug) {
      response.debug = {
        calendar_parent_events_scanned: cal.parentEventsScanned,
        calendar_instances_scanned: cal.instancesScanned,
        calendar_collected: cal.collectedCount,
        calendar_deduped: cal.dedupedCount,
        registrations_included: includeRegistrations,
        returned_events: merged.length,
        weeks_returned: Array.isArray(weeks) ? weeks.length : 0
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
