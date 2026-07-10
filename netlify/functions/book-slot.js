// POST /api/book-slot
// Body: { date, start_time, session_type, session_length, customer_name, customer_email, customer_phone, customer_message }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;           // publishable key (kept for reference)
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY; // service-role key — server-side only
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const THERAPIST_EMAIL = process.env.THERAPIST_EMAIL;

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

function timeToMins(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function minsToTime(m) {
  const h = Math.floor(m / 60);
  const min = m % 60;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

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

async function sendEmail({ to, subject, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Magnus Massageterapi <bokningar@magnusmassage.se>',
      to,
      subject,
      html,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error('Resend error:', res.status, text);
  }
}

const MAX_ADVANCE_DAYS = 31; // furthest a booking can be made ahead of today — keep in sync with booking.html

function toUtcDateStr(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function formatDateSv(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const days = ['söndag', 'måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag'];
  const months = ['januari', 'februari', 'mars', 'april', 'maj', 'juni',
    'juli', 'augusti', 'september', 'oktober', 'november', 'december'];
  return `${days[d.getUTCDay()]} ${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: HEADERS };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { date, start_time, session_type, session_length, customer_name, customer_email, customer_phone, customer_message } = body;

  if (!date || !start_time || !session_type || !session_length || !customer_name || !customer_email) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing required fields' }) };
  }

  const now = new Date();
  const todayStr = toUtcDateStr(now);
  const maxDate = new Date(now);
  maxDate.setUTCDate(maxDate.getUTCDate() + MAX_ADVANCE_DAYS);
  const maxDateStr = toUtcDateStr(maxDate);

  if (date < todayStr || date > maxDateStr) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'date_out_of_range' }) };
  }

  const trimmedMessage = typeof customer_message === 'string' ? customer_message.trim().slice(0, 150) : '';

  const sessionMins = parseInt(session_length, 10);
  const startMins = timeToMins(start_time);
  const endMins = startMins + sessionMins;
  const end_time = minsToTime(endMins);

  try {
    // Date-specific override takes precedence over the recurring weekday schedule
    const overrideRows = await supabaseGet(
      `schedule_overrides?date=eq.${date}&select=is_open,open_time,close_time`
    );

    let closeMins;
    if (overrideRows.length) {
      if (!overrideRows[0].is_open) {
        return { statusCode: 409, headers: HEADERS, body: JSON.stringify({ error: 'slot_taken' }) };
      }
      closeMins = timeToMins(overrideRows[0].close_time);
    } else {
      // Get schedule for this weekday to find close_time
      const d = new Date(date + 'T12:00:00Z');
      const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const weekday = weekdays[d.getUTCDay()];

      const scheduleRows = await supabaseGet(
        `schedule?weekday=eq.${weekday}&select=is_open,open_time,close_time`
      );
      if (!scheduleRows.length || !scheduleRows[0].is_open) {
        return { statusCode: 409, headers: HEADERS, body: JSON.stringify({ error: 'slot_taken' }) };
      }

      closeMins = timeToMins(scheduleRows[0].close_time);
    }

    // Re-check slot availability (race condition guard)
    const bookingRows = await supabaseGet(
      `bookings?date=eq.${date}&select=start_time,end_time`
    );

    for (const b of bookingRows) {
      const bStart = timeToMins(b.start_time);
      const bEnd = timeToMins(b.end_time);
      const bBufferEnd = bEnd === closeMins ? bEnd : bEnd + 10;
      if (bStart < endMins && bBufferEnd > startMins) {
        return { statusCode: 409, headers: HEADERS, body: JSON.stringify({ error: 'slot_taken' }) };
      }
    }

    // Insert booking
    await supabaseInsert('bookings', {
      date,
      start_time,
      end_time,
      type: 'booking',
      session_length: sessionMins,
      session_type,
      customer_name,
      customer_email,
      customer_phone: customer_phone || null,
      customer_message: trimmedMessage || null,
    });

    const formattedDate = formatDateSv(date);
    const priceMap = { 20: 340, 30: 590, 45: 690, 60: 890, 75: 1090, 90: 1290 };
    const price = priceMap[sessionMins] ? `${priceMap[sessionMins]} kr` : '';

    // Email to customer
    await sendEmail({
      to: customer_email,
      subject: `Bokningsbekräftelse — ${formattedDate} kl. ${start_time}`,
      html: `
        <div style="font-family:'DM Sans',Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f1f16;">
          <div style="background:#0f1f16;padding:24px 32px;">
            <p style="font-size:18px;font-weight:700;color:#DCFF76;letter-spacing:0.1em;text-transform:uppercase;margin:0;">Magnus Massageterapi</p>
          </div>
          <div style="padding:32px;">
            <h2 style="font-size:22px;margin:0 0 8px;">Din bokning är bekräftad</h2>
            <p style="color:#4a6355;margin:0 0 24px;">Tack ${customer_name}! Vi ser fram emot att träffa dig.</p>
            <table style="width:100%;border-collapse:collapse;background:#f0ede4;border-radius:8px;overflow:hidden;">
              <tr><td style="padding:14px 20px;border-bottom:1px solid #d8d3c8;"><strong>Datum</strong></td><td style="padding:14px 20px;border-bottom:1px solid #d8d3c8;">${formattedDate}</td></tr>
              <tr><td style="padding:14px 20px;border-bottom:1px solid #d8d3c8;"><strong>Tid</strong></td><td style="padding:14px 20px;border-bottom:1px solid #d8d3c8;">${start_time} (${sessionMins} min)</td></tr>
              <tr><td style="padding:14px 20px;border-bottom:1px solid #d8d3c8;"><strong>Behandling</strong></td><td style="padding:14px 20px;border-bottom:1px solid #d8d3c8;">${session_type}</td></tr>
              ${price ? `<tr><td style="padding:14px 20px;"><strong>Pris</strong></td><td style="padding:14px 20px;">${price} — betalas på plats</td></tr>` : ''}
            </table>
            <p style="margin:24px 0 0;color:#4a6355;font-size:14px;">Köpenhamnsvägen 43, 217 71 Malmö (hos Kiropraktik &amp; Rehab).<br>Vid avbokning, kontakta oss via magnusmassageterapi@gmail.com.</p>
          </div>
        </div>`,
    });

    // Email to therapist
    await sendEmail({
      to: THERAPIST_EMAIL,
      subject: `Ny bokning: ${customer_name} — ${formattedDate} kl. ${start_time}`,
      html: `
        <div style="font-family:'DM Sans',Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f1f16;">
          <div style="background:#0f1f16;padding:24px 32px;">
            <p style="font-size:18px;font-weight:700;color:#DCFF76;letter-spacing:0.1em;text-transform:uppercase;margin:0;">Ny bokning</p>
          </div>
          <div style="padding:32px;">
            <table style="width:100%;border-collapse:collapse;background:#f0ede4;border-radius:8px;overflow:hidden;">
              <tr><td style="padding:14px 20px;border-bottom:1px solid #d8d3c8;"><strong>Kund</strong></td><td style="padding:14px 20px;border-bottom:1px solid #d8d3c8;">${customer_name}</td></tr>
              <tr><td style="padding:14px 20px;border-bottom:1px solid #d8d3c8;"><strong>E-post</strong></td><td style="padding:14px 20px;border-bottom:1px solid #d8d3c8;"><a href="mailto:${customer_email}">${customer_email}</a></td></tr>
              ${customer_phone ? `<tr><td style="padding:14px 20px;border-bottom:1px solid #d8d3c8;"><strong>Telefon</strong></td><td style="padding:14px 20px;border-bottom:1px solid #d8d3c8;">${customer_phone}</td></tr>` : ''}
              <tr><td style="padding:14px 20px;border-bottom:1px solid #d8d3c8;"><strong>Datum</strong></td><td style="padding:14px 20px;border-bottom:1px solid #d8d3c8;">${formattedDate}</td></tr>
              <tr><td style="padding:14px 20px;border-bottom:1px solid #d8d3c8;"><strong>Tid</strong></td><td style="padding:14px 20px;border-bottom:1px solid #d8d3c8;">${start_time}–${end_time} (${sessionMins} min)</td></tr>
              <tr><td style="padding:14px 20px;border-bottom:1px solid #d8d3c8;"><strong>Behandling</strong></td><td style="padding:14px 20px;border-bottom:1px solid #d8d3c8;">${session_type}</td></tr>
              ${price ? `<tr><td style="padding:14px 20px;"><strong>Pris</strong></td><td style="padding:14px 20px;">${price}</td></tr>` : ''}
              ${trimmedMessage ? `<tr><td style="padding:14px 20px;"><strong>Meddelande</strong></td><td style="padding:14px 20px;">${trimmedMessage}</td></tr>` : ''}
            </table>
          </div>
        </div>`,
    });

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };

  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Server error' }) };
  }
};
