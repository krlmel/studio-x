// GET /api/get-slots?mode=schedule
// GET /api/get-slots?date=YYYY-MM-DD&session_length=N

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;           // publishable key (kept for reference)
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY; // service-role key — server-side only

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

    // Mode: return date-specific overrides in range, for calendar graying
    if (params.mode === 'overrides') {
      const { start, end } = params;
      if (!start || !end) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing start or end' }) };
      }
      const rows = await supabaseGet(
        `schedule_overrides?date=gte.${start}&date=lte.${end}&select=date,is_open,open_time,close_time`
      );
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify(rows) };
    }

    const { date, session_length } = params;
    if (!date || !session_length) {
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing date or session_length' }) };
    }

    const sessionMins = parseInt(session_length, 10);
    console.log(`[get-slots] date=${date} session_length=${sessionMins}`);

    // Date-specific override takes precedence over the recurring weekday schedule
    const overrideRows = await supabaseGet(
      `schedule_overrides?date=eq.${date}&select=is_open,open_time,close_time`
    );
    console.log(`[get-slots] override rows for ${date}:`, JSON.stringify(overrideRows));

    let schedule;
    if (overrideRows.length) {
      if (!overrideRows[0].is_open) {
        console.log(`[get-slots] day closed via override — returning empty slots`);
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ slots: [], schedule: null }) };
      }
      schedule = overrideRows[0];
    } else {
      // Weekday name from date
      const d = new Date(date + 'T12:00:00Z');
      const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const weekday = weekdays[d.getUTCDay()];
      console.log(`[get-slots] weekday resolved to: ${weekday}`);

      // Fetch schedule for this weekday
      const scheduleRows = await supabaseGet(
        `schedule?weekday=eq.${weekday}&select=is_open,open_time,close_time`
      );
      console.log(`[get-slots] schedule rows:`, JSON.stringify(scheduleRows));

      if (!scheduleRows.length || !scheduleRows[0].is_open) {
        console.log(`[get-slots] day is closed or not found — returning empty slots`);
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ slots: [], schedule: null }) };
      }

      schedule = scheduleRows[0];
    }
    const openMins = timeToMins(schedule.open_time);
    const closeMins = timeToMins(schedule.close_time);
    console.log(`[get-slots] open=${schedule.open_time} (${openMins} min) close=${schedule.close_time} (${closeMins} min)`);

    // Fetch existing bookings/blocks for this date
    const bookingRows = await supabaseGet(
      `bookings?date=eq.${date}&select=start_time,end_time,type`
    );
    console.log(`[get-slots] booking rows for ${date}:`, JSON.stringify(bookingRows));

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
    console.log(`[get-slots] computed slots (${sorted.length}):`, JSON.stringify(sorted));
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ slots: sorted }) };

  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Server error' }) };
  }
};
