require('dotenv').config();
/*
  ─── REQUIRED DATABASE MIGRATION ──────────────────────────────────────────────
  Run this SQL once in your Belissima_Database to support the Forgot Password flow:

  CREATE TABLE IF NOT EXISTS PasswordResets (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    userID     INT NOT NULL UNIQUE,
    token_hash VARCHAR(255) NOT NULL,
    expires_at DATETIME NOT NULL,
    used       TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (userID) REFERENCES Users(userID) ON DELETE CASCADE
  );
  ─────────────────────────────────────────────────────────────────────────────
*/
const express    = require('express');
const mysql      = require('mysql2/promise');
const cors       = require('cors');
const path       = require('path');
const Groq       = require('groq-sdk');
const nodemailer = require('nodemailer');
const multer     = require('multer');

const app  = express();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Multer — accept multipart form data (images stored in memory, not disk)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ─── EMAIL TRANSPORTER ────────────────────────────────────────────────────────
const mailer = nodemailer.createTransport({
  host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
  port:   parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendEmail(to, subject, html) {
  if (!process.env.SMTP_USER) {
    console.warn('⚠️  SMTP not configured — skipping email to', to);
    return;
  }
  try {
    await mailer.sendMail({ from: `"Belissima" <${process.env.SMTP_USER}>`, to, subject, html });
    console.log(`📧 Email sent to ${to}`);
  } catch (err) {
    console.error('❌ Email error:', err.message);
  }
}

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ─── DATABASE POOL ─────────────────────────────────────────────────────────────
const pool = mysql.createPool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '3306'),
  user:     process.env.DB_USER     || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME     || 'Belissima_Database',
  waitForConnections: true,
  connectionLimit:    10,
});

pool.getConnection()
  .then(conn => {
    console.log('✅ Connected to MySQL database');
    conn.release();
  })
  .catch(err => {
    console.error('❌ Database connection failed:', err.message);
  });

// ─── SIMPLE BUSINESS LOOKUP BY NAME ─────────────────────────────────────────
async function findBusinessByName(searchTerm) {
  try {
    let [rows] = await pool.execute(`
      SELECT 
        p.businessID,
        p.business_name,
        p.service_type,
        p.parish,
        p.address,
        p.phone_number,
        p.booking_link,
        t.opening_hours,
        t.starting_price,
        t.average_worktime,
        t.walkins_allowed,
        t.mobile_service,
        t.kid_friendly,
        t.disabled_friendly,
        t.payment_methods
      FROM Providers p
      JOIN Tags t ON t.businessID = p.businessID
      WHERE LOWER(p.business_name) = LOWER(?)
    `, [searchTerm]);
    
    if (rows.length === 0) {
      [rows] = await pool.execute(`
        SELECT 
          p.businessID,
          p.business_name,
          p.service_type,
          p.parish,
          p.address,
          p.phone_number,
          p.booking_link,
          t.opening_hours,
          t.starting_price,
          t.average_worktime,
          t.walkins_allowed,
          t.mobile_service,
          t.kid_friendly,
          t.disabled_friendly,
          t.payment_methods
        FROM Providers p
        JOIN Tags t ON t.businessID = p.businessID
        WHERE LOWER(p.business_name) LIKE LOWER(?)
        LIMIT 1
      `, [`%${searchTerm}%`]);
    }
    
    if (rows.length === 0) return null;
    
    const provider = rows[0];
    if (provider.opening_hours && typeof provider.opening_hours === 'string') {
      provider.opening_hours = JSON.parse(provider.opening_hours);
    }
    if (provider.payment_methods && typeof provider.payment_methods === 'string') {
      provider.payment_methods = JSON.parse(provider.payment_methods);
    }
    
    return provider;
  } catch (err) {
    console.error('Error finding business:', err);
    return null;
  }
}

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
      CASE WHEN t.starting_price BETWEEN 0 AND 2000 THEN 10
        WHEN t.starting_price BETWEEN 2001 AND 5000 THEN 8
        WHEN t.starting_price BETWEEN 5001 AND 9000 THEN 6
        WHEN t.starting_price >= 9001 THEN 3
        ELSE 0 END
      + CASE WHEN t.board_certified = 1 THEN 10 WHEN t.board_certified = 0 THEN 5 ELSE 0 END
      + CASE WHEN t.company_allowed = 1 THEN 3 ELSE 0 END
      + CASE WHEN t.payment_methods IS NULL THEN 0
          ELSE (CASE WHEN JSON_CONTAINS(t.payment_methods, JSON_QUOTE('cash')) THEN 3 ELSE 0 END)
             + (CASE WHEN JSON_CONTAINS(t.payment_methods, JSON_QUOTE('card')) THEN 3 ELSE 0 END)
             + (CASE WHEN JSON_CONTAINS(t.payment_methods, JSON_QUOTE('transfer')) THEN 3 ELSE 0 END)
        END
      + CASE WHEN t.average_worktime IS NULL THEN 0
          WHEN t.average_worktime <= 60 THEN 10
          WHEN t.average_worktime <= 120 THEN 8
          WHEN t.average_worktime <= 180 THEN 6
          WHEN t.average_worktime > 180 THEN 3
          ELSE 0 END
      + CASE WHEN t.disabled_friendly = 1 THEN 6 ELSE 0 END
      + CASE WHEN t.kid_friendly = 1 THEN 6 ELSE 0 END
      + CASE WHEN t.walkins_allowed = 1 THEN 6 ELSE 0 END
      + CASE WHEN t.days_open IS NULL THEN 0
          WHEN t.days_open = 3 THEN 2 WHEN t.days_open = 4 THEN 4
          WHEN t.days_open = 5 THEN 6 WHEN t.days_open = 6 THEN 8
          WHEN t.days_open >= 7 THEN 10 ELSE 0 END
      + CASE WHEN t.weekly_hours IS NULL THEN 0
          WHEN t.weekly_hours >= 63 THEN 6
          WHEN t.weekly_hours >= 49 THEN 4
          WHEN t.weekly_hours >= 28 THEN 2
          ELSE 0 END
    ) AS score

  FROM Providers p
  JOIN Tags t ON t.businessID = p.businessID
  WHERE p.service_type = ? AND p.parish = ?
  ORDER BY score DESC
  LIMIT 5
