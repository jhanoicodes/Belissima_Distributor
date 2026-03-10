require('dotenv').config();
const express  = require('express');
const mysql    = require('mysql2/promise');
const cors     = require('cors');
const path     = require('path');
const Groq     = require('groq-sdk');

const app  = express();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── DATABASE POOL ─────────────────────────────────────────────────────────────
// A pool keeps multiple connections ready so the server handles
// multiple users at the same time efficiently.
const pool = mysql.createPool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '3306'),
  user:     process.env.DB_USER     || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME     || 'Belissima_Database',
  waitForConnections: true,
  connectionLimit:    10,
});

// Test DB connection on startup
pool.getConnection()
  .then(conn => {
    console.log('✅ Connected to MySQL database');
    conn.release();
  })
  .catch(err => {
    console.error('❌ Database connection failed:', err.message);
  });

// ─── SCORING QUERY ─────────────────────────────────────────────────────────────
const SCORING_QUERY = `
  SELECT
    p.businessID,
    p.business_name,
    p.service_type,
    p.parish,
    p.phone_number,
    p.insta_link,
    p.tiktok_link,
    p.facebook_link,
    p.booking_link,
    p.other_booking,
    p.address,
    t.starting_price,
    t.board_certified,
    t.company_allowed,
    t.payment_methods,
    t.deposit_required,
    t.deposit_type,
    t.deposit_value,
    t.average_worktime,
    t.walkins_allowed,
    t.mobile_service,
    t.provider_gender,
    t.kid_friendly,
    t.disabled_friendly,
    t.opening_hours,
    t.days_open,
    t.weekly_hours,

    (
      -- 1. Price band (max 10)
      CASE
        WHEN t.starting_price BETWEEN 0    AND 2000 THEN 10
        WHEN t.starting_price BETWEEN 2001 AND 5000 THEN 8
        WHEN t.starting_price BETWEEN 5001 AND 9000 THEN 6
        WHEN t.starting_price >= 9001               THEN 3
        ELSE 0
      END

      -- 2. Board certified (max 10)
      + CASE
          WHEN t.board_certified = 1 THEN 10
          WHEN t.board_certified = 0 THEN 5
          ELSE 0
        END

      -- 3. Company allowed (max 3)
      + CASE WHEN t.company_allowed = 1 THEN 3 ELSE 0 END

      -- 4. Payment methods — 3 pts each (max 9)
      + CASE
          WHEN t.payment_methods IS NULL THEN 0
          ELSE
            (CASE WHEN JSON_CONTAINS(t.payment_methods, JSON_QUOTE('cash'))     THEN 3 ELSE 0 END) +
            (CASE WHEN JSON_CONTAINS(t.payment_methods, JSON_QUOTE('card'))     THEN 3 ELSE 0 END) +
            (CASE WHEN JSON_CONTAINS(t.payment_methods, JSON_QUOTE('transfer')) THEN 3 ELSE 0 END)
        END

      -- 5. Average work time in minutes (max 10)
      + CASE
          WHEN t.average_worktime IS NULL THEN 0
          WHEN t.average_worktime <= 60   THEN 10
          WHEN t.average_worktime <= 120  THEN 8
          WHEN t.average_worktime <= 180  THEN 6
          WHEN t.average_worktime >  180  THEN 3
          ELSE 0
        END

      -- 6. Disabled friendly (max 6)
      + CASE WHEN t.disabled_friendly = 1 THEN 6 ELSE 0 END

      -- 7. Kid friendly (max 6)
      + CASE WHEN t.kid_friendly = 1 THEN 6 ELSE 0 END

      -- 8. Walk-ins allowed (max 6)
      + CASE WHEN t.walkins_allowed = 1 THEN 6 ELSE 0 END

      -- 9. Days open per week (max 10)
      + CASE
          WHEN t.days_open = 3  THEN 2
          WHEN t.days_open = 4  THEN 4
          WHEN t.days_open = 5  THEN 6
          WHEN t.days_open = 6  THEN 8
          WHEN t.days_open >= 7 THEN 10
          ELSE 0
        END

      -- 10. Weekly hours open (max 6)
      + CASE
          WHEN t.weekly_hours IS NULL THEN 0
          WHEN t.weekly_hours >= 63   THEN 6
          WHEN t.weekly_hours >= 49   THEN 4
          WHEN t.weekly_hours >= 28   THEN 2
          ELSE 0
        END

    ) AS score

  FROM Providers p
  JOIN Tags t ON t.businessID = p.businessID
  WHERE
    p.service_type = ?
    AND p.parish   = ?

  ORDER BY score DESC
  LIMIT 5
`;

