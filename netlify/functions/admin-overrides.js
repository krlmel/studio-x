// GET    /.netlify/functions/admin-overrides?start=YYYY-MM-DD&end=YYYY-MM-DD  → overrides in range
// POST   /.netlify/functions/admin-overrides   body: { templateId, weekStart } → apply template to the 7 days starting weekStart
// DELETE /.netlify/functions/admin-overrides?date=YYYY-MM-DD                  → clear one override back to default

const { requireUser } = require('./lib/adminAuth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

async function supabaseGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Supabase GET error: ${res.status}`);
  return res.json();
}

async function supabaseUpsert(table, data, onConflict) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase UPSERT error: ${res.status} ${text}`);
  }
  return res.json();
}

async function supabaseDelete(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'DELETE',
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase DELETE error: ${res.status} ${text}`);
  }
}

function toUtcDateStr(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function weekdayOf(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const names = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  return names[d.getUTCDay()];
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: HEADERS };
  }

  const { user, response } = await requireUser(event, HEADERS);
  if (!user) return response;

  const params = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      const { start, end } = params;
      if (!start || !end) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing start or end' }) };
      }
      const rows = await supabaseGet(
        `schedule_overrides?date=gte.${start}&date=lte.${end}&select=date,is_open,open_time,close_time,source_template_id&order=date.asc`
      );
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(rows) };
    }

    if (event.httpMethod === 'POST') {
      let body;
      try {
        body = JSON.parse(event.body);
      } catch {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
      }
      const { templateId, weekStart } = body;
      if (!templateId || !weekStart) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing templateId or weekStart' }) };
      }

      const days = await supabaseGet(
        `week_template_days?template_id=eq.${templateId}&select=weekday,is_open,open_time,close_time`
      );
      if (!days.length) {
        return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Template not found or has no days' }) };
      }
      const byWeekday = {};
      days.forEach((d) => { byWeekday[d.weekday] = d; });

      const startDate = new Date(weekStart + 'T12:00:00Z');
      const overrides = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(startDate);
        d.setUTCDate(d.getUTCDate() + i);
        const dateStr = toUtcDateStr(d);
        const wd = weekdayOf(dateStr);
        const day = byWeekday[wd];
        if (!day) continue;
        overrides.push({
          date: dateStr,
          is_open: day.is_open,
          open_time: day.is_open ? day.open_time : null,
          close_time: day.is_open ? day.close_time : null,
          source_template_id: templateId,
        });
      }

      const rows = await supabaseUpsert('schedule_overrides', overrides, 'date');
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(rows) };
    }

    if (event.httpMethod === 'DELETE') {
      const { date } = params;
      if (!date) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing date' }) };
      }
      await supabaseDelete(`schedule_overrides?date=eq.${date}`);
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Server error' }) };
  }
};