`;

// ─── SEARCH ENDPOINT ───────────────────────────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const { service_type, parish } = req.body;

  if (!service_type || !parish) {
    return res.status(400).json({ error: 'service_type and parish are required' });
  }

  const serviceTypeMap = {
    'nail artist': 'NAIL ARTIST', 'nail': 'NAIL ARTIST',
    'makeup artist': 'MAKE-UP ARTIST', 'make-up artist': 'MAKE-UP ARTIST', 'makeup': 'MAKE-UP ARTIST',
    'hairstylist': 'HAIRSTYLIST', 'hair': 'HAIRSTYLIST',
    'wax specialist': 'WAX SPECIALIST', 'wax': 'WAX SPECIALIST', 'waxer': 'WAX SPECIALIST',
  };

  const parishMap = {
    'kingston': 'Kingston', 'kingston & st. andrew': 'Kingston', 'st andrew': 'Kingston',
    'portmore': 'Portmore',
  };

  const normService = serviceTypeMap[service_type.toLowerCase()] || service_type.toUpperCase();
  const normParish  = parishMap[parish.toLowerCase()] || parish;

  try {
    const [rows] = await pool.execute(SCORING_QUERY, [normService, normParish]);

    const results = rows.map(row => ({
      ...row,
      payment_methods: typeof row.payment_methods === 'string' ? JSON.parse(row.payment_methods) : row.payment_methods,
      opening_hours: typeof row.opening_hours === 'string' ? JSON.parse(row.opening_hours) : row.opening_hours,
    }));

    res.json({ success: true, service_type: normService, parish: normParish, count: results.length, results });
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: 'Search failed', details: err.message });
  }
});

// ─── ALLURA SEARCH — returns ALL providers for client-side scoring (no LIMIT) ──
app.post('/api/allura/search', async (req, res) => {
  const { service_type, parish } = req.body;
  if (!service_type || !parish) return res.status(400).json({ error: 'service_type and parish required' });

  const serviceTypeMap = {
    'nail artist': 'NAIL ARTIST', 'nail': 'NAIL ARTIST',
    'makeup artist': 'MAKE-UP ARTIST', 'make-up artist': 'MAKE-UP ARTIST', 'makeup': 'MAKE-UP ARTIST',
    'hairstylist': 'HAIRSTYLIST', 'hair': 'HAIRSTYLIST',
    'wax specialist': 'WAX SPECIALIST', 'wax': 'WAX SPECIALIST', 'waxer': 'WAX SPECIALIST',
  };
  const parishMap = {
    'kingston': 'Kingston', 'kingston & st. andrew': 'Kingston', 'st andrew': 'Kingston',
    'portmore': 'Portmore',
  };

  const normService = serviceTypeMap[service_type.toLowerCase()] || service_type.toUpperCase();
  const normParish  = parishMap[parish.toLowerCase()] || parish;

  try {
    // Same query as SCORING_QUERY but without LIMIT — let client rank by preference
    const [rows] = await pool.execute(`
      SELECT
        p.businessID, p.business_name, p.service_type, p.parish,
        p.phone_number, p.insta_link, p.tiktok_link, p.facebook_link,
        p.booking_link, p.other_booking, p.address,
        t.starting_price, t.board_certified, t.company_allowed, t.payment_methods,
        t.deposit_required, t.deposit_type, t.deposit_value, t.average_worktime,
        t.walkins_allowed, t.mobile_service, t.provider_gender,
        t.kid_friendly, t.disabled_friendly, t.opening_hours, t.days_open, t.weekly_hours,
        (
          CASE WHEN t.starting_price BETWEEN 0 AND 2000 THEN 10
               WHEN t.starting_price BETWEEN 2001 AND 5000 THEN 8
               WHEN t.starting_price BETWEEN 5001 AND 9000 THEN 6
               WHEN t.starting_price >= 9001 THEN 3 ELSE 0 END
          + CASE WHEN t.board_certified = 1 THEN 10 WHEN t.board_certified = 0 THEN 5 ELSE 0 END
          + CASE WHEN t.company_allowed = 1 THEN 3 ELSE 0 END
          + CASE WHEN t.payment_methods IS NULL THEN 0
              ELSE (CASE WHEN JSON_CONTAINS(t.payment_methods, JSON_QUOTE('cash')) THEN 3 ELSE 0 END)
                 + (CASE WHEN JSON_CONTAINS(t.payment_methods, JSON_QUOTE('card')) THEN 3 ELSE 0 END)
                 + (CASE WHEN JSON_CONTAINS(t.payment_methods, JSON_QUOTE('transfer')) THEN 3 ELSE 0 END)
            END
          + CASE WHEN t.average_worktime IS NULL THEN 0
              WHEN t.average_worktime <= 60 THEN 10 WHEN t.average_worktime <= 120 THEN 8
              WHEN t.average_worktime <= 180 THEN 6 WHEN t.average_worktime > 180 THEN 3 ELSE 0 END
          + CASE WHEN t.disabled_friendly = 1 THEN 6 ELSE 0 END
          + CASE WHEN t.kid_friendly = 1 THEN 6 ELSE 0 END
          + CASE WHEN t.walkins_allowed = 1 THEN 6 ELSE 0 END
          + CASE WHEN t.days_open IS NULL THEN 0
              WHEN t.days_open = 3 THEN 2 WHEN t.days_open = 4 THEN 4
              WHEN t.days_open = 5 THEN 6 WHEN t.days_open = 6 THEN 8
              WHEN t.days_open >= 7 THEN 10 ELSE 0 END
          + CASE WHEN t.weekly_hours IS NULL THEN 0
              WHEN t.weekly_hours >= 63 THEN 6 WHEN t.weekly_hours >= 49 THEN 4
              WHEN t.weekly_hours >= 28 THEN 2 ELSE 0 END
        ) AS base_score
      FROM Providers p
      JOIN Tags t ON t.businessID = p.businessID
      WHERE p.service_type = ? AND p.parish = ?
      ORDER BY base_score DESC
    `, [normService, normParish]);

    const results = rows.map(row => ({
      ...row,
      payment_methods: typeof row.payment_methods === 'string' ? JSON.parse(row.payment_methods) : row.payment_methods,
      opening_hours:   typeof row.opening_hours   === 'string' ? JSON.parse(row.opening_hours)   : row.opening_hours,
    }));

    res.json({ success: true, service_type: normService, parish: normParish, count: results.length, results });
  } catch (err) {
    console.error('Allura search error:', err.message);
    res.status(500).json({ error: 'Search failed', details: err.message });
  }
});

// ─── GET ALL PROVIDERS BY TYPE ─────────────────────────────────────────────────
app.get('/api/providers/all/:serviceType', async (req, res) => {
  const { serviceType } = req.params;
  const validTypes = ['NAIL ARTIST', 'HAIRSTYLIST', 'MAKE-UP ARTIST', 'WAX SPECIALIST'];
  const normalizedType = serviceType.toUpperCase();
  
  if (!validTypes.includes(normalizedType)) {
    return res.status(400).json({ error: 'Invalid service type' });
  }
  
  try {
    const [rows] = await pool.execute(`
      SELECT 
        p.businessID, 
        p.business_name, 
        p.service_type, 
        p.parish, 
        p.address,
        p.phone_number,
        p.other_contact,
        p.insta_link,
        p.tiktok_link,
        p.facebook_link,
        p.booking_link,
        p.other_booking,

        t.starting_price,
        t.opening_hours,
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
        t.days_open,
        t.weekly_hours,
        pp.photo_url AS logo_url

      FROM Providers p
      JOIN Tags t ON t.businessID = p.businessID
      LEFT JOIN ProviderPhotos pp ON pp.businessID = p.businessID AND pp.sort_order = 1
      WHERE p.service_type = ?
      ORDER BY p.business_name ASC
      LIMIT 100
    `, [normalizedType]);

      const results = rows.map(row => ({
      ...row,
      opening_hours: typeof row.opening_hours === 'string'
        ? JSON.parse(row.opening_hours || '{}')
        : row.opening_hours,

      payment_methods: typeof row.payment_methods === 'string'
        ? JSON.parse(row.payment_methods || '[]')
        : row.payment_methods
    }));
    
    res.json({ success: true, service_type: normalizedType, count: results.length, results });
  } catch (err) {
    console.error('Error fetching providers:', err.message);
    res.status(500).json({ error: 'Failed to fetch providers' });
  }
});

// ─── SEARCH PROVIDER BY NAME ──────────────────────────────────────────────────
app.get('/api/provider/search', async (req, res) => {
  const { name } = req.query;
  if (!name || name.trim().length < 2) {
    return res.status(400).json({ success: false, error: 'Name query too short' });
  }

  try {
    // Exact match first, then partial
    let [rows] = await pool.execute(`
      SELECT p.businessID, p.business_name, p.service_type, p.parish, p.address,
             p.phone_number, p.other_contact, p.insta_link, p.tiktok_link,
             p.facebook_link, p.booking_link, p.other_booking,
             t.starting_price, t.board_certified, t.company_allowed, t.payment_methods,
             t.deposit_required, t.deposit_type, t.deposit_value, t.average_worktime,
             t.walkins_allowed, t.mobile_service, t.provider_gender,
             t.kid_friendly, t.disabled_friendly, t.opening_hours, t.days_open, t.weekly_hours,
             pp.photo_url AS logo_url
      FROM Providers p
      JOIN Tags t ON t.businessID = p.businessID
      LEFT JOIN ProviderPhotos pp ON pp.businessID = p.businessID AND pp.sort_order = 1
      WHERE LOWER(p.business_name) = LOWER(?)
      LIMIT 1
    `, [name.trim()]);

    if (rows.length === 0) {
      [rows] = await pool.execute(`
        SELECT p.businessID, p.business_name, p.service_type, p.parish, p.address,
               p.phone_number, p.other_contact, p.insta_link, p.tiktok_link,
               p.facebook_link, p.booking_link, p.other_booking,
               t.starting_price, t.board_certified, t.company_allowed, t.payment_methods,
               t.deposit_required, t.deposit_type, t.deposit_value, t.average_worktime,
               t.walkins_allowed, t.mobile_service, t.provider_gender,
               t.kid_friendly, t.disabled_friendly, t.opening_hours, t.days_open, t.weekly_hours,
               pp.photo_url AS logo_url
        FROM Providers p
        JOIN Tags t ON t.businessID = p.businessID
        LEFT JOIN ProviderPhotos pp ON pp.businessID = p.businessID AND pp.sort_order = 1
        WHERE LOWER(p.business_name) LIKE LOWER(?)
        LIMIT 1
      `, [`%${name.trim()}%`]);
    }

    if (rows.length === 0) {
      return res.json({ success: false, provider: null });
    }

    const provider = rows[0];
    if (provider.payment_methods && typeof provider.payment_methods === 'string')
      provider.payment_methods = JSON.parse(provider.payment_methods);
    if (provider.opening_hours && typeof provider.opening_hours === 'string')
      provider.opening_hours = JSON.parse(provider.opening_hours);

    res.json({ success: true, provider });
  } catch (err) {
    console.error('Provider search error:', err);
    res.status(500).json({ success: false, error: 'Search failed' });
  }
});

// ─── GET PROVIDER BY ID ─────────────────────────────────────────────────────────
app.get('/api/provider/:businessID', async (req, res) => {
  const { businessID } = req.params;

  try {
    const [rows] = await pool.execute(`
      SELECT p.businessID, p.business_name, p.parish, p.service_type, p.phone_number,
             p.other_contact, p.insta_link, p.tiktok_link, p.facebook_link,
             p.booking_link, p.other_booking, p.address,
             t.starting_price, t.board_certified, t.company_allowed, t.payment_methods,
             t.deposit_required, t.deposit_type, t.deposit_value, t.average_worktime,
             t.walkins_allowed, t.mobile_service, t.provider_gender, t.kid_friendly,
             t.disabled_friendly, t.opening_hours, t.days_open, t.weekly_hours
      FROM Providers p
      JOIN Tags t ON t.businessID = p.businessID
      WHERE p.businessID = ?
    `, [businessID]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Provider not found' });
    }

    const provider = rows[0];
    if (provider.payment_methods && typeof provider.payment_methods === 'string') {
      provider.payment_methods = JSON.parse(provider.payment_methods);
    }
    if (provider.opening_hours && typeof provider.opening_hours === 'string') {
      provider.opening_hours = JSON.parse(provider.opening_hours);
    }

    const [nearby] = await pool.execute(`
      SELECT p.businessID, p.business_name, p.service_type, p.parish, p.address, t.opening_hours
      FROM Providers p
      JOIN Tags t ON t.businessID = p.businessID
      WHERE p.parish = ? AND p.businessID != ?
      LIMIT 3
    `, [provider.parish, businessID]);

    res.json({ success: true, provider, nearby: nearby.map(n => ({ ...n, opening_hours: typeof n.opening_hours === 'string' ? JSON.parse(n.opening_hours) : n.opening_hours })) });
  } catch (err) {
    console.error('Provider fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch provider' });
  }
});

// ─── PRICE FORMATTING HELPER ───────────────────────────────────────────────────
const USD_TO_JMD = 157; // 1 USD ≈ J$157

function formatPriceJMD(price) {
  if (price === null || price === undefined || price === '' || price === 'NA') return 'Contact for price';
  const num = typeof price === 'number' ? price : parseFloat(String(price).replace(/[^0-9.]/g, ''));
  if (isNaN(num)) return 'Contact for price';
  // Values under 500 were entered as USD in the original data
  const jmd = num < 500 ? Math.round(num * USD_TO_JMD / 100) * 100 : Math.round(num);
  return `J$${jmd.toLocaleString()} up`;
}

// ─── HELPER FUNCTION TO GENERATE TAG BADGES ────────────────────────────────────
function generateTagBadges(provider) {
  let badges = [];
  
  if (provider.kid_friendly === 1) {
    badges.push({ emoji: "👶", text: "Kid Friendly", color: "#e8f5e9", textColor: "#2e7d32" });
  }
  
  if (provider.walkins_allowed === 1) {
    badges.push({ emoji: "🚶", text: "Walk-ins Welcome", color: "#e3f2fd", textColor: "#1565c0" });
  }
  
  if (provider.mobile_service === 1) {
    badges.push({ emoji: "🚗", text: "Mobile Service", color: "#fff3e0", textColor: "#e65100" });
  }
  
  if (provider.disabled_friendly === 1) {
    badges.push({ emoji: "♿", text: "Accessible", color: "#e8eaf6", textColor: "#3949ab" });
  }
  
  if (provider.board_certified === 1) {
    badges.push({ emoji: "✅", text: "Board Certified", color: "#e0f2f1", textColor: "#00695c" });
  }
  
  
  return badges;
}

// ─── GET PHOTOS FOR A PROVIDER ────────────────────────────────────────────────
app.get('/api/provider/:businessID/photos', async (req, res) => {
  const { businessID } = req.params;
  try {
    const [photos] = await pool.execute(
      `SELECT photoID, businessID, photo_url, is_primary, sort_order
       FROM ProviderPhotos
       WHERE businessID = ?
       ORDER BY sort_order ASC`,
      [businessID]
    );
    res.json({ success: true, photos });
  } catch (err) {
    console.error('Photo fetch error:', err.message);
    res.status(500).json({ success: false, photos: [], error: 'Failed to fetch photos' });
  }
});

// ─── AI CHAT ENDPOINT WITH DYNAMIC RECOMMENDATIONS ─────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages, conversationState } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({ error: 'GROQ_API_KEY not configured in .env' });
  }

  const lastUserMessage = messages.filter(m => m.role === 'user').pop()?.content || '';
  console.log('📝 User message:', lastUserMessage);
  
  // ---- FIRST: Check for country (MUST be Jamaica) ----
  const invalidCountries = [
    'usa', 'united states', 'america', 'canada', 'uk', 'united kingdom', 'england', 
    'france', 'germany', 'italy', 'spain', 'australia', 'new zealand', 'china', 
    'japan', 'korea', 'india', 'brazil', 'mexico', 'south africa', 'nigeria', 
    'ghana', 'kenya', 'trinidad', 'barbados', 'bahamas', 'cayman', 'turks', 'caicos',
    'europe', 'asia', 'africa', 'south america', 'north america', 'london', 'paris',
    'new york', 'miami', 'toronto', 'vancouver', 'sydney', 'melbourne'
  ];
  
  let detectedInvalidCountry = null;
  for (const country of invalidCountries) {
    if (lastUserMessage.toLowerCase().includes(country)) {
      detectedInvalidCountry = country;
      break;
    }
  }
  
  const outsideJamaicaPattern = /(?:in|from|at|near|live in)\s+([A-Za-z\s]+)(?:\,|\.|\?|$)/i;
  const locationMatch = lastUserMessage.match(outsideJamaicaPattern);
  if (locationMatch && !detectedInvalidCountry) {
    const mentionedLocation = locationMatch[1].trim().toLowerCase();
    const jamaicanTerms = ['jamaica', 'kingston', 'portmore', 'st andrew', 'st catherine', 'clarendon', 'st ann', 'st mary', 'st thomas', 'portland', 'treasury', 'st elizabeth', 'manchester', 'westmoreland', 'hanover', 'trelawny'];
    const isJamaican = jamaicanTerms.some(term => mentionedLocation.includes(term));
    if (!isJamaican && mentionedLocation.length > 3) {
      detectedInvalidCountry = mentionedLocation;
    }
  }
  
  if (detectedInvalidCountry) {
    console.log('🌎 Non-Jamaica location detected:', detectedInvalidCountry);
    const countryResponse = `🌸 I'm sorry, sweetheart! 🌸

