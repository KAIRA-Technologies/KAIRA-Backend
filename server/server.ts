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
/* ═══════════════════════════════════════════
   EMAIL REPORT ROUTE
   POST /api/email/send
═══════════════════════════════════════════ */
app.post('/api/email/send', async (req, res) => {
  try {
    console.log('📧 Raw request body keys:', Object.keys(req.body));

    const { 
      toEmailSet,    // ← match exactly what Angular sends
      reportType, 
      date, 
      pdfBase64, 
      fromName, 
      subject 
    } = req.body;

    if (!toEmailSet || !Array.isArray(toEmailSet) || toEmailSet.length === 0) {
      return res.status(400).json({ success: false, error: 'Missing field: toEmailSet' });
    }
    if (!reportType) return res.status(400).json({ success: false, error: 'Missing field: reportType' });
    if (!date)       return res.status(400).json({ success: false, error: 'Missing field: date' });
    if (!pdfBase64)  return res.status(400).json({ success: false, error: 'Missing field: pdfBase64' });

    // Clean Base64
    let cleanedBase64 = pdfBase64.includes(',') ? pdfBase64.split(',')[1] : pdfBase64;
    cleanedBase64 = cleanedBase64.replace(/\s/g, '');

    const fileName = `Report_${reportType}_${date}.pdf`;

    // ✅ routeId 15, ccEmailSet/bccEmailSet required by MsgClub (send empty objects workaround)
    const payload = {
      routeId: 15,
      fromEmail: process.env.MSGCLUB_FROM_EMAIL,
      fromName: fromName || process.env.MSGCLUB_FROM_NAME || 'KAIRA',
      toEmailSet,
      ccEmailSet:  [{ email: process.env.MSGCLUB_FROM_EMAIL, personName: 'KAIRA' }],
      bccEmailSet: [{ email: process.env.MSGCLUB_FROM_EMAIL, personName: 'KAIRA' }],
      contentType: 'html',
      subject: subject || `${reportType} Report - ${date}`,
      mailContent: `<p>Dear User,</p><p>Please find the <strong>${reportType}</strong> report for <strong>${date}</strong> attached.</p><p>Regards,<br/>KAIRA System</p>`,
      attachmentType: '1',
      attachments: [{
        fileType: 'application/pdf',
        fileName,
        fileData: cleanedBase64
      }]
    };

    // ✅ Minify — MsgClub returns 500 on pretty JSON
    const minifiedPayload = JSON.stringify(payload);

    const emailUrl = `http://msg.msgclub.net/rest/services/sendEmail/email?AUTH_KEY=${process.env.MSGCLUB_AUTH_KEY}`;

    console.log('📧 Sending to:', toEmailSet.map(e => e.email).join(', '));
    console.log('📧 Subject:', payload.subject);

    const emailResponse = await axios.post(emailUrl, minifiedPayload, {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache'
      },
      timeout: 30000,
    });

    console.log('📧 MsgClub response:', emailResponse.data);

    const code = String(emailResponse.data?.responseCode);
    if (code === '3001' || code === '200') {
      return res.json({ success: true, requestId: emailResponse.data.response });
    }

    return res.status(400).json({ success: false, error: emailResponse.data });

  } catch (err: any) {
    console.error('❌ Email Error:', err.message);
    if (err.response) {
      console.error('❌ MsgClub detail:', JSON.stringify(err.response.data));
      return res.status(500).json({ success: false, error: err.message, detail: err.response.data });
    }
    return res.status(500).json({ success: false, error: err.message });
  }
});
/* ═══════════════════════════════════════════
   EMAIL ALARM ROUTE
   POST /api/email/alarm
═══════════════════════════════════════════ */
app.post('/api/email/alarm', async (req, res) => {
  try {
    const { emailAddresses, plantName, equipmentName, alarmType, timestamp } = req.body;

    // 1. Validation
    if (!emailAddresses || !plantName || !equipmentName || !alarmType) {
      return res.status(400).json({ success: false, error: 'Missing alarm fields' });
    }

    // 2. Format Recipients (toEmailSet)
    // Supports comma-separated string "user1@ex.com, user2@ex.com" or an Array
    const emails = typeof emailAddresses === 'string' ? emailAddresses.split(',') : emailAddresses;
    const toEmailSet = emails.map((email: string) => ({ email: email.trim() }));

    // 3. Construct HTML Body (Matches the screenshot template provided)
    const mailContent = `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
        <h2 style="color: #d9534f;">STP CRITICAL ALARM</h2>
        <p>Hello, an alarm has been triggered at <strong>${plantName}</strong>.</p>
        <p>
          <strong>Component:</strong> ${equipmentName}<br>
          <strong>Alarm Type:</strong> ${alarmType}<br>
          <strong>Triggered At:</strong> ${timestamp || new Date().toLocaleString()}
        </p>
        <p style="color: #d9534f; font-weight: bold;">
          ACTION REQUIRED: Please check the control panel immediately.
        </p>
        <hr>
        <p style="font-size: 12px; color: #777;">System generated alert by KAIRA Technologies.</p>
      </div>
    `;

    // 4. Build MsgClub Payload
    const payload = {
      routeId: 15, // Transactional Route
      fromEmail: process.env.MSGCLUB_FROM_EMAIL || 'info@kaira-technologies.com',
      fromName: 'KAIRA ALERTS',
      toEmailSet,
      ccEmailSet: [],
      bccEmailSet: [],
      contentType: 'html',
      subject: `[URGENT] CRITICAL ALARM: ${plantName} - ${alarmType}`,
      mailContent: mailContent,
    };

    // MsgClub requires minified JSON string
    const minifiedPayload = JSON.stringify(payload);
    const emailUrl = `http://msg.msgclub.net/rest/services/sendEmail/email?AUTH_KEY=${process.env.MSGCLUB_AUTH_KEY}`;

    console.log(`📧 Sending Alarm Email to: ${emails.join(', ')}`);

    const emailResponse = await axios.post(emailUrl, minifiedPayload, {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache'
      },
      timeout: 25000,
    });

    console.log('📧 MsgClub Email Alarm Response:', emailResponse.data);

    const code = String(emailResponse.data?.responseCode);
    if (code === '3001' || code === '200') {
      return res.json({ success: true, message: 'Alarm Email sent successfully!' });
    }

    return res.status(400).json({ success: false, error: emailResponse.data });

  } catch (err: any) {
    console.error('❌ Email Alarm Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});
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

app.post('/api/whatsapp/send', async (req, res) => {
  try {
    const { mobileNumber, reportType, date, pdfBase64 } = req.body;

    if (!mobileNumber || !reportType || !date || !pdfBase64) {
      return res.status(400).json({ success: false, error: 'Missing fields' });
    }

    // 1. Clean Phone (Must be 91XXXXXXXXXX)
    const cleanPhone = mobileNumber.replace(/\D/g, '');

    // 2. Prepare Base64
    let cleanedBase64 = pdfBase64.includes(',') ? pdfBase64.split(',')[1] : pdfBase64;
    cleanedBase64 = cleanedBase64.replace(/\s/g, '');

    // 3. Create a filename for the button/attachment
    const buttonValue = `Report_${date}.pdf`;

    // 4. Build Payload including the REQUIRED Button Parameter
    const payload = {
      senderId: process.env.MSGCLUB_SENDER_ID,
      component: {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: cleanPhone,
        type: "template",
        template: {
          name: process.env.MSGCLUB_TEMPLATE_NAME,
          language: { code: "en" },
          components: [
            {
              type: "header",
              parameters: [
                {
                  type: "document",
                  document: {
                    mediaFileData: cleanedBase64,
                    filename: buttonValue
                  }
                }
              ]
            },
            {
              type: "body",
              parameters: [
                { type: "text", text: "KAIRA" },    // Body Variable {{1}}
                { type: "text", text: reportType }  // Body Variable {{2}}
              ]
            },
            // THIS IS THE MISSING PART CAUSING THE ERROR
            {
              type: "button",
              sub_type: "url",
              index: 0, 
              parameters: [
                {
                  type: "text",
                  text: buttonValue // This fills the {{1}} in your URL button
                }
              ]
            }
          ]
        }
      }
    };

    const msgUrl = `${process.env.MSGCLUB_URL}?AUTH_KEY=${process.env.MSGCLUB_AUTH_KEY}`;
    const msgResponse = await axios.post(msgUrl, payload);

    if (msgResponse.data.responseCode === '3001' || msgResponse.data.responseCode === '200') {
      return res.json({ success: true, requestId: msgResponse.data.response });
    } else {
      return res.status(400).json({ success: false, error: msgResponse.data });
    }

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



/* ═══════════════════════════════════════════
   HONDA STP REPORT
   GET /api/report?start=<ISO>&end=<ISO>
═══════════════════════════════════════════ */
app.get('/api/report', async (req, res) => {
  const { start, end } = req.query;

  if (!start || !end) {
    return res.status(400).json({ error: 'start and end query params are required (ISO 8601)' });
  }

  try {
    const result = await authPool.query(
      `SELECT *
         FROM honda_db
        WHERE ts >= $1
          AND ts <= $2
        ORDER BY ts ASC`,
      [start, end],
    );
    res.json(result.rows);
  } catch (err) {
    console.error('DB Error [/api/report]:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

/* ═══════════════════════════════════════════
   EMS ROUTES  (emsPool)
═══════════════════════════════════════════ */

// 1. Meter master list
app.get('/api/ems/meters', async (_req, res) => {
  try {
    const result = await emsPool.query('SELECT * FROM ems_master ORDER BY meter_id');
    res.json(result.rows);
  } catch (err) {
    console.error('EMS DB Error [/api/ems/meters]:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// 2. Daily summary – last 5 days, SECURE meters grouped by building
app.get('/api/ems/daily', async (_req, res) => {
  const sql = `
    WITH last_5_days AS (
      SELECT DISTINCT date
        FROM vw_meter_daily_summary
       ORDER BY date DESC
       LIMIT 5
    )
    SELECT
      v.date::text,
      m.building_name,
      SUM(v.energy_consumption) AS energy_consumption
    FROM vw_meter_daily_summary v
    JOIN ems_master m ON v.meter_id = m.meter_id
    WHERE v.date IN (SELECT date FROM last_5_days)
      AND m.meter_type = 'SECURE'
    GROUP BY v.date, m.building_name
    ORDER BY v.date ASC;
  `;
  try {
    const result = await emsPool.query(sql);
    res.json(result.rows);
  } catch (err) {
    console.error('EMS DB Error [/api/ems/daily]:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// 3. Hourly load profile for a given date
app.get('/api/ems/hourly', async (req, res) => {
  const targetDate = req.query.date || new Date().toISOString().split('T')[0];
  const sql = `
    SELECT
      date_trunc('hour', s.reading_timestamp)      AS hour,
      m.building_name,
      GREATEST(0, AVG(s.active_power))             AS avg_load
    FROM meter_reading_secure s
    JOIN ems_master m ON s.meter_id = m.meter_id
    WHERE date(s.reading_timestamp) = $1::date
      AND m.meter_type = 'SECURE'
    GROUP BY 1, 2
    ORDER BY 1 ASC;
  `;
  try {
    const result = await emsPool.query(sql, [targetDate]);
    res.json(result.rows);
  } catch (err) {
    console.error('EMS DB Error [/api/ems/hourly]:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// 4. Monthly summary
app.get('/api/ems/monthly', async (_req, res) => {
  try {
    const result = await emsPool.query(
      'SELECT * FROM vw_meter_monthly_summary ORDER BY month DESC, meter_id ASC',
    );
    res.json(result.rows);
  } catch (err) {
    console.error('EMS DB Error [/api/ems/monthly]:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// 5. Semi-monthly summary
app.get('/api/ems/semimonthly', async (_req, res) => {
  try {
    const result = await emsPool.query(
      'SELECT * FROM vw_meter_semimonthly_summary ORDER BY report_period DESC, meter_id ASC',
    );
    res.json(result.rows);
  } catch (err) {
    console.error('EMS DB Error [/api/ems/semimonthly]:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// 6. UGVCL monthly summary
app.get('/api/ems/ugvcl', async (_req, res) => {
  try {
    const result = await emsPool.query(
      'SELECT * FROM vw_meter_ugvcl_monthly_summary ORDER BY report_period DESC, meter_id ASC',
    );
    res.json(result.rows);
  } catch (err) {
    console.error('EMS DB Error [/api/ems/ugvcl]:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// 7. Dashboard stats – latest readings + day energy per meter
app.get('/api/ems/dashboard-stats', async (req, res) => {
  const targetDate = req.query.date || new Date().toISOString().split('T')[0];
  const sql = `
    WITH all_readings AS (
      SELECT
        meter_id, active_power,
        voltage_ry, voltage_yb, voltage_br,
        current_l1, current_l2, current_l3,
        avg_pf, reading_timestamp
      FROM meter_reading_secure
      WHERE date(reading_timestamp) = $1::date

      UNION ALL

      SELECT
        meter_id, active_power,
        0 AS voltage_ry, 0 AS voltage_yb, 0 AS voltage_br,
        0 AS current_l1, 0 AS current_l2, 0 AS current_l3,
        avg_pf, reading_timestamp
      FROM meter_reading_lt
      WHERE date(reading_timestamp) = $1::date
    ),
    latest_readings AS (
      SELECT DISTINCT ON (meter_id)
        meter_id,
        active_power,
        (COALESCE(voltage_ry,0) + COALESCE(voltage_yb,0) + COALESCE(voltage_br,0)) / 3.0 AS avg_v_raw,
        (COALESCE(current_l1,0) + COALESCE(current_l2,0) + COALESCE(current_l3,0)) / 3.0 AS avg_a_raw,
        avg_pf,
        reading_timestamp
      FROM all_readings
      ORDER BY meter_id, reading_timestamp DESC
    ),
    daily_cons AS (
      SELECT meter_id, SUM(energy_consumption) AS energy_consumption
      FROM vw_meter_daily_summary
      WHERE date = $1::date
      GROUP BY meter_id
    )
    SELECT
      m.meter_id, m.meter_name, m.building_name, m.meter_type,
      r.active_power,
      r.avg_v_raw   AS avg_voltage,
      r.avg_a_raw   AS avg_current,
      r.avg_pf,
      r.reading_timestamp,
      COALESCE(d.energy_consumption, 0) AS day_energy
    FROM ems_master m
    LEFT JOIN latest_readings r ON m.meter_id = r.meter_id
    LEFT JOIN daily_cons      d ON m.meter_id = d.meter_id
    WHERE m.meter_type IN ('SECURE', 'LT')
    ORDER BY m.meter_id ASC;
  `;
  try {
    const result = await emsPool.query(sql, [targetDate]);
    res.json(result.rows);
  } catch (err) {
    console.error('EMS DB Error [/api/ems/dashboard-stats]:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

/* ─────────────────────────────────────────────
   404 FALLBACK
───────────────────────────────────────────── */
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

/* ─────────────────────────────────────────────
   START SERVER
───────────────────────────────────────────── */
const PORT = Number(process.env.PORT) || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀  KAIRA Backend  →  http://localhost:${PORT}`);
  console.log(`📂  PDF store      →  ${reportsDir}`);
  console.log(`🌐  Public base    →  ${process.env.BASE_PUBLIC_URL}`);
});