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

    // Build Planning Center auth header
    const auth = Buffer.from(`${PCO_APP_ID}:${PCO_SECRET}`).toString("base64");

    // Pull events from Planning Center Calendar API
    const url = "https://api.planningcenteronline.com/calendar/v2/events?per_page=50";

    const resp = await fetch(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json"
      }
    });

    if (!resp.ok) {
      const text = await resp.text();
      return res.status(resp.status).json({
        error: "PCO request failed",
        details: text
      });
    }

    const json = await resp.json();

    // Filter to only future events, sort soonest first, limit to 20
    const now = new Date();

    const events = (json?.data || [])
      .map((e) => {
        const a = e.attributes || {};
        return {
          id: e.id,
          name: a.name || "",
          description: a.description || "",
          start_time: a.starts_at || "",
          end_time: a.ends_at || "",
          location: a.location || "",
          registration_url: a.registration_url || a.url || ""
        };
      })
      .filter(e => e.start_time && new Date(e.start_time) >= now)
      .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))
      .slice(0, 20);

    return res.status(200).json({ events });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}