Belissima only operates in Jamaica in Kingston, St. Andrew and Portmore right now. We don't have any beauty providers in ${detectedInvalidCountry}.

🌴 We're a Jamaican platform dedicated to connecting you with the best local beauty talent!

Here's what you can find in Jamaica:
💅 Nail artists
💇‍♀️ Hairstylists
💄 Makeup artists
🕯️ Wax specialists

What service are you looking for in Kingston or Portmore? I'd love to help you find the perfect match! ✨`;
    
    return res.json({
      success: true,
      text: countryResponse,
      searchParams: null
    });
  }
  
  // ---- SECOND: Check for out-of-area locations (MUST be Kingston or Portmore) ----
  const validParishes = ['kingston', 'portmore', 'st andrew', 'kingston & st andrew'];
  const outOfAreaKeywords = [
    'montego bay', 'mobay', 'ocho rios', 'negri', 'spanish town', 
    'mandeville', 'may pen', 'savanna la mar', 'falmouth', 'st ann', 'st mary', 
    'st thomas', 'st elizabeth', 'trelawny', 'hanover', 'westmoreland', 'clarendon', 
    'st catherine', 'browns town', 'christiana', 'highgate', 'port antonio', 
    'morant bay', 'yallahs', 'linstead', 'bog walk', 'old harbour', 'chapelton',
    'spaldings', 'porus', 'albert town', 'bamboo', 'st anns bay', 'runaway bay',
    'discovery bay', 'lucea', 'black river', 'santa cruz', 'junction', 'malvern'
  ];
  
  let detectedOutOfArea = null;
  for (const keyword of outOfAreaKeywords) {
    if (lastUserMessage.toLowerCase().includes(keyword)) {
      detectedOutOfArea = keyword;
      break;
    }
  }
  
  const parishPattern = /(?:in|at|near|from|live in)\s+([A-Za-z\s&]+)(?:\?|\.|$|\,)/i;
  const parishMatch = lastUserMessage.match(parishPattern);
  if (parishMatch && !detectedOutOfArea) {
    const mentionedParish = parishMatch[1].trim().toLowerCase();
    const isValid = validParishes.some(vp => mentionedParish.includes(vp) || vp.includes(mentionedParish));
    if (!isValid && mentionedParish.length > 3) {
      detectedOutOfArea = mentionedParish;
    }
  }
  
  if (detectedOutOfArea) {
    console.log('🚫 Out of area detected:', detectedOutOfArea);
    const outOfAreaResponse = `🌸 I'm sorry, sweetheart! 🌸

Belissima only has beauty providers in Kingston, St. Andrew and Portmore right now. We don't have any providers in ${detectedOutOfArea} yet.

We're working on expanding to other parishes in Jamaica soon!

In the meantime, what type of service are you looking for in Kingston or Portmore? I can help you find:

💅 Nail artists
💇‍♀️ Hairstylists  
💄 Makeup artists
🕯️ Wax specialists

Just tell me what you need and I'll find the perfect match for you! ✨`;
    
    return res.json({
      success: true,
      text: outOfAreaResponse,
      searchParams: null
    });
  }
  
  // ---- DYNAMIC RECOMMENDATION SYSTEM ----
  const serviceKeywords = {
    'hairstylist': 'HAIRSTYLIST',
    'hair': 'HAIRSTYLIST',
    'nail artist': 'NAIL ARTIST',
    'nails': 'NAIL ARTIST',
    'makeup artist': 'MAKE-UP ARTIST',
    'makeup': 'MAKE-UP ARTIST',
    'wax specialist': 'WAX SPECIALIST',
    'wax': 'WAX SPECIALIST',
    'waxer': 'WAX SPECIALIST'
  };
  
  const locationKeywords = ['portmore', 'kingston', 'st andrew'];
  
  const dayMap = {
    'monday': 'monday', 'mon': 'monday',
    'tuesday': 'tuesday', 'tue': 'tuesday', 'tues': 'tuesday',
    'wednesday': 'wednesday', 'wed': 'wednesday',
    'thursday': 'thursday', 'thu': 'thursday', 'thurs': 'thursday',
    'friday': 'friday', 'fri': 'friday',
    'saturday': 'saturday', 'sat': 'saturday',
    'sunday': 'sunday', 'sun': 'sunday'
  };
  
  let detectedService = null;
  let detectedLocation = null;
  let detectedDay = null;
  
  let wantsKidFriendly = lastUserMessage.toLowerCase().includes('kid') || 
                         lastUserMessage.toLowerCase().includes('child') || 
                         lastUserMessage.toLowerCase().includes('children') ||
                         lastUserMessage.toLowerCase().includes('bring my kids') ||
                         lastUserMessage.toLowerCase().includes('kid friendly');
  
  let wantsCheapest = lastUserMessage.toLowerCase().includes('cheap') || 
                      lastUserMessage.toLowerCase().includes('affordable') ||
                      lastUserMessage.toLowerCase().includes('lowest price') ||
                      lastUserMessage.toLowerCase().includes('budget') ||
                      lastUserMessage.toLowerCase().includes('least expensive');
  
  let wantsMostExpensive = lastUserMessage.toLowerCase().includes('expensive') || 
                           lastUserMessage.toLowerCase().includes('luxury') ||
                           lastUserMessage.toLowerCase().includes('high end') ||
                           lastUserMessage.toLowerCase().includes('premium') ||
                           lastUserMessage.toLowerCase().includes('highest price') ||
                           lastUserMessage.toLowerCase().includes('most expensive');
  
  let wantsFastest = lastUserMessage.toLowerCase().includes('quick') || 
                     lastUserMessage.toLowerCase().includes('fast') ||
                     lastUserMessage.toLowerCase().includes('shortest time') ||
                     lastUserMessage.toLowerCase().includes('less time');
  
  let wantsLongest = lastUserMessage.toLowerCase().includes('long') || 
                     lastUserMessage.toLowerCase().includes('slow') ||
                     lastUserMessage.toLowerCase().includes('longest time') ||
                     lastUserMessage.toLowerCase().includes('takes the most time') ||
                     lastUserMessage.toLowerCase().includes('thorough');
  
  let wantsWalkins = lastUserMessage.toLowerCase().includes('walk in') || 
                     lastUserMessage.toLowerCase().includes('walk-in') ||
                     lastUserMessage.toLowerCase().includes('no appointment');
  
  let wantsMobile = lastUserMessage.toLowerCase().includes('mobile') || 
                    lastUserMessage.toLowerCase().includes('come to me') ||
                    lastUserMessage.toLowerCase().includes('at home');
  
  for (const [dayKeyword, dayValue] of Object.entries(dayMap)) {
    if (lastUserMessage.toLowerCase().includes(dayKeyword)) {
      detectedDay = dayValue;
      break;
    }
  }
  
  for (const [keyword, service] of Object.entries(serviceKeywords)) {
    if (lastUserMessage.toLowerCase().includes(keyword)) {
      detectedService = service;
      break;
    }
  }
  
  for (const loc of locationKeywords) {
    if (lastUserMessage.toLowerCase().includes(loc)) {
      detectedLocation = loc === 'st andrew' ? 'Kingston' : loc.charAt(0).toUpperCase() + loc.slice(1);
      break;
    }
  }
  
  let recommendationsResponse = null;
  if (detectedService && detectedLocation) {
    console.log(`🔍 Getting recommendations for: ${detectedService} in ${detectedLocation}`);
    console.log(`Preferences: Cheap:${wantsCheapest}, Expensive:${wantsMostExpensive}, Fast:${wantsFastest}, Long:${wantsLongest}, Kid:${wantsKidFriendly}, Day:${detectedDay}, Walk-ins:${wantsWalkins}, Mobile:${wantsMobile}`);
    
    try {
      const [allRows] = await pool.execute(`
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
          t.weekly_hours
        FROM Providers p
        JOIN Tags t ON t.businessID = p.businessID
        WHERE p.service_type = ? AND p.parish = ?
      `, [detectedService, detectedLocation]);
      
      if (allRows && allRows.length > 0) {
        let providers = allRows.map(row => ({
          ...row,
          payment_methods: typeof row.payment_methods === 'string' ? JSON.parse(row.payment_methods) : row.payment_methods,
          opening_hours: typeof row.opening_hours === 'string' ? JSON.parse(row.opening_hours) : row.opening_hours,
        }));
        
        providers = providers.map(provider => {
          let dynamicScore = 0;
          
          let openOnRequestedDay = false;
          let requestedDayHours = null;
          if (detectedDay && provider.opening_hours && provider.opening_hours[detectedDay]) {
            requestedDayHours = provider.opening_hours[detectedDay];
            if (requestedDayHours && requestedDayHours.open && requestedDayHours.close) {
              openOnRequestedDay = true;
            }
          }
          
          let baseScore = 0;
          if (provider.starting_price) {
            if (provider.starting_price <= 2000) baseScore += 10;
            else if (provider.starting_price <= 5000) baseScore += 8;
            else if (provider.starting_price <= 9000) baseScore += 6;
            else baseScore += 3;
          }
          if (provider.board_certified === 1) baseScore += 10;
          else if (provider.board_certified === 0) baseScore += 5;
          if (provider.company_allowed === 1) baseScore += 3;
          if (provider.payment_methods) {
            if (provider.payment_methods.includes('cash')) baseScore += 3;
            if (provider.payment_methods.includes('card')) baseScore += 3;
            if (provider.payment_methods.includes('transfer')) baseScore += 3;
          }
          if (provider.average_worktime) {
            if (provider.average_worktime <= 60) baseScore += 10;
            else if (provider.average_worktime <= 120) baseScore += 8;
            else if (provider.average_worktime <= 180) baseScore += 6;
            else baseScore += 3;
          }
          if (provider.disabled_friendly === 1) baseScore += 6;
          if (provider.kid_friendly === 1) baseScore += 6;
          if (provider.walkins_allowed === 1) baseScore += 6;
          if (provider.days_open) {
            if (provider.days_open >= 7) baseScore += 10;
            else if (provider.days_open >= 6) baseScore += 8;
            else if (provider.days_open >= 5) baseScore += 6;
            else if (provider.days_open >= 4) baseScore += 4;
            else if (provider.days_open >= 3) baseScore += 2;
          }
          if (provider.weekly_hours) {
            if (provider.weekly_hours >= 63) baseScore += 6;
            else if (provider.weekly_hours >= 49) baseScore += 4;
            else if (provider.weekly_hours >= 28) baseScore += 2;
          }
          
          dynamicScore += baseScore;
          
          if (detectedDay) {
            if (openOnRequestedDay) {
              dynamicScore += 35;
            } else {
              dynamicScore -= 15;
            }
          }
          
          if (wantsCheapest && provider.starting_price) {
            if (provider.starting_price <= 2000) dynamicScore += 30;
            else if (provider.starting_price <= 5000) dynamicScore += 20;
            else if (provider.starting_price <= 9000) dynamicScore += 10;
            else dynamicScore += 5;
          }
          
          if (wantsMostExpensive && provider.starting_price) {
            if (provider.starting_price >= 9000) dynamicScore += 30;
            else if (provider.starting_price >= 5000) dynamicScore += 20;
            else if (provider.starting_price >= 2000) dynamicScore += 10;
            else dynamicScore += 5;
          }
          
          if (wantsFastest && provider.average_worktime) {
            if (provider.average_worktime <= 30) dynamicScore += 30;
            else if (provider.average_worktime <= 60) dynamicScore += 20;
            else if (provider.average_worktime <= 90) dynamicScore += 10;
            else dynamicScore += 5;
          }
          
          if (wantsLongest && provider.average_worktime) {
            if (provider.average_worktime >= 180) dynamicScore += 30;
            else if (provider.average_worktime >= 120) dynamicScore += 20;
            else if (provider.average_worktime >= 60) dynamicScore += 10;
            else dynamicScore += 5;
          }
          
          if (wantsKidFriendly && provider.kid_friendly === 1) {
            dynamicScore += 25;
          }
          
          if (wantsWalkins && provider.walkins_allowed === 1) {
            dynamicScore += 20;
          }
          
          if (wantsMobile && provider.mobile_service === 1) {
            dynamicScore += 20;
          }
          
          return { ...provider, dynamicScore, openOnRequestedDay, requestedDayHours };
        });
        
        // ========== SORTING LOGIC ==========
        if (wantsCheapest) {
          providers.sort((a, b) => {
            const priceA = a.starting_price || Infinity;
            const priceB = b.starting_price || Infinity;
            return priceA - priceB;
          });
          console.log('💰 Sorting by cheapest first');
        } else if (wantsMostExpensive) {
          providers.sort((a, b) => {
            const priceA = a.starting_price || 0;
            const priceB = b.starting_price || 0;
            return priceB - priceA;
          });
          console.log('💎 Sorting by most expensive first');
        } else if (wantsFastest) {
          providers.sort((a, b) => {
            const timeA = a.average_worktime || Infinity;
            const timeB = b.average_worktime || Infinity;
            return timeA - timeB;
          });
          console.log('⚡ Sorting by fastest first');
        } else if (wantsLongest) {
          providers.sort((a, b) => {
            const timeA = a.average_worktime || 0;
            const timeB = b.average_worktime || 0;
            return timeB - timeA;
          });
          console.log('🐢 Sorting by longest time first');
        } else {
          providers.sort((a, b) => b.dynamicScore - a.dynamicScore);
          console.log('🏆 Sorting by dynamic score');
        }
        
        const topProviders = providers.slice(0, 5);
        
        let rankingDescription = "Based on our smart scoring system";
        if (detectedDay) {
          const dayName = detectedDay.charAt(0).toUpperCase() + detectedDay.slice(1);
          rankingDescription = `📅 Ranked by ${dayName} availability (open on ${dayName} first)`;
        } else if (wantsCheapest) rankingDescription = "💰 Ranked by price (cheapest first)";
        else if (wantsMostExpensive) rankingDescription = "💎 Ranked by price (most expensive first)";
        else if (wantsFastest) rankingDescription = "⏱️ Ranked by speed (quickest first)";
        else if (wantsLongest) rankingDescription = "🐢 Ranked by duration (longest session first)";
        else if (wantsKidFriendly) rankingDescription = "👶 Ranked by kid-friendliness";
        else if (wantsWalkins) rankingDescription = "🚶 Ranked by walk-in availability";
        else if (wantsMobile) rankingDescription = "🚗 Ranked by mobile service availability";
        else rankingDescription = "🏆 Ranked by overall quality score";
        
        recommendationsResponse = `<div style="font-family: 'Chivo', sans-serif; width: 100%;">
          
          <div style="background: linear-gradient(135deg, #8a2347, #661731); border-radius: 16px; padding: 20px; margin-bottom: 20px; color: white; text-align: center;">
            <div style="font-size: 40px; margin-bottom: 8px;">🎯</div>
            <h2 style="margin: 0; font-family: 'Playfair Display SC', serif; font-size: 22px;">Top ${topProviders.length} ${detectedService.replace('_', ' ')} in ${detectedLocation}</h2>
            <p style="margin: 8px 0 0; opacity: 0.9; font-size: 13px;">${rankingDescription}</p>
          </div>
          
          <div style="display: flex; flex-direction: column; gap: 16px;">`;
        
        topProviders.forEach((provider, index) => {
          let reasonText = '';
          
          if (detectedDay) {
            const dayName = detectedDay.charAt(0).toUpperCase() + detectedDay.slice(1);
            if (provider.openOnRequestedDay && provider.requestedDayHours) {
              reasonText = `📅 Open on ${dayName} (${provider.requestedDayHours.open}–${provider.requestedDayHours.close}) • Perfect for your schedule! ✨`;
            } else if (provider.openOnRequestedDay) {
              reasonText = `📅 Open on ${dayName} • Great availability for you! ✨`;
            } else {
              reasonText = `❌ Closed on ${dayName} • May not work for your schedule`;
            }
          } else if (wantsCheapest && provider.starting_price) {
            reasonText = `💰 Cheapest option • ${formatPriceJMD(provider.starting_price)}`;
          } else if (wantsMostExpensive && provider.starting_price) {
            reasonText = `💎 Luxury option • ${formatPriceJMD(provider.starting_price)}`;
          } else if (wantsFastest && provider.average_worktime) {
            reasonText = `⚡ Fastest service • ~${provider.average_worktime} min`;
          } else if (wantsLongest && provider.average_worktime) {
            reasonText = `🐢 Takes their time • ~${provider.average_worktime} min (thorough service!)`;
          } else if (wantsKidFriendly && provider.kid_friendly === 1) {
            reasonText = `👶 Kid-friendly • Great for families`;
          } else if (wantsWalkins && provider.walkins_allowed === 1) {
            reasonText = `🚶 Walk-ins welcome • No appointment needed`;
          } else if (wantsMobile && provider.mobile_service === 1) {
            reasonText = `🚗 Mobile service • They come to you!`;
          } else {
            if (provider.dynamicScore >= 100) reasonText = '🏆 Top rated • Excellent match';
            else if (provider.dynamicScore >= 80) reasonText = '⭐ Great choice • Highly recommended';
            else if (provider.dynamicScore >= 60) reasonText = '✨ Good option • Solid choice';
            else reasonText = '💫 Promising provider • Worth checking out';
          }
          
          // Generate tag badges
          const badges = generateTagBadges(provider);
          let badgesHtml = '';
          if (badges.length > 0) {
            badgesHtml = `<div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px;">`;
            for (const badge of badges) {
              badgesHtml += `<span style="display: inline-block; background: ${badge.color}; color: ${badge.textColor}; padding: 2px 8px; border-radius: 12px; font-size: 10px; font-weight: 500;">${badge.emoji} ${badge.text}</span>`;
            }
            badgesHtml += `</div>`;
          }
          
          let hoursBadge = '';
          if (detectedDay && provider.openOnRequestedDay && provider.requestedDayHours) {
            hoursBadge = `<div style="margin-top: 6px; font-size: 10px; color: #2e7d32; background: #e8f5e9; display: inline-block; padding: 2px 8px; border-radius: 12px;">🕐 ${detectedDay.charAt(0).toUpperCase() + detectedDay.slice(1)}: ${provider.requestedDayHours.open}–${provider.requestedDayHours.close}</div>`;
          }
          
          recommendationsResponse += `
            <div style="background: white; border-radius: 14px; padding: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); border-left: 4px solid #8a2347;">
              <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 10px;">
                <div>
                  <div style="font-size: 24px; font-weight: bold; color: #8a2347;">#${index + 1}</div>
                  <h3 style="margin: 4px 0 0; font-size: 16px;">${provider.business_name}</h3>
                  <div style="font-size: 11px; color: #6a5760; margin-top: 4px;">${provider.service_type?.replace('_', ' ')}</div>
                  ${hoursBadge}
                  ${badgesHtml}
                </div>
                <div style="text-align: right;">
                  <div style="font-size: 13px; font-weight: bold;">💰 ${provider.starting_price ? formatPriceJMD(provider.starting_price) : 'Contact for price'}</div>
                  ${provider.average_worktime ? `<div style="font-size: 11px; color: #6a5760;">⏱️ ~${provider.average_worktime} min</div>` : ''}
                </div>
              </div>
              
              <div style="margin-top: 10px; padding-top: 8px; border-top: 1px solid #f0d0dd; font-size: 12px; color: #661731;">
                📍 ${provider.address || provider.parish || 'Location available'}
              </div>
              
              <div style="margin-top: 8px; font-size: 11px; color: #8a2347; background: #f8f3f6; padding: 6px 10px; border-radius: 8px;">
                💡 ${reasonText}
              </div>
              
              <div style="margin-top: 12px;">
                <a href="provider.html?id=${provider.businessID}" style="display: inline-block; background: linear-gradient(135deg, #8a2347, #661731); color: white; padding: 8px 20px; border-radius: 30px; text-decoration: none; font-size: 12px; font-weight: bold;">✨ View Profile</a>
              </div>
            </div>`;
        });
        
        recommendationsResponse += `
          </div>
          
          <div style="text-align: center; margin-top: 20px; padding: 16px; background: #f8f3f6; border-radius: 14px;">
            <p style="margin: 0; font-size: 12px; color: #6a5760;">💖 These Jamaican providers were ranked based on your preferences. You can ask for "cheapest", "most expensive", "fastest", "longest time", "kid-friendly", "walk-ins", or "mobile service"! 💖</p>
          </div>
        </div>`;
        
        console.log('✅ Generated dynamic recommendations');
      } else {
        recommendationsResponse = `🌸 No providers found 🌸\n\nI couldn't find any ${detectedService?.replace('_', ' ')} in ${detectedLocation} right now. Would you like me to search for a different service type or location in Jamaica?`;
      }
    } catch (err) {
      console.error('Error getting recommendations:', err);
    }
  }
  
  if (recommendationsResponse) {
    return res.json({
      success: true,
      text: recommendationsResponse,
      searchParams: null
    });
  }
  
  // ---- BUSINESS LOOKUP ----
  const [allBusinesses] = await pool.execute(`
    SELECT business_name, businessID FROM Providers
  `);
  
  let matchedBusiness = null;
  let matchedBusinessName = null;
  
  for (const biz of allBusinesses) {
    if (lastUserMessage.toLowerCase().includes(biz.business_name.toLowerCase())) {
      matchedBusinessName = biz.business_name;
      matchedBusiness = await findBusinessByName(matchedBusinessName);
      break;
    }
  }
  
  if (!matchedBusiness) {
    const words = lastUserMessage.split(/\s+/);
    for (const word of words) {
      if (word.length > 3) {
        for (const biz of allBusinesses) {
          if (biz.business_name.toLowerCase().includes(word.toLowerCase()) || 
              word.toLowerCase().includes(biz.business_name.toLowerCase().split(' ')[0])) {
            matchedBusiness = await findBusinessByName(biz.business_name);
            matchedBusinessName = biz.business_name;
            break;
          }
        }
      }
      if (matchedBusiness) break;
    }
  }
  
  let formattedResponse = null;
  if (matchedBusiness) {
    formattedResponse = formatBusinessResponse(matchedBusiness);
    console.log('✅ Found business:', matchedBusiness.business_name);
  }
  
  const systemPrompt = `You are Allura, a friendly and girly beauty assistant for Belissima.

Your personality: warm, conversational, playful, and cute. Use emojis occasionally. Keep responses concise and helpful.

IMPORTANT RULES:
1. You ONLY operate in JAMAICA. If anyone asks about services outside Jamaica, politely say you only cover Jamaica.
2. Within Jamaica, you ONLY have providers in Kingston and Portmore.
3. If business data is provided below, USE IT EXACTLY as shown.
4. When a user asks about a specific business, respond with the business information provided.
5. NEVER make up business hours or information.

GEOGRAPHIC LIMITATION:
- Country: JAMAICA ONLY
- Parishes: KINGSTON and PORTMORE ONLY

Your job is to help users find beauty service providers in Jamaica but ONLY in Kingston or Portmore.

WHEN READY TO SEARCH:
Once you have service type AND parish (must be Kingston or Portmore), add: [SEARCH_READY] { "service_type": "NAIL ARTIST", "parish": "Portmore" } [/SEARCH_READY]

Valid service_type: "NAIL ARTIST", "MAKE-UP ARTIST", "HAIRSTYLIST", "WAX SPECIALIST"
Valid parish: "Kingston", "Portmore" ONLY`;

  try {
    if (formattedResponse) {
      return res.json({
        success: true,
        text: formattedResponse,
        searchParams: null
      });
    }
    
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 1024,
      temperature: 0.7,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
    });

    let fullText = completion.choices[0].message.content;
    console.log('🤖 AI Response:', fullText);

    const searchMatch = fullText.match(/\[SEARCH_READY\]([\s\S]*?)\[\/SEARCH_READY\]/);
    let searchParams = null;
    let cleanText = fullText.replace(/\[SEARCH_READY\][\s\S]*?\[\/SEARCH_READY\]/, '').trim();

    if (searchMatch) {
      try {
        searchParams = JSON.parse(searchMatch[1].trim());
        
        if (searchParams.parish && !['Kingston', 'Portmore'].includes(searchParams.parish)) {
          console.log('🚫 AI tried to search for invalid parish:', searchParams.parish);
          const invalidParishResponse = `🌸 I'm sorry, sweetheart! 🌸\n\nI can only search for beauty providers in Kingston, St. Andrew and Portmore right now. ${searchParams.parish} is not in our service area yet.\n\nWhat type of service are you looking for in Kingston or Portmore? I'd love to help you find the perfect Jamaican beauty match! ✨`;
          return res.json({
            success: true,
            text: invalidParishResponse,
            searchParams: null
          });
        }
      } catch (e) {
        console.error('Failed to parse search params:', e.message);
      }
    }

    res.json({ success: true, text: cleanText, searchParams });
  } catch (err) {
    console.error('Chat endpoint error:', err.message);
    res.status(500).json({ error: 'Chat request failed', details: err.message });
  }
});