// ─── SEARCH ENDPOINT ───────────────────────────────────────────────────────────
// POST /api/search
// Body: { service_type: "NAIL ARTIST", parish: "Portmore" }
// Returns the top 5 scored providers
app.post('/api/search', async (req, res) => {
  const { service_type, parish } = req.body;

  // Validate required fields
  if (!service_type || !parish) {
    return res.status(400).json({
      error: 'service_type and parish are required'
    });
  }

  // Normalise inputs to match database values
  const serviceTypeMap = {
    'nail artist':    'NAIL ARTIST',
    'nail':           'NAIL ARTIST',
    'makeup artist':  'MAKEUP ARTIST',
    'makeup':         'MAKEUP ARTIST',
    'hairstylist':    'HAIRDRESSER',
    'hairdresser':    'HAIRDRESSER',
    'hair':           'HAIRDRESSER',
    'waxer':          'WAXER',
    'wax':            'WAXER',
  };

  const parishMap = {
    'kingston':           'Kingston',
    'kingston & st. andrew': 'Kingston',
    'st andrew':          'Kingston',
    'portmore':           'Portmore',
  };

  const normService = serviceTypeMap[service_type.toLowerCase()] || service_type.toUpperCase();
  const normParish  = parishMap[parish.toLowerCase()] || parish;

  try {
    const [rows] = await pool.execute(SCORING_QUERY, [normService, normParish]);

    // Parse JSON fields from MySQL
    const results = rows.map(row => ({
      ...row,
      payment_methods: typeof row.payment_methods === 'string'
        ? JSON.parse(row.payment_methods)
        : row.payment_methods,
      opening_hours: typeof row.opening_hours === 'string'
        ? JSON.parse(row.opening_hours)
        : row.opening_hours,
    }));

    res.json({
      success: true,
      service_type: normService,
      parish:       normParish,
      count:        results.length,
      results,
    });

  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: 'Search failed', details: err.message });
  }
});

// ─── AI CHAT ENDPOINT ──────────────────────────────────────────────────────────
// POST /api/chat
// Body: { messages: [...], conversationState: {} }
// Returns: { text: "AI response", searchParams: { service_type, parish } | null }
app.post('/api/chat', async (req, res) => {
  const { messages, conversationState } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({ error: 'GROQ_API_KEY not configured in .env' });
  }

  // System prompt — defines how the AI behaves
  const systemPrompt = `You are Bella, a friendly and savvy Jamaican beauty concierge for Belissima — a platform that helps people find beauty service providers in Jamaica.

Your personality: warm, conversational, occasionally playful. You can use light Jamaican expressions naturally but keep it accessible to everyone.

YOUR JOB:
1. Find out what TYPE of service the user needs: nail artist, makeup artist, hairstylist, or waxer
2. Find out what AREA they are in: Kingston or Portmore
3. Gather any extra preferences naturally through conversation:
   - Price range (cheap/affordable = under $2000 JMD, mid = $2001-$5000, premium = $5001-$9000)
   - Kid friendly (do they need to bring a child?)
   - Disabled friendly
   - Walk-ins vs appointment
   - Mobile service (provider comes to them)
   - Payment method preference (cash, card, bank transfer)
   - Time of day they need (morning, afternoon, evening)
   - How quickly the work gets done

CONVERSATION RULES:
- Ask ONE or TWO questions at a time — keep it natural, not like a form
- Once you have service type AND parish, you have enough to search
- After 2-3 back-and-forth exchanges, offer to show results
- Be concise — don't overwhelm the user

WHEN READY TO SEARCH:
Once you have the service type and parish, add this block at the very end of your message:

[SEARCH_READY]
{
  "service_type": "NAIL ARTIST",
  "parish": "Portmore"
}
[/SEARCH_READY]

Valid service_type values: "NAIL ARTIST", "MAKEUP ARTIST", "HAIRDRESSER", "WAXER"
Valid parish values: "Kingston", "Portmore"

Only include the [SEARCH_READY] block when you are genuinely ready to show results.
Current conversation context: ${JSON.stringify(conversationState || {})}`;

  try {
    const completion = await groq.chat.completions.create({
      model:       'llama-3.3-70b-versatile',
      max_tokens:  1024,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
    });

    const fullText = completion.choices[0].message.content;

    // Extract search parameters if the AI included them
    const searchMatch = fullText.match(/\[SEARCH_READY\]([\s\S]*?)\[\/SEARCH_READY\]/);
    let searchParams = null;
    let cleanText    = fullText
      .replace(/\[SEARCH_READY\][\s\S]*?\[\/SEARCH_READY\]/, '')
      .trim();

    if (searchMatch) {
      try {
        searchParams = JSON.parse(searchMatch[1].trim());
      } catch (e) {
        console.error('Failed to parse search params from AI response:', e.message);
      }
    }

    res.json({
      success:      true,
      text:         cleanText,
      searchParams: searchParams,
    });

  } catch (err) {
    console.error('Chat endpoint error:', err.message);
    res.status(500).json({ error: 'Chat request failed', details: err.message });
  }
});

// ─── HEALTH CHECK ──────────────────────────────────────────────────────────────
// GET /api/health
// Quick endpoint to verify the server and DB are running
app.get('/api/health', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT COUNT(*) as count FROM Providers');
    res.json({
      status:    'ok',
      providers: rows[0].count,
      database:  process.env.DB_NAME,
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─── START SERVER ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌺 Belissima server running on http://localhost:${PORT}`);
  console.log(`📋 Health check: http://localhost:${PORT}/api/health`);
});