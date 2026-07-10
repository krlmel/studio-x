// GET    /.netlify/functions/admin-blocks?start=YYYY-MM-DD&end=YYYY-MM-DD  → manual blocks in range
// POST   /.netlify/functions/admin-blocks  body: { date, start_time, end_time, note? }
// DELETE /.netlify/functions/admin-blocks?id=                              → remove a block

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
        `bookings?type=eq.block&date=gte.${start}&date=lte.${end}` +
        `&select=id,date,start_time,end_time,customer_message&order=date.asc,start_time.asc`
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
      const { date, start_time, end_time, note } = body;
      if (!date || !start_time || !end_time) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing date, start_time or end_time' }) };
      }
      const [block] = await supabaseInsert('bookings', {
        date,
        start_time,
        end_time,
        type: 'block',
        customer_message: typeof note === 'string' && note.trim() ? note.trim().slice(0, 150) : null,
      });
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(block) };
    }

    if (event.httpMethod === 'DELETE') {
      const { id } = params;
      if (!id) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing id' }) };
      }
      await supabaseDelete(`bookings?id=eq.${id}&type=eq.block`);
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Server error' }) };
  }
};