// ─── FORMAT BUSINESS INFO WITH CLICKABLE BUTTON AND BETTER STYLING ──────────────
function formatBusinessResponse(business) {
  if (!business) return null;
  
  function areAllDaysClosed(openingHours) {
    if (!openingHours) return false;
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    for (const day of days) {
      const dayHours = openingHours[day];
      if (dayHours && dayHours.open && dayHours.close) {
        return false;
      }
    }
    return true;
  }
  
  function formatHoursHorizontal(openingHours) {
    if (!openingHours) return '<p>📅 By appointment only - Please contact provider directly</p>';
    
    if (areAllDaysClosed(openingHours)) {
      return '<div style="background: rgba(138,35,71,0.08); border-radius: 12px; padding: 16px; text-align: center;"><span style="font-size: 24px;">📅</span><br><strong>By Appointment Only</strong><br><span style="font-size: 12px; color: #6a5760;">This business operates on an appointment basis. Please contact them directly to schedule your visit.</span></div>';
    }
    
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const today = new Date().getDay() - 1;
    
    let hoursHtml = '<div style="display: flex; flex-wrap: wrap; gap: 8px; justify-content: space-between;">';
    
    for (let i = 0; i < days.length; i++) {
      const dayHours = openingHours[days[i]];
      let timeDisplay = '';
      let isToday = i === today;
      
      if (dayHours && dayHours.open && dayHours.close) {
        timeDisplay = `${dayHours.open}–${dayHours.close}`;
      } else {
        timeDisplay = 'Closed';
      }
      
      const dayStyle = isToday ? 'background: linear-gradient(135deg, #8a2347, #661731); color: white;' : 'background: #f8f3f6; color: #1a1a1a;';
      
      hoursHtml += `
        <div style="flex: 1; min-width: 70px; text-align: center; padding: 8px 4px; border-radius: 12px; ${dayStyle}">
          <div style="font-size: 11px; font-weight: 600; margin-bottom: 4px;">${dayNames[i]}</div>
          <div style="font-size: 10px;">${timeDisplay}</div>
        </div>`;
    }
    hoursHtml += '</div>';
    return hoursHtml;
  }
  
  function formatPaymentMethods(methods) {
    if (!methods || !methods.length) return 'Not specified';
    const badges = methods.map(m => 
      `<span style="display: inline-block; background: rgba(138,35,71,0.12); color: #661731; padding: 6px 14px; border-radius: 25px; font-size: 12px; margin: 3px;">${m.charAt(0).toUpperCase() + m.slice(1)}</span>`
    ).join('');
    return badges;
  }
  
  // Generate tag badges for single business view
  const tagBadges = generateTagBadges(business);
  let tagBadgesHtml = '';
  if (tagBadges.length > 0) {
    tagBadgesHtml = `<div style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px;">`;
    for (const badge of tagBadges) {
      tagBadgesHtml += `<span style="display: inline-block; background: ${badge.color}; color: ${badge.textColor}; padding: 4px 12px; border-radius: 20px; font-size: 11px; font-weight: 500;">${badge.emoji} ${badge.text}</span>`;
    }
    tagBadgesHtml += `</div>`;
  }
  
  let response = `<div style="font-family: 'Chivo', sans-serif; width: 100%;">
    
    <div style="background: linear-gradient(135deg, #8a2347, #661731); border-radius: 16px; padding: 16px 20px; margin-bottom: 16px; color: white; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px;">
      <div>
        <div style="font-size: 32px; margin-bottom: 4px;">✨</div>
        <h2 style="margin: 0; font-family: 'Playfair Display SC', serif; font-size: 22px; letter-spacing: 0.5px;">${business.business_name}</h2>
        <p style="margin: 4px 0 0; opacity: 0.85; font-size: 12px;">${business.service_type?.replace('_', ' ') || 'Beauty Provider'}</p>
      </div>
      <div style="background: rgba(255,255,255,0.15); border-radius: 12px; padding: 8px 16px; text-align: center;">
        <div style="font-size: 20px;">📍</div>
        <div style="font-size: 11px; font-weight: 600;">${business.parish || 'Jamaica'}</div>
      </div>
    </div>
    
    ${tagBadgesHtml}
    
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px;">
      
      <div style="background: white; border-radius: 14px; padding: 14px; box-shadow: 0 2px 8px rgba(0,0,0,0.04);">
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
          <span style="font-size: 20px;">📞</span>
          <span style="font-size: 12px; color: #8a2347; font-weight: 600;">CONTACT</span>
        </div>
        <div style="font-size: 13px; font-weight: 500; word-break: break-word;">${business.phone_number || 'Not specified'}</div>
        ${business.address ? `<div style="font-size: 11px; color: #6a5760; margin-top: 6px;">${business.address}</div>` : ''}
      </div>
      
      <div style="background: white; border-radius: 14px; padding: 14px; box-shadow: 0 2px 8px rgba(0,0,0,0.04);">
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
          <span style="font-size: 20px;">💰</span>
          <span style="font-size: 12px; color: #8a2347; font-weight: 600;">PRICING</span>
        </div>
        <div style="font-size: 13px; font-weight: 500;">${business.starting_price ? formatPriceJMD(business.starting_price) : 'Contact for pricing'}</div>
        ${business.average_worktime ? `<div style="font-size: 11px; color: #6a5760; margin-top: 4px;">⏱️ ~${business.average_worktime} min session</div>` : ''}
      </div>
    </div>
    
    <div style="background: white; border-radius: 14px; padding: 16px; margin-bottom: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.04);">
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
        <span style="font-size: 20px;">🕐</span>
        <span style="font-size: 13px; color: #8a2347; font-weight: 600;">OPENING HOURS</span>
      </div>
      ${formatHoursHorizontal(business.opening_hours)}
    </div>`;
  
  if (business.payment_methods && business.payment_methods.length) {
    response += `<div style="background: white; border-radius: 14px; padding: 16px; margin-bottom: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.04);">
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px;">
        <span style="font-size: 20px;">💳</span>
        <span style="font-size: 13px; color: #8a2347; font-weight: 600;">PAYMENT METHODS</span>
      </div>
      <div>${formatPaymentMethods(business.payment_methods)}</div>
    </div>`;
  }
  
  response += `
    <div style="text-align: center; margin-top: 8px;">
      <a href="provider.html?id=${business.businessID}" style="display: inline-block; background: linear-gradient(135deg, #8a2347, #661731); color: white; padding: 12px 28px; border-radius: 40px; text-decoration: none; font-weight: bold; font-family: inherit; font-size: 14px; box-shadow: 0 4px 12px rgba(138,35,71,0.3);">✨ View Full Profile ✨</a>
    </div>
    
  </div>`;
  
  return response;
}

