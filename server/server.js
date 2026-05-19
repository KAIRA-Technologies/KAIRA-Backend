import dotenv from 'dotenv';
dotenv.config();

import express      from 'express';
import cors         from 'cors';
import axios        from 'axios';
import path         from 'path';
import fs           from 'fs';
// import puppeteer    from 'puppeteer';

import { authPool, emsPool } from './db.js';
import authRoutes            from './routes/auth.js';
import { verifyToken }       from './middleware/auth.js';

/* ─────────────────────────────────────────────
   ENV VALIDATION  – fail fast on bad config
───────────────────────────────────────────── */
const REQUIRED_ENV = [
  'MSGCLUB_URL',
  'MSGCLUB_AUTH_KEY',
  'MSGCLUB_SENDER_ID',
  'MSGCLUB_TEMPLATE_NAME',
  'BASE_PUBLIC_URL',
];

const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length) {
  console.error('❌  Missing required environment variables:', missingEnv.join(', '));
  process.exit(1);
}

if (process.env.BASE_PUBLIC_URL.includes('localhost')) {
  console.error(
    '❌  BASE_PUBLIC_URL cannot be "localhost".\n' +
    '    WhatsApp / Meta cannot reach a local server.\n' +
    '    Use ngrok for local testing, or your production domain.'
  );
  process.exit(1);
}

/* ─────────────────────────────────────────────
   APP & CONSTANTS
───────────────────────────────────────────── */
const app      = express();
const __dirname = path.resolve();

// Persistent folder that serves as the public PDF store
const reportsDir = path.join(__dirname, 'storage', 'reports');
if (!fs.existsSync(reportsDir)) {
  fs.mkdirSync(reportsDir, { recursive: true });
}

/* ─────────────────────────────────────────────
   MIDDLEWARE
───────────────────────────────────────────── */
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST'],
}));

app.use(express.json({ limit: '50mb' }));

/* ─────────────────────────────────────────────
   PUBLIC STATIC – Meta/WhatsApp fetches PDF here
   No auth required on this path on purpose.
───────────────────────────────────────────── */
// app.use('/reports', express.static(reportsDir, {
//   setHeaders: (res, filePath) => {
//     if (filePath.endsWith('.pdf')) {
//       res.setHeader('Content-Type', 'application/pdf');
//       res.setHeader('Content-Disposition', 'inline');
//       res.setHeader('Access-Control-Allow-Origin', '*');
//       res.setHeader('Cache-Control', 'public, max-age=3600');
//     }
//   },
// }));

app.use('/reports', express.static(reportsDir, {
  setHeaders: (res) => {
    // Explicitly force PDF content type for Meta validation
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Access-Control-Allow-Origin', '*');
  },
}));

/* ─────────────────────────────────────────────
   AUTH ROUTES  (public)
───────────────────────────────────────────── */
app.use('/api/auth', authRoutes);

/* ─────────────────────────────────────────────
   ALL ROUTES BELOW REQUIRE A VALID JWT
───────────────────────────────────────────── */
app.use(verifyToken);

app.use('/reports', express.static(path.join(__dirname, 'storage', 'reports'), {
    setHeaders: (res, path) => {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename=report.pdf');
        res.setHeader('ngrok-skip-browser-warning', 'true');
    }
}));

