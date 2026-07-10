// GET  /.netlify/functions/admin-schedule            → 7 rows, the default weekly schedule
// PUT  /.netlify/functions/admin-schedule             → body: [{ weekday, is_open, open_time, close_time }, ...]

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

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: HEADERS };
  }

  const { user, response } = await requireUser(event, HEADERS);
  if (!user) return response;

  try {
    if (event.httpMethod === 'GET') {
      const rows = await supabaseGet('schedule?select=weekday,is_open,open_time,close_time');
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(rows) };
    }

    if (event.httpMethod === 'PUT') {
      let body;
      try {
        body = JSON.parse(event.body);
      } catch {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
      }
      if (!Array.isArray(body) || body.length !== 7) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Expected an array of 7 weekday rows' }) };
      }
      for (const row of body) {
        if (!WEEKDAYS.includes(row.weekday)) {
          return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: `Invalid weekday: ${row.weekday}` }) };
        }
      }
      const rows = await supabaseUpsert(
        'schedule',
        body.map((row) => ({
          weekday: row.weekday,
          is_open: !!row.is_open,
          open_time: row.is_open ? row.open_time : null,
          close_time: row.is_open ? row.close_time : null,
        })),
        'weekday'
      );
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(rows) };
    }

    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Server error' }) };
  }
};