// ─── SIGNUP ENDPOINT ─────────────────────────────────────────────────────────
app.post('/api/signup', async (req, res) => {
  const { name, email, password } = req.body;

  // Then split the name:
  const nameParts = name.trim().split(' ');
  const firstname = nameParts[0] || '';
  const lastname = nameParts.slice(1).join(' ') || '';

  if (!firstname || !lastname || !email || !password) {
    return res.status(400).json({ message: 'All fields are required' });
  }

  if (password.length < 6) {
    return res.status(400).json({ message: 'Password must be at least 6 characters' });
  }

  try {
    // Check if user already exists
    const [existing] = await pool.execute(
      'SELECT email FROM Users WHERE email = ?',
      [email]
    );

    if (existing.length > 0) {
      return res.status(409).json({ message: 'User with this email already exists' });
    }

    // Hash password (you'll need bcrypt - run: npm install bcrypt)
    const bcrypt = require('bcrypt');
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert new user
    const [result] = await pool.execute(
      'INSERT INTO Users (firstname, lastname, email, password, role) VALUES (?, ?, ?, ?, ?)',
      [firstname, lastname, email, hashedPassword, 'user']
    );

    res.status(201).json({ 
      message: 'Account created successfully',
      userId: result.insertId 
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ message: 'Server error. Please try again.' });
  }
});

// ─── LOGIN ENDPOINT ─────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { email, password, security_code } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }

  try {
    const [users] = await pool.execute(
      'SELECT userID, firstname, lastname, email, password, role, security_code_hash, notify_new_providers FROM Users WHERE email = ?',
      [email]
    );

    if (users.length === 0) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const user = users[0];
    const bcrypt = require('bcrypt');
    const isValid = await bcrypt.compare(password, user.password);

    if (!isValid) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    // For admin users, verify security code
    if (user.role === 'admin') {
      if (!security_code) {
        return res.status(401).json({ message: 'Security code required for admin access' });
      }
      
      if (!user.security_code_hash) {
        return res.status(401).json({ message: 'Admin account not properly configured' });
      }
      
      const isSecurityCodeValid = await bcrypt.compare(security_code, user.security_code_hash);
      if (!isSecurityCodeValid) {
        return res.status(401).json({ message: 'Invalid security code' });
      }
    }

    // Don't send sensitive data back
    delete user.password;
    delete user.security_code_hash;
    
    res.json({ 
      message: 'Login successful',
      user: {
        id: user.userID,
        userID: user.userID,
        firstname: user.firstname,
        lastname: user.lastname,
        name: `${user.firstname} ${user.lastname}`,
        email: user.email,
        role: user.role,
        notify_new_providers: user.notify_new_providers !== 0
      },
      name: `${user.firstname} ${user.lastname}`
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Server error. Please try again.' });
  }
});