/* ═══════════════════════════════════════════
   WHATSAPP SEND ROUTE
   POST /api/whatsapp/send
═══════════════════════════════════════════ */
app.post('/api/whatsapp/send', async (req, res) => {
  try {
    const { mobileNumber, reportType, date, pdfBase64 } = req.body;

    if (!mobileNumber || !reportType || !date || !pdfBase64) {
      return res.status(400).json({ success: false, error: 'Missing fields' });
    }

    const cleanPhone = mobileNumber.replace(/\D/g, '');
    const safeReportName = reportType.replace(/[^a-z0-9]/gi, '_');
    const fileName = `Report_${safeReportName}_${date}_${Date.now()}.pdf`;
    const pdfPath = path.join(reportsDir, fileName);
   const publicPdfUrl = `${process.env.BASE_PUBLIC_URL}/reports/${fileName}`;

    /* ── STEP 1: CLEAN AND VALIDATE BASE64 (MsgClub Fix) ── */
    // Remove the "data:application/pdf;base64," prefix if it exists
    let cleanedBase64 = pdfBase64.includes(',') ? pdfBase64.split(',')[1] : pdfBase64;

// 2. Remove any whitespace or newlines that might have crept in
cleanedBase64 = cleanedBase64.replace(/\s/g, '');

// 3. Create Buffer
const pdfBuffer = Buffer.from(cleanedBase64, 'base64');

    // Validate that the buffer actually starts with the %PDF header
  if (pdfBuffer.length < 4 || pdfBuffer.slice(0, 4).toString() !== '%PDF') {
  console.error("Buffer Start:", pdfBuffer.slice(0, 10).toString()); // For debugging
  return res.status(400).json({ 
    success: false, 
    error: 'Invalid PDF format: Buffer does not contain valid PDF signature.' 
  });
}

    /* ── STEP 2: SAVE TO DISK ── */
    fs.writeFileSync(pdfPath, pdfBuffer);

    // Brief delay to ensure OS file system flushes (MsgClub Fix)
    await new Promise(resolve => setTimeout(resolve, 2000));

    console.log(`✅ PDF saved & validated: ${fileName} (${(pdfBuffer.length / 1024).toFixed(1)} KB)`);

    /* ── STEP 3: BUILD PAYLOAD ── */
    const payload = {
      mobileNumbers: cleanPhone,
      senderId: process.env.MSGCLUB_SENDER_ID,
      component: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        type: 'template',
        to: cleanPhone,
        template: {
          name: process.env.MSGCLUB_TEMPLATE_NAME,
          language: { code: 'en' },
          components: [
            {
              type: 'header',
              index: 0,
              parameters: [{
                type: 'document',
                document: { 
                    link: publicPdfUrl, 
                    filename: 'Industrial_Report.pdf' // Added filename for better user experience
                },
              }],
            },
            {
              type: 'body',
              index: 0,
              parameters: [
                { type: 'text', text: 'KAIRA' },
                { type: 'text', text: reportType },
              ],
            },
            {
              type: 'button',
              sub_type: 'url',
              index: 0,
              parameters: [{ type: 'text', text: fileName }],
            },
          ],
        },
      },
    };

    /* ── STEP 4: CALL MSGCLUB ── */
    const msgUrl = `${process.env.MSGCLUB_URL}?AUTH_KEY=${process.env.MSGCLUB_AUTH_KEY}`;
    const msgResponse = await axios.post(msgUrl, payload, { timeout: 20000 });

    const { responseCode, response: msgBody } = msgResponse.data;
    if (responseCode === '3001' || responseCode === '200') {
      return res.json({ success: true, message: 'Sent!', pdfUrl: publicPdfUrl });
    }

    return res.status(400).json({ success: false, error: `MsgClub Error: ${responseCode}` });

  } catch (err) {
    console.error('❌ Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ═══════════════════════════════════════════
   WHATSAPP ALARM ROUTE
   POST /api/whatsapp/alarm
═══════════════════════════════════════════ */
app.post('/api/whatsapp/alarm', async (req, res) => {
  try {
    const { mobileNumbers, plantName, equipmentName, alarmType, timestamp } = req.body;

    if (!mobileNumbers || !plantName || !equipmentName || !alarmType) {
      return res.status(400).json({ success: false, error: 'Missing alarm fields' });
    }

    // Ensure phone number is clean
    const cleanPhone = mobileNumbers.replace(/\D/g, '');

    const payload = {
      mobileNumbers: cleanPhone,
      senderId: process.env.MSGCLUB_SENDER_ID,
      component: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        type: 'template',
        to: cleanPhone,
        template: {
          name: 'stp_alarm_notification', // The new template
          language: { code: 'en' },
          components: [
            {
              type: 'body',
              index: 0,
              parameters: [
                { type: 'text', text: plantName },     // {{1}}
                { type: 'text', text: equipmentName }, // {{2}}
                { type: 'text', text: alarmType },     // {{3}}
                { type: 'text', text: timestamp || new Date().toLocaleString() } // {{4}}
              ],
            },
          ],
        },
        qrImageUrl: false,
        qrLinkUrl: false,
      },
    };

    const msgUrl = `${process.env.MSGCLUB_URL}?AUTH_KEY=${process.env.MSGCLUB_AUTH_KEY}`;
    const msgResponse = await axios.post(msgUrl, payload, { timeout: 20000 });

    if (msgResponse.data.responseCode === '3001' || msgResponse.data.responseCode === '200') {
      return res.json({ success: true, message: 'Alarm sent successfully!' });
    }

    return res.status(400).json({ success: false, error: msgResponse.data });
  } catch (err) {
    console.error('❌ Alarm Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});


/* -------------------- WHATSAPP ROUTE -------------------- */
app.post('/api/whatsapp/test', async (req, res) => {
  const { mobileNumber } = req.body;

  if (!mobileNumber) {
    return res.status(400).json({
      error: 'Mobile number is required'
    });
  }

  const AUTH_KEY = process.env.MSGCLUB_AUTH_KEY;
  const BASE_URL = process.env.MSGCLUB_URL;
  const SENDER_ID = process.env.MSGCLUB_SENDER_ID;
  const TEMPLATE_NAME = process.env.MSGCLUB_TEMPLATE_TEST;

  const url = `${BASE_URL}?AUTH_KEY=${AUTH_KEY}`;

  const payload = {
    mobileNumbers: mobileNumber,
    senderId: SENDER_ID,

    component: {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      type: "template",

      template: {
        name: TEMPLATE_NAME,

        language: {
          code: "en"
        },

        components: [
          {
            type: "body",
            index: 0,
            parameters: [
              {
                type: "text",
                text: "KAIRA"
              }
            ]
          }
        ]
      },

      to: mobileNumber
    }
  };

  try {
    const response = await axios.post(url, payload, {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      }
    });

    res.json({
      success: true,
      data: response.data
    });

  } catch (err) {
    console.error(
      'WhatsApp API Error:',
      err.response?.data || err.message
    );

    res.status(500).json({
      error: 'Failed to send WhatsApp message'
    });
  }
});

/* -------------------- REPORT (Honda DB) -------------------- */
app.get('/api/report', async (req, res) => {
  const { start, end } = req.query;

  if (!start || !end) {
    return res.status(400).json({
      error: 'Start and end dates are required'
    });
  }

  try {
    const result = await authPool.query(
      `SELECT * FROM honda_db 
       WHERE ts >= $1 AND ts <= $2 
       ORDER BY ts ASC`,
      [start, end]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('DB Error:', err);
    res.status(500).json({
      error: 'Database error'
    });
  }
});

/* -------------------- EMS ROUTES -------------------- */

// 1. Get Meter Master List
app.get('/api/ems/meters', async (req, res) => {
  try {
    const result = await emsPool.query('SELECT * FROM ems_master ORDER BY meter_id');
    res.json(result.rows);
  } catch (err) {
    console.error('EMS DB Error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// 2. Get Daily Summary
app.get('/api/ems/daily', async (req, res) => {
  try {
    const sql = `
      WITH last_5_days AS (
          SELECT DISTINCT date FROM vw_meter_daily_summary ORDER BY date DESC LIMIT 5
      )
      SELECT 
        v.date::text, 
        m.building_name, 
        SUM(v.energy_consumption) as energy_consumption
      FROM vw_meter_daily_summary v
      JOIN ems_master m ON v.meter_id = m.meter_id
      WHERE v.date IN (SELECT date FROM last_5_days)
      AND m.meter_type = 'SECURE'
      GROUP BY v.date, m.building_name
      ORDER BY v.date ASC;
    `;
    const result = await emsPool.query(sql);
    res.json(result.rows);
  } catch (err) {
    console.error('EMS Daily Error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// 3. Get Hourly Details
app.get('/api/ems/hourly', async (req, res) => {
  const { date } = req.query;
  const targetDate = date || new Date().toISOString().split('T')[0];

  try {
    const sql = `
      SELECT
          date_trunc('hour', s.reading_timestamp) AS hour,
          m.building_name,
          GREATEST(0, AVG(s.active_power)) AS avg_load 
      FROM meter_reading_secure s
      JOIN ems_master m ON s.meter_id = m.meter_id
      WHERE date(s.reading_timestamp) = $1::date
      AND m.meter_type = 'SECURE'
      GROUP BY 1, 2
      ORDER BY 1 ASC;
    `;
    const result = await emsPool.query(sql, [targetDate]);
    res.json(result.rows);
  } catch (err) {
    console.error('EMS Hourly Error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// 4. Get Monthly Summary
app.get('/api/ems/monthly', async (req, res) => {
  try {
    const result = await emsPool.query('SELECT * FROM vw_meter_monthly_summary ORDER BY month DESC, meter_id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('EMS DB Error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// 5. Get Semi-Monthly Summary
app.get('/api/ems/semimonthly', async (req, res) => {
  try {
    const result = await emsPool.query('SELECT * FROM vw_meter_semimonthly_summary ORDER BY report_period DESC, meter_id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('EMS DB Error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// 6. Get UGVCL Monthly Summary
app.get('/api/ems/ugvcl', async (req, res) => {
  try {
    const result = await emsPool.query('SELECT * FROM vw_meter_ugvcl_monthly_summary ORDER BY report_period DESC, meter_id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('EMS DB Error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// 7. Dashboard Stats
app.get('/api/ems/dashboard-stats', async (req, res) => {
  const { date } = req.query;
  const targetDate = date || new Date().toISOString().split('T')[0];

  try {
    const sql = `
      WITH all_readings AS (
        SELECT meter_id, active_power, voltage_ry, voltage_yb, voltage_br, current_l1, current_l2, current_l3, avg_pf, reading_timestamp 
        FROM meter_reading_secure
        WHERE date(reading_timestamp) = $1::date
        UNION ALL
        SELECT meter_id, active_power, 0 as voltage_ry, 0 as voltage_yb, 0 as voltage_br, 0 as current_l1, 0 as current_l2, 0 as current_l3, avg_pf, reading_timestamp 
        FROM meter_reading_lt
        WHERE date(reading_timestamp) = $1::date
      ),
      latest_readings AS (
        SELECT DISTINCT ON (meter_id) 
          meter_id, active_power, 
          (COALESCE(voltage_ry,0) + COALESCE(voltage_yb,0) + COALESCE(voltage_br,0)) / 3.0 as avg_v_raw,
          (COALESCE(current_l1,0) + COALESCE(current_l2,0) + COALESCE(current_l3,0)) / 3.0 as avg_a_raw,
          avg_pf, reading_timestamp 
        FROM all_readings 
        ORDER BY meter_id, reading_timestamp DESC
      ),
      daily_cons AS (
        SELECT meter_id, SUM(energy_consumption) as energy_consumption
        FROM vw_meter_daily_summary 
        WHERE date = $1::date
        GROUP BY meter_id
      )
      SELECT 
        m.meter_id, m.meter_name, m.building_name, m.meter_type,
        r.active_power, 
        r.avg_v_raw as avg_voltage, 
        r.avg_a_raw as avg_current, 
        r.avg_pf, 
        r.reading_timestamp,
        COALESCE(d.energy_consumption, 0) as day_energy
      FROM ems_master m
      LEFT JOIN latest_readings r ON m.meter_id = r.meter_id
      LEFT JOIN daily_cons d ON m.meter_id = d.meter_id
      WHERE m.meter_type IN ('SECURE', 'LT')
      ORDER BY m.meter_id ASC;
    `;

    const result = await emsPool.query(sql, [targetDate]);
    res.json(result.rows);
  } catch (err) {
    console.error('EMS Dashboard Error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/* -------------------- START -------------------- */
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});