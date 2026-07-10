// Shared auth check for all admin-*.js functions.
// Validates the caller's Supabase session token and returns the user,
// or a ready-to-return 401 response if missing/invalid.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; // publishable/anon key

async function requireUser(event, headers) {
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return { user: null, response: { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) } };
  }

  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    return { user: null, response: { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) } };
  }

  const user = await res.json();
  return { user, response: null };
}

module.exports = { requireUser };