// ─── FORGOT PASSWORD ─────────────────────────────────────────────────────────
app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: 'Email is required' });

  try {
    const [users] = await pool.execute('SELECT userID, firstname FROM Users WHERE email = ?', [email.toLowerCase()]);
    // Always return success to prevent email enumeration
    if (users.length === 0) return res.json({ message: 'If that email exists, a reset code has been sent.' });

    const user = users[0];

    // Generate a 6-char alphanumeric token
    const crypto = require('crypto');
    const rawToken = crypto.randomBytes(3).toString('hex').toUpperCase(); // e.g. "A3F9B2"
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    // Store hashed token in DB
    const bcrypt = require('bcrypt');
    const tokenHash = await bcrypt.hash(rawToken, 10);

    // Upsert into PasswordResets table
    await pool.execute(`
      INSERT INTO PasswordResets (userID, token_hash, expires_at)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE token_hash = VALUES(token_hash), expires_at = VALUES(expires_at), used = 0
    `, [user.userID, tokenHash, expiresAt]);

    // Send reset email
    await sendEmail(
      email,
      'Belissima — Your Password Reset Code 🌺',
      `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
        <div style="background:linear-gradient(135deg,#8a2347,#661731);padding:28px 32px;border-radius:16px 16px 0 0;">
          <h1 style="color:white;font-size:22px;margin:0;">Password Reset Code 🌺</h1>
        </div>
        <div style="background:#fff;padding:28px 32px;border-radius:0 0 16px 16px;border:1px solid #f0d0dd;">
          <p style="color:#181114;">Hi <strong>${user.firstname}</strong>,</p>
          <p style="color:#6a5760;line-height:1.6;">We received a request to reset your Belissima password. Use the code below — it expires in <strong>15 minutes</strong>.</p>
          <div style="text-align:center;margin:28px 0;">
            <span style="display:inline-block;background:#fdf0f5;border:2px dashed #e98ab0;border-radius:16px;padding:18px 40px;font-size:2.2rem;font-weight:800;letter-spacing:.35em;color:#8d4168;font-family:monospace;">${rawToken}</span>
          </div>
          <p style="color:#6a5760;line-height:1.6;font-size:0.9rem;">If you didn't request this, you can safely ignore this email. Your password will not change.</p>
          <p style="color:#8a2347;font-weight:700;margin-top:24px;">— The Belissima Team</p>
        </div>
      </div>
      `
    );

    res.json({ message: 'If that email exists, a reset code has been sent.' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ message: 'Server error. Please try again.' });
  }
});

