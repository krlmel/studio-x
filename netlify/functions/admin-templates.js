// GET    /.netlify/functions/admin-templates              → templates with their 7 days each
// POST   /.netlify/functions/admin-templates  body: { name, days: [{ weekday, is_open, open_time, close_time }, ...7] }
// DELETE /.netlify/functions/admin-templates?id=           → delete a template (cascades to its days)

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

async function supabaseInsert(table, data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase INSERT error: ${res.status} ${text}`);
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

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: HEADERS };
  }

  const { user, response } = await requireUser(event, HEADERS);
  if (!user) return response;

  const params = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      const templates = await supabaseGet('week_templates?select=id,name,created_at&order=created_at.desc');
      const days = await supabaseGet('week_template_days?select=template_id,weekday,is_open,open_time,close_time');
      const daysByTemplate = {};
      days.forEach((d) => {
        (daysByTemplate[d.template_id] ||= []).push(d);
      });
      const result = templates.map((t) => ({ ...t, days: daysByTemplate[t.id] || [] }));
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(result) };
    }

    if (event.httpMethod === 'POST') {
      let body;
      try {
        body = JSON.parse(event.body);
      } catch {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
      }
      const { name, days } = body;
      if (!name || !Array.isArray(days) || days.length !== 7) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing name or expected 7 days' }) };
      }
      for (const d of days) {
        if (!WEEKDAYS.includes(d.weekday)) {
          return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: `Invalid weekday: ${d.weekday}` }) };
        }
      }

      const [template] = await supabaseInsert('week_templates', { name });
      await supabaseInsert(
        'week_template_days',
        days.map((d) => ({
          template_id: template.id,
          weekday: d.weekday,
          is_open: !!d.is_open,
          open_time: d.is_open ? d.open_time : null,
          close_time: d.is_open ? d.close_time : null,
        }))
      );

      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(template) };
    }

    if (event.httpMethod === 'DELETE') {
      const { id } = params;
      if (!id) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing id' }) };
      }
      await supabaseDelete(`week_templates?id=eq.${id}`);
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Server error' }) };
  }
};
