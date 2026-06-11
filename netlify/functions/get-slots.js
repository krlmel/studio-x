// GET /api/get-slots?mode=schedule
// GET /api/get-slots?date=YYYY-MM-DD&session_length=N

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

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
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Supabase error: ${res.status}`);
  return res.json();
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: HEADERS };
  }

  const params = event.queryStringParameters || {};

  try {
    // Mode: return open weekdays for calendar graying
    if (params.mode === 'schedule') {
      const rows = await supabaseGet('schedule?select=weekday,is_open,open_time,close_time');
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(rows) };
    }

    const { date, session_length } = params;
    if (!date || !session_length) {
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing date or session_length' }) };
    }

    const sessionMins = parseInt(session_length, 10);

    // Weekday name from date
    const d = new Date(date + 'T12:00:00Z');
    const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const weekday = weekdays[d.getUTCDay()];

    // Fetch schedule for this weekday
    const scheduleRows = await supabaseGet(
      `schedule?weekday=eq.${weekday}&select=is_open,open_time,close_time`
    );

    if (!scheduleRows.length || !scheduleRows[0].is_open) {
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ slots: [], schedule: null }) };
    }

    const schedule = scheduleRows[0];
    const openMins = timeToMins(schedule.open_time);
    const closeMins = timeToMins(schedule.close_time);

    // Fetch existing bookings/blocks for this date
    const bookingRows = await supabaseGet(
      `bookings?date=eq.${date}&select=start_time,end_time,type`
    );

    // Build blocked periods
    const blocked = bookingRows.map((b) => {
      const start = timeToMins(b.start_time);
      const end = timeToMins(b.end_time);
      const bufferEnd = end === closeMins ? end : end + 10;
      return { start, end, bufferEnd };
    }).sort((a, b) => a.start - b.start);

    // Check if a candidate start time is available
    function isAvailable(startMin) {
      if (startMin < openMins) return false;
      if (startMin + sessionMins > closeMins) return false;
      const slotEnd = startMin + sessionMins;
      for (const b of blocked) {
        if (b.start < slotEnd && b.bufferEnd > startMin) return false;
      }
      return true;
    }

    const slots = new Set();

    // Base grid: XX:00 and XX:30
    const lastValidStart = closeMins - sessionMins;
    for (let t = openMins; t <= lastValidStart; t += 30) {
      if (isAvailable(t)) slots.add(t);
    }

    // Bonus slots at XX:15 / XX:45 — only when there are bookings
    if (blocked.length > 0) {
      for (const b of blocked) {
        if (b.end % 30 === 0) {
          const bonusStart = b.end + 15;
          if (isAvailable(bonusStart)) slots.add(bonusStart);
        }
      }
    }

    const sorted = Array.from(slots).sort((a, b) => a - b).map(minsToTime);
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ slots: sorted }) };

  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Server error' }) };
  }
};