// ─── RESET PASSWORD ───────────────────────────────────────────────────────────
app.post('/api/reset-password', async (req, res) => {
  const { email, token, newPassword } = req.body;
  if (!email || !token || !newPassword) return res.status(400).json({ message: 'All fields are required' });
  if (newPassword.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters' });

  try {
    const [users] = await pool.execute('SELECT userID FROM Users WHERE email = ?', [email.toLowerCase()]);
    if (users.length === 0) return res.status(400).json({ message: 'Invalid reset request' });
    const userID = users[0].userID;

    const [resets] = await pool.execute(
      'SELECT * FROM PasswordResets WHERE userID = ? AND used = 0 AND expires_at > NOW()',
      [userID]
    );
    if (resets.length === 0) return res.status(400).json({ message: 'Reset code is invalid or has expired. Please request a new one.' });

    const bcrypt = require('bcrypt');
    const isValid = await bcrypt.compare(token.toUpperCase(), resets[0].token_hash);
    if (!isValid) return res.status(400).json({ message: 'Incorrect reset code. Please try again.' });

    // Update password
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await pool.execute('UPDATE Users SET password = ? WHERE userID = ?', [hashedPassword, userID]);

    // Mark token as used
    await pool.execute('UPDATE PasswordResets SET used = 1 WHERE userID = ?', [userID]);

    res.json({ message: 'Password reset successfully.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ message: 'Server error. Please try again.' });
  }
});

// ─── ADMIN LOGIN ENDPOINT ─────────────────────────────────────────────────────
app.post('/api/admin/login', async (req, res) => {
  const { email, password, admin_code } = req.body;

  if (!email || !password || !admin_code) {
    return res.status(400).json({ message: 'Email, password, and security code are required' });
  }

  try {
    const [users] = await pool.execute(
      'SELECT userID, firstname, lastname, email, password, role, security_code_hash FROM Users WHERE email = ? AND role = ?',
      [email.toLowerCase(), 'admin']
    );

    if (users.length === 0) {
      return res.status(401).json({ message: 'Invalid admin credentials' });
    }

    const user = users[0];
    const bcrypt = require('bcrypt');
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) return res.status(401).json({ message: 'Invalid admin credentials' });

    if (!user.security_code_hash) return res.status(401).json({ message: 'Admin account not properly configured' });
    const isValidCode = await bcrypt.compare(admin_code, user.security_code_hash);
    if (!isValidCode) return res.status(401).json({ message: 'Invalid security code' });

    res.json({
      message: 'Admin login successful',
      user: { id: user.userID, name: `${user.firstname} ${user.lastname}`, email: user.email, role: 'admin' }
    });
  } catch (err) {
    console.error('Admin login error:', err);
    res.status(500).json({ message: 'Server error. Please try again.' });
  }
});

// ─── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT COUNT(*) as count FROM Providers');
    res.json({ status: 'ok', providers: rows[0].count, database: process.env.DB_NAME });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─── PROVIDER REQUEST ENDPOINT (for become_provider.html) ─────────────────────
// ─── PROVIDER APPLICATION / REGISTRATION ─────────────────────────────────────
// Accepts both /api/register (from become_provider form) and /api/provider-request
async function handleProviderRequest(req, res) {
  const payload = req.body;

if (
  !payload.business_name ||
  !payload.service_type ||
  !payload.parish ||
  !payload.phone_number ||
  !payload.email ||
  !payload.logo_url ||
  !payload.supplementary_image_1_url ||
  !payload.supplementary_image_2_url
) {
  return res.status(400).json({ error: 'Missing required fields', success: false });
}

  // Normalise service type to match ProviderRequests ENUM
  const serviceTypeMap = {
    'MAKE-UP ARTIST': 'MAKE-UP ARTIST',
    'MAKEUP ARTIST':  'MAKE-UP ARTIST',
    'NAIL ARTIST':    'NAIL ARTIST',
    'HAIRSTYLIST':    'HAIRSTYLIST',
    'HAIRDRESSER':    'HAIRSTYLIST',
    'WAX SPECIALIST': 'WAX SPECIALIST',
    'WAXER':          'WAX SPECIALIST',
  };
  const serviceType = serviceTypeMap[payload.service_type?.trim().toUpperCase()];
    if (!serviceType) {
      return res.status(400).json({ error: `Invalid service type: "${payload.service_type}"`, success: false });
    }

  // Parse JSON fields that arrive as strings from FormData
  let paymentMethods = payload.payment_methods;
  if (typeof paymentMethods === 'string') {
    try { paymentMethods = JSON.parse(paymentMethods); } catch { paymentMethods = []; }
  }

  let openingHours = payload.opening_hours;
  if (typeof openingHours === 'string') {
    try { openingHours = JSON.parse(openingHours); } catch { openingHours = null; }
  }

  // Coerce numeric / boolean fields
  const int    = v => (v !== '' && v != null) ? parseInt(v)   : null;
  const dec    = v => (v !== '' && v != null) ? parseFloat(v) : null;
  const bool   = v => v === '1' || v === 1   ? 1 : v === '0' || v === 0 ? 0 : null;

  try {
    const [result] = await pool.execute(`
      INSERT INTO ProviderRequests (
        email, business_name, service_type, parish, phone_number,
        other_contact, address, insta_link, tiktok_link, facebook_link,
        booking_link, other_booking, starting_price, average_worktime,
        provider_gender, board_certified, company_allowed, walkins_allowed,
        mobile_service, kid_friendly, disabled_friendly, payment_methods,
        deposit_required, deposit_type, deposit_value, opening_hours,
        days_open, weekly_hours, extra_notes, status, logo_url, supplementary_image_1_url, supplementary_image_2_url
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      payload.email.trim(),
      payload.business_name.trim(),
      serviceType,
      payload.parish,
      payload.phone_number.trim(),
      payload.other_contact  || null,
      payload.address        || null,
      payload.insta_link     || null,
      payload.tiktok_link    || null,
      payload.facebook_link  || null,
      payload.booking_link   || null,
      payload.other_booking  || null,
      dec(payload.starting_price),
      int(payload.average_worktime),
      payload.provider_gender || null,
      bool(payload.board_certified),
      bool(payload.company_allowed),
      bool(payload.walkins_allowed),
      bool(payload.mobile_service),
      bool(payload.kid_friendly),
      bool(payload.disabled_friendly),
      JSON.stringify(paymentMethods || []),
      bool(payload.deposit_required),
      payload.deposit_type  || null,
      dec(payload.deposit_value),
      openingHours ? JSON.stringify(openingHours) : null,
      int(payload.days_open),
      dec(payload.weekly_hours),
      payload.extra_notes || null,
      'pending',
      payload.logo_url || null,
      payload.supplementary_image_1_url || null,
      payload.supplementary_image_2_url || null,
    ]);

    // Confirmation email to applicant
    await sendEmail(
      payload.email.trim(),
      'Belissima — Application Received 🌺',
      `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
        <div style="background:linear-gradient(135deg,#8a2347,#661731);padding:28px 32px;border-radius:16px 16px 0 0;">
          <h1 style="color:white;font-size:22px;margin:0;">Application Received 🌺</h1>
        </div>
        <div style="background:#fff;padding:28px 32px;border-radius:0 0 16px 16px;border:1px solid #f0d0dd;">
          <p style="color:#181114;">Hi <strong>${payload.business_name}</strong>,</p>
          <p style="color:#6a5760;line-height:1.6;">Thank you for applying to join Belissima! We've received your application and our team will review it within <strong>3–5 business days</strong>.</p>
          <p style="color:#6a5760;line-height:1.6;">You'll receive another email once a decision has been made. In the meantime, feel free to reach out to <a href="mailto:support@belissima.com" style="color:#8a2347;">support@belissima.com</a> if you have any questions.</p>
          <p style="color:#8a2347;font-weight:700;margin-top:24px;">— The Belissima Team</p>
        </div>
      </div>
      `
    );

    res.json({ success: true, message: 'Application submitted! Check your email for confirmation.' });
  } catch (err) {
    console.error('Provider request error:', err);
    res.status(500).json({ error: 'Failed to submit application: ' + err.message, success: false });
  }
}

// Both endpoints point to the same handler
app.post('/api/register',          upload.any(), handleProviderRequest);
app.post('/api/provider-request',  upload.any(), handleProviderRequest);

// ─── ADMIN STATS ENDPOINT ─────────────────────────────────────────────────────
app.get('/api/admin/stats', async (req, res) => {
  try {
    const [userCount] = await pool.execute('SELECT COUNT(*) as count FROM Users');
    const [providerCount] = await pool.execute('SELECT COUNT(*) as count FROM Providers');
    const [adminCount] = await pool.execute('SELECT COUNT(*) as count FROM Users WHERE role = "admin"');
    const favCount = { count: 0 }; // You can implement favorites count later
    
    res.json({
      totalUsers: userCount[0].count,
      totalProviders: providerCount[0].count,
      totalAdmins: adminCount[0].count,
      totalFavorites: favCount.count
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ─── ADMIN USERS ENDPOINT ─────────────────────────────────────────────────────
app.get('/api/admin/users', async (req, res) => {
  try {
    const [users] = await pool.execute(
      'SELECT userID, firstname, lastname, email, role, created_at FROM Users ORDER BY created_at DESC LIMIT 50'
    );
    res.json({ users });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ─── ADMIN ADMINS ENDPOINT ────────────────────────────────────────────────────
app.get('/api/admin/admins', async (req, res) => {
  try {
    const [admins] = await pool.execute(
      'SELECT userID, firstname, lastname, email, role, created_at FROM Users WHERE role = "admin" ORDER BY created_at DESC'
    );
    res.json({ admins });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch admins' });
  }
});

// ─── ADMIN REQUESTS ENDPOINT ─────────────────────────────────────────────────
app.get('/api/admin/requests', async (req, res) => {
  try {
    const [requests] = await pool.execute(`
      SELECT requestID, business_name, service_type, parish, phone_number,
             email, address, submitted_at, status, request_type, extra_notes
      FROM ProviderRequests
      WHERE status IN ('pending', 'update_requested')
      ORDER BY submitted_at DESC
    `);
    res.json({ requests });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

// ─── ADMIN GET SINGLE REQUEST DETAILS ─────────────────────────────────────────
app.get('/api/admin/request/:requestID', async (req, res) => {
  const { requestID } = req.params;
  try {
    const [rows] = await pool.execute(`SELECT * FROM ProviderRequests WHERE requestID = ?`, [requestID]);
    if (rows.length === 0) return res.status(404).json({ error: 'Request not found' });
    const request = rows[0];
    if (request.payment_methods && typeof request.payment_methods === 'string') request.payment_methods = JSON.parse(request.payment_methods);
    if (request.opening_hours && typeof request.opening_hours === 'string') request.opening_hours = JSON.parse(request.opening_hours);
    res.json({ request });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch request details' });
  }
});

// ─── ADMIN APPLY INFO UPDATE (update_requested status) ────────────────────────
app.post('/api/admin/apply-update', async (req, res) => {
  const { requestID, admin_notes } = req.body;
  try {
    const [rows] = await pool.execute(`SELECT * FROM ProviderRequests WHERE requestID = ?`, [requestID]);
    if (rows.length === 0) return res.status(404).json({ error: 'Request not found' });
    const reqData = rows[0];
    if (!reqData.businessID_ref) return res.status(400).json({ error: 'No linked businessID on this update request' });

    // Update Providers table
    await pool.execute(`
      UPDATE Providers SET
        parish = ?, business_name = ?, phone_number = ?, other_contact = ?,
        insta_link = ?, tiktok_link = ?, facebook_link = ?, booking_link = ?,
        other_booking = ?, address = ?
      WHERE businessID = ?
    `, [reqData.parish, reqData.business_name, reqData.phone_number, reqData.other_contact,
        reqData.insta_link, reqData.tiktok_link, reqData.facebook_link, reqData.booking_link,
        reqData.other_booking, reqData.address, reqData.businessID_ref]);

    // Update Tags table
    await pool.execute(`
      UPDATE Tags SET
        starting_price = ?, board_certified = ?, company_allowed = ?,
        payment_methods = ?, deposit_required = ?, deposit_type = ?, deposit_value = ?,
        average_worktime = ?, walkins_allowed = ?, mobile_service = ?, provider_gender = ?,
        kid_friendly = ?, disabled_friendly = ?, opening_hours = ?, days_open = ?, weekly_hours = ?
      WHERE businessID = ?
    `, [reqData.starting_price, reqData.board_certified, reqData.company_allowed,
        reqData.payment_methods, reqData.deposit_required, reqData.deposit_type, reqData.deposit_value,
        reqData.average_worktime, reqData.walkins_allowed, reqData.mobile_service, reqData.provider_gender,
        reqData.kid_friendly, reqData.disabled_friendly, reqData.opening_hours, reqData.days_open,
        reqData.weekly_hours, reqData.businessID_ref]);

    await pool.execute(`UPDATE ProviderRequests SET status='approved', admin_notes=?, reviewed_at=NOW() WHERE requestID=?`,
      [admin_notes || null, requestID]);

    res.json({ message: 'Provider information updated successfully!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to apply update' });
  }
});

// ─── ADMIN APPROVE REQUEST ─────────────────────────────────────────────────
app.post('/api/admin/approve', async (req, res) => {
  const { requestID, admin_notes } = req.body;

  try {
    const [requestRows] = await pool.execute(`SELECT * FROM ProviderRequests WHERE requestID = ?`, [requestID]);
    if (requestRows.length === 0) return res.status(404).json({ error: 'Request not found' });

    const reqData = requestRows[0];

    // Map ProviderRequests service type → Providers service type & businessID prefix
    const serviceMap = {
      'NAIL ARTIST':  { providerType: 'NAIL ARTIST',   prefix: 'NA' },
      'MAKEUP ARTIST':{ providerType: 'MAKE-UP ARTIST', prefix: 'MA' },
      'HAIRDRESSER':  { providerType: 'HAIRSTYLIST',    prefix: 'HA' },
      'WAXER':        { providerType: 'WAX SPECIALIST', prefix: 'WA' },
    };
    const mapped       = serviceMap[reqData.service_type] || { providerType: reqData.service_type, prefix: 'PR' };
    const businessID   = `${mapped.prefix}${Date.now().toString().slice(-6)}`;

    // Parse JSON fields safely
    const paymentMethods = typeof reqData.payment_methods === 'string'
      ? reqData.payment_methods  // already a JSON string — pass straight to DB
      : JSON.stringify(reqData.payment_methods || []);

    const openingHours = typeof reqData.opening_hours === 'string'
      ? reqData.opening_hours
      : reqData.opening_hours ? JSON.stringify(reqData.opening_hours) : null;

    // Insert into Providers
    await pool.execute(`
      INSERT INTO Providers (
        businessID, parish, service_type, business_name, phone_number,
        other_contact, insta_link, tiktok_link, facebook_link,
        booking_link, other_booking, address
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      businessID, reqData.parish, mapped.providerType, reqData.business_name,
      reqData.phone_number, reqData.other_contact || null, reqData.insta_link || null,
      reqData.tiktok_link || null, reqData.facebook_link || null,
      reqData.booking_link || null, reqData.other_booking || null, reqData.address || '',
    ]);

    await pool.execute(`
      INSERT INTO ProviderPhotos (businessID, photo_url, is_primary, sort_order)
      VALUES
        (?, ?, 1, 1),
        (?, ?, 0, 2),
        (?, ?, 0, 3)
    `, [
      businessID, reqData.logo_url,
      businessID, reqData.supplementary_image_1_url,
      businessID, reqData.supplementary_image_2_url
    ]);

    // Insert into Tags
    await pool.execute(`
      INSERT INTO Tags (
        businessID, starting_price, board_certified, company_allowed,
        payment_methods, deposit_required, deposit_type, deposit_value,
        average_worktime, walkins_allowed, mobile_service, provider_gender,
        kid_friendly, disabled_friendly, opening_hours, days_open, weekly_hours
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      businessID,
      reqData.starting_price   || null,
      reqData.board_certified  ?? null,
      reqData.company_allowed  ?? null,
      paymentMethods,
      reqData.deposit_required ?? 0,
      reqData.deposit_type     || null,
      reqData.deposit_value    || null,
      reqData.average_worktime || null,
      reqData.walkins_allowed  ?? null,
      reqData.mobile_service   ?? null,
      reqData.provider_gender  || null,
      reqData.kid_friendly     ?? null,
      reqData.disabled_friendly ?? null,
      openingHours,
      reqData.days_open        || null,
      reqData.weekly_hours     || null,
    ]);

    // Mark request approved
    await pool.execute(`
      UPDATE ProviderRequests SET status='approved', admin_notes=?, reviewed_at=NOW() WHERE requestID=?
    `, [admin_notes || null, requestID]);

    // Email provider
    await sendEmail(
      reqData.email,
      'Belissima — Your Application Has Been Approved! 🎉',
      `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
        <div style="background:linear-gradient(135deg,#8a2347,#661731);padding:28px 32px;border-radius:16px 16px 0 0;">
          <h1 style="color:white;font-size:22px;margin:0;">You're on Belissima! 🎉</h1>
        </div>
        <div style="background:#fff;padding:28px 32px;border-radius:0 0 16px 16px;border:1px solid #f0d0dd;">
          <p style="color:#181114;">Hi <strong>${reqData.business_name}</strong>,</p>
          <p style="color:#6a5760;line-height:1.6;">Great news — your application has been <strong style="color:#2e7d32;">approved</strong>! Your business is now live on the Belissima platform and clients can discover you right away.</p>
          <p style="color:#6a5760;line-height:1.6;">Your Business ID is: <strong style="color:#8a2347;">${businessID}</strong></p>
          ${admin_notes ? `<p style="color:#6a5760;line-height:1.6;"><strong>Note from our team:</strong> ${admin_notes}</p>` : ''}
          <p style="color:#6a5760;line-height:1.6;">Welcome to the Belissima family! 🌺</p>
          <p style="color:#8a2347;font-weight:700;margin-top:24px;">— The Belissima Team</p>
        </div>
      </div>
      `
    );

    // Notify users who opted in to new provider alerts
    notifyUsersOfNewProvider(
      reqData.business_name,
      reqData.parish,
      mapped.providerType,
      businessID
    ).catch(err => console.error('Notification error:', err));

    res.json({ success: true, message: 'Provider approved and added to platform!', businessID });
  } catch (err) {
    console.error('Approve error:', err);
    res.status(500).json({ error: 'Failed to approve request: ' + err.message });
  }
});

// ─── ADMIN REJECT REQUEST ─────────────────────────────────────────────────
app.post('/api/admin/reject', async (req, res) => {
  const { requestID, admin_notes } = req.body;

  try {
    const [rows] = await pool.execute(`SELECT email, business_name FROM ProviderRequests WHERE requestID = ?`, [requestID]);
    if (rows.length === 0) return res.status(404).json({ error: 'Request not found' });
    const { email, business_name } = rows[0];

    await pool.execute(`
      UPDATE ProviderRequests SET status='rejected', admin_notes=?, reviewed_at=NOW() WHERE requestID=?
    `, [admin_notes || null, requestID]);

    // Email provider
    await sendEmail(
      email,
      'Belissima — Application Update',
      `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
        <div style="background:linear-gradient(135deg,#8a2347,#661731);padding:28px 32px;border-radius:16px 16px 0 0;">
          <h1 style="color:white;font-size:22px;margin:0;">Application Update</h1>
        </div>
        <div style="background:#fff;padding:28px 32px;border-radius:0 0 16px 16px;border:1px solid #f0d0dd;">
          <p style="color:#181114;">Hi <strong>${business_name}</strong>,</p>
          <p style="color:#6a5760;line-height:1.6;">Thank you for your interest in joining Belissima. After reviewing your application, we're unable to approve it at this time.</p>
          ${admin_notes ? `<p style="color:#6a5760;line-height:1.6;"><strong>Reason:</strong> ${admin_notes}</p>` : ''}
          <p style="color:#6a5760;line-height:1.6;">You're welcome to reapply in the future or reach out to <a href="mailto:support@belissima.com" style="color:#8a2347;">support@belissima.com</a> for more information.</p>
          <p style="color:#8a2347;font-weight:700;margin-top:24px;">— The Belissima Team</p>
        </div>
      </div>
      `
    );

    res.json({ success: true, message: 'Application rejected and provider notified.' });
  } catch (err) {
    console.error('Reject error:', err);
    res.status(500).json({ error: 'Failed to reject request: ' + err.message });
  }
});

// ─── GET USER ACCOUNT DETAILS ─────────────────────────────────────────────
app.get('/api/account/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const [users] = await pool.execute(
      'SELECT userID, firstname, lastname, email, role, notify_new_providers, created_at FROM Users WHERE userID = ?',
      [userId]
    );
    if (users.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ user: users[0] });
  } catch (err) {
    console.error('Fetch account error:', err);
    res.status(500).json({ error: 'Failed to fetch account' });
  }
});

// ─── UPDATE USER LOCATION (PARISH) ────────────────────────────────────────
app.put('/api/account/:userId/location', async (req, res) => {
  const { userId } = req.params;
  const { parish } = req.body;
  
  if (!parish || !['Kingston', 'Portmore'].includes(parish)) {
    return res.status(400).json({ message: 'Valid parish (Kingston or Portmore) required' });
  }
  
  try {
    await pool.execute('UPDATE Users SET parish = ? WHERE userID = ?', [parish, userId]);
    const [users] = await pool.execute('SELECT userID, firstname, lastname, email, role, notify_new_providers FROM Users WHERE userID = ?', [userId]);
    res.json({ message: 'Location updated', user: users[0] });
  } catch (err) {
    console.error('Update location error:', err);
    res.status(500).json({ message: 'Failed to update location' });
  }
});

// ─── UPDATE USER NOTIFICATION SETTINGS ────────────────────────────────────
app.put('/api/account/:userId/notifications', async (req, res) => {
  const { userId } = req.params;
  const { notify_new_providers } = req.body;
  
  try {
    await pool.execute('UPDATE Users SET notify_new_providers = ? WHERE userID = ?', [notify_new_providers ? 1 : 0, userId]);
    const [users] = await pool.execute('SELECT userID, firstname, lastname, email, role, notify_new_providers FROM Users WHERE userID = ?', [userId]);
    res.json({ message: 'Notification settings updated', user: users[0] });
  } catch (err) {
    console.error('Update notifications error:', err);
    res.status(500).json({ message: 'Failed to update notification settings' });
  }
});

// ─── UPDATE FULL USER ACCOUNT (Name, Email, Password) ─────────────────────
app.put('/api/account/:userId', async (req, res) => {
  const { userId } = req.params;
  const { firstname, lastname, email, currentPassword, newPassword } = req.body;
  const bcrypt = require('bcrypt');
  
  try {
    // First verify current user exists
    const [users] = await pool.execute(
      'SELECT userID, firstname, lastname, email, password FROM Users WHERE userID = ?',
      [userId]
    );
    if (users.length === 0) return res.status(404).json({ message: 'User not found' });
    
    const user = users[0];
    
    // If changing password, verify current password
    if (newPassword) {
      if (!currentPassword) {
        return res.status(400).json({ message: 'Current password required to change password' });
      }
      const isValid = await bcrypt.compare(currentPassword, user.password);
      if (!isValid) {
        return res.status(401).json({ message: 'Current password is incorrect' });
      }
    }
    
    // Build update query dynamically
    let updateFields = ['firstname = ?', 'lastname = ?', 'email = ?'];
    let updateValues = [firstname, lastname, email.toLowerCase()];
    
    if (newPassword) {
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      updateFields.push('password = ?');
      updateValues.push(hashedPassword);
    }
    
    updateValues.push(userId);
    await pool.execute(
      `UPDATE Users SET ${updateFields.join(', ')} WHERE userID = ?`,
      updateValues
    );
    
    const [updatedUser] = await pool.execute(
      'SELECT userID, firstname, lastname, email, role, notify_new_providers FROM Users WHERE userID = ?',
      [userId]
    );
    
    res.json({ message: 'Account updated successfully', user: updatedUser[0] });
  } catch (err) {
    console.error('Update account error:', err);
    res.status(500).json({ message: 'Failed to update account' });
  }
});

// ─── DELETE USER ACCOUNT ──────────────────────────────────────────────────
app.delete('/api/account/:userId', async (req, res) => {
  const { userId } = req.params;
  
  try {
    // Check if user exists and is not admin (admins can't delete via this endpoint)
    const [users] = await pool.execute('SELECT role FROM Users WHERE userID = ?', [userId]);
    if (users.length === 0) return res.status(404).json({ message: 'User not found' });
    if (users[0].role === 'admin') {
      return res.status(403).json({ message: 'Admin accounts cannot be deleted through this endpoint' });
    }
    
    await pool.execute('DELETE FROM Users WHERE userID = ?', [userId]);
    res.json({ message: 'Account deleted successfully' });
  } catch (err) {
    console.error('Delete account error:', err);
    res.status(500).json({ message: 'Failed to delete account' });
  }
});

// ─── NOTIFICATION CHECKER (Run this on new provider addition) ─────────────
// Call this function when a new provider is approved
async function notifyUsersOfNewProvider(providerName, providerParish, providerType, providerId) {
  try {
    // Get users who have notifications enabled and match the parish
    const [users] = await pool.execute(
      `SELECT userID, email, firstname FROM Users 
       WHERE notify_new_providers = 1 AND parish = ? AND role != 'admin'`,
      [providerParish]
    );
    
    for (const user of users) {
      // Check if we already notified this user about this provider
      const [existing] = await pool.execute(
        'SELECT id FROM UserNotifications WHERE userID = ? AND provider_id = ?',
        [user.userID, providerId]
      );
      
      if (existing.length === 0) {
        // Record that we sent this notification
        await pool.execute(
          'INSERT INTO UserNotifications (userID, notification_type, provider_id) VALUES (?, ?, ?)',
          [user.userID, 'new_provider', providerId]
        );
        
        // Send email notification
        await sendEmail(
          user.email,
          '🌸 New Beauty Provider Near You! 🌸',
          `
          <div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
            <div style="background:linear-gradient(135deg,#8a2347,#661731);padding:28px 32px;border-radius:16px 16px 0 0;">
              <h1 style="color:white;font-size:22px;margin:0;">New Provider Alert! 🎉</h1>
            </div>
            <div style="background:#fff;padding:28px 32px;border-radius:0 0 16px 16px;border:1px solid #f0d0dd;">
              <p style="color:#181114;">Hi <strong>${user.firstname}</strong>,</p>
              <p style="color:#6a5760;line-height:1.6;">A new ${providerType} has joined Belissima in <strong>${providerParish}</strong>!</p>
              <div style="background:#f8f3f6;padding:16px;border-radius:12px;margin:16px 0;text-align:center;">
                <p style="font-size:18px;font-weight:bold;color:#8a2347;margin:0;">✨ ${providerName} ✨</p>
              </div>
              <div style="text-align:center;margin-top:24px;">
                <a href="http://localhost:3000/provider.html?id=${providerId}" style="display:inline-block;background:linear-gradient(135deg,#8a2347,#661731);color:white;padding:12px 24px;border-radius:40px;text-decoration:none;font-weight:bold;">View Provider →</a>
              </div>
              <p style="color:#8a2347;font-weight:700;margin-top:24px;">— The Belissima Team</p>
            </div>
          </div>
          `
        );
        console.log(`📧 Notification sent to ${user.email} about ${providerName}`);
      }
    }
  } catch (err) {
    console.error('Notification error:', err);
  }
}

// ============================================
// ACCOUNT MANAGEMENT ENDPOINTS (ADDED - DO NOT REMOVE)
// These endpoints work alongside existing AI functionality
// ============================================

// ─── GET USER ACCOUNT DETAILS ─────────────────────────────────────────────
app.get('/api/account/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const [users] = await pool.execute(
      'SELECT userID, firstname, lastname, email, role, notify_new_providers, created_at FROM Users WHERE userID = ?',
      [userId]
    );
    if (users.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ user: users[0] });
  } catch (err) {
    console.error('Fetch account error:', err);
    res.status(500).json({ error: 'Failed to fetch account' });
  }
});

// ─── UPDATE USER LOCATION (PARISH) ────────────────────────────────────────
app.put('/api/account/:userId/location', async (req, res) => {
  const { userId } = req.params;
  const { parish } = req.body;
  
  console.log(`📍 Updating location for user ${userId} to ${parish}`);
  
  if (!parish || !['Kingston', 'Portmore'].includes(parish)) {
    return res.status(400).json({ message: 'Valid parish (Kingston or Portmore) required' });
  }
  
  try {
    const [userCheck] = await pool.execute('SELECT userID FROM Users WHERE userID = ?', [userId]);
    if (userCheck.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    await pool.execute('UPDATE Users SET parish = ? WHERE userID = ?', [parish, userId]);
    const [users] = await pool.execute('SELECT userID, firstname, lastname, email, role, notify_new_providers FROM Users WHERE userID = ?', [userId]);
    res.json({ message: 'Location updated successfully!', user: users[0] });
  } catch (err) {
    console.error('Update location error:', err);
    res.status(500).json({ message: 'Failed to update location: ' + err.message });
  }
});

// ─── UPDATE USER NOTIFICATION SETTINGS ────────────────────────────────────
app.put('/api/account/:userId/notifications', async (req, res) => {
  const { userId } = req.params;
  const { notify_new_providers } = req.body;
  
  console.log(`🔔 Updating notifications for user ${userId} to ${notify_new_providers}`);
  
  try {
    const [userCheck] = await pool.execute('SELECT userID FROM Users WHERE userID = ?', [userId]);
    if (userCheck.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    await pool.execute('UPDATE Users SET notify_new_providers = ? WHERE userID = ?', [notify_new_providers ? 1 : 0, userId]);
    const [users] = await pool.execute('SELECT userID, firstname, lastname, email, role, notify_new_providers FROM Users WHERE userID = ?', [userId]);
    res.json({ message: 'Notification settings saved!', user: users[0] });
  } catch (err) {
    console.error('Update notifications error:', err);
    res.status(500).json({ message: 'Failed to update notification settings' });
  }
});

// ─── UPDATE FULL USER ACCOUNT (Name, Email, Password) ─────────────────────
app.put('/api/account/:userId', async (req, res) => {
  const { userId } = req.params;
  const { firstname, lastname, email, currentPassword, newPassword } = req.body;
  const bcrypt = require('bcrypt');
  
  try {
    const [users] = await pool.execute(
      'SELECT userID, firstname, lastname, email, password FROM Users WHERE userID = ?',
      [userId]
    );
    if (users.length === 0) return res.status(404).json({ message: 'User not found' });
    
    const user = users[0];
    
    if (newPassword) {
      if (!currentPassword) {
        return res.status(400).json({ message: 'Current password required to change password' });
      }
      const isValid = await bcrypt.compare(currentPassword, user.password);
      if (!isValid) {
        return res.status(401).json({ message: 'Current password is incorrect' });
      }
    }
    
    let updateFields = ['firstname = ?', 'lastname = ?', 'email = ?'];
    let updateValues = [firstname, lastname, email.toLowerCase()];
    
    if (newPassword) {
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      updateFields.push('password = ?');
      updateValues.push(hashedPassword);
    }
    
    updateValues.push(userId);
    await pool.execute(
      `UPDATE Users SET ${updateFields.join(', ')} WHERE userID = ?`,
      updateValues
    );
    
    const [updatedUser] = await pool.execute(
      'SELECT userID, firstname, lastname, email, role, notify_new_providers FROM Users WHERE userID = ?',
      [userId]
    );
    
    res.json({ message: 'Account updated successfully!', user: updatedUser[0] });
  } catch (err) {
    console.error('Update account error:', err);
    res.status(500).json({ message: 'Failed to update account' });
  }
});

// ─── DELETE USER ACCOUNT ──────────────────────────────────────────────────
app.delete('/api/account/:userId', async (req, res) => {
  const { userId } = req.params;
  
  try {
    const [users] = await pool.execute('SELECT role FROM Users WHERE userID = ?', [userId]);
    if (users.length === 0) return res.status(404).json({ message: 'User not found' });
    if (users[0].role === 'admin') {
      return res.status(403).json({ message: 'Admin accounts cannot be deleted through this endpoint' });
    }
    
    await pool.execute('DELETE FROM Users WHERE userID = ?', [userId]);
    res.json({ message: 'Account deleted successfully' });
  } catch (err) {
    console.error('Delete account error:', err);
    res.status(500).json({ message: 'Failed to delete account' });
  }
});

// ─── TEST ENDPOINT (to verify API is working) ─────────────────────────────
app.get('/api/test', (req, res) => {
  res.json({ message: 'API is working!', status: 'ok', timestamp: new Date().toISOString() });
});

// ─── GET UNREAD NOTIFICATIONS FOR A USER ─────────────────────────────────
app.get('/api/notifications/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const [notifications] = await pool.execute(`
      SELECT n.id, n.notification_type, n.is_read, n.created_at,
             n.provider_id, p.business_name, p.service_type, p.parish
      FROM UserNotifications n
      LEFT JOIN Providers p ON p.businessID = n.provider_id
      WHERE n.userID = ? AND n.is_read = 0
      ORDER BY n.created_at DESC
    `, [userId]);
    res.json({ success: true, notifications });
  } catch (err) {
    console.error('Fetch notifications error:', err);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// ─── MARK NOTIFICATION(S) AS READ ────────────────────────────────────────
app.post('/api/notifications/:userId/read', async (req, res) => {
  const { userId } = req.params;
  const { notificationId } = req.body;
  try {
    if (notificationId) {
      await pool.execute(
        'UPDATE UserNotifications SET is_read = 1 WHERE id = ? AND userID = ?',
        [notificationId, userId]
      );
    } else {
      await pool.execute(
        'UPDATE UserNotifications SET is_read = 1 WHERE userID = ?',
        [userId]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌺 Belissima server running on http://localhost:${PORT}`);
  console.log(`📋 Health check: http://localhost:${PORT}/api/health`);
});

module.exports = pool;