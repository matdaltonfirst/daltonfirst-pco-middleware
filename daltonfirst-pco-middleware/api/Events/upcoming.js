export default async function handler(req, res) {
  try {
    const PCO_APP_ID = process.env.PCO_APP_ID;
    const PCO_SECRET = process.env.PCO_SECRET;

    // Optional: simple protection so strangers can’t call your endpoint
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

    // Pull up to 25 events (we’ll refine “future only” after your first successful test)
    const url = "https://api.planningcenteronline.com/calendar/v2/events?per_page=25";

    const resp = await fetch(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json"
      }
    });

    if (!resp.ok) {
      const text = await resp.text();
      return res.status(resp.status).json({ error: "PCO request failed", details: text });
    }

    const json = await resp.json();

    const events = (json?.data || []).map((e) => {
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
    });

    return res.status(200).json({ events });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}