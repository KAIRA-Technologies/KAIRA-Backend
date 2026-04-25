import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import { authPool, emsPool } from './db.js';
import authRoutes from './routes/auth.js';

const app = express();

/* -------------------- MIDDLEWARE -------------------- */
app.use(cors({
  origin: true,
  methods: ['GET', 'POST'],
  credentials: true
}));

app.use(express.json());

/* -------------------- HEALTH -------------------- */
app.get('/health', (req, res) => {
  res.json({
    message: "KAIRA Backend is live 🚀",
    status: "Healthy"
  });
});

/* -------------------- AUTH (Honda DB) -------------------- */
app.use('/api/auth', authRoutes);

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
    // Fetches the last 5 unique days from the summary view
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
    // Matches Grafana logic: AVG active_power grouped by hour
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

// 7. Dashboard Stats (Synced with Grafana Logic)
app.get('/api/ems/dashboard-stats', async (req, res) => {
  const { date } = req.query;
  const targetDate = date || new Date().toISOString().split('T')[0];

  try {
    const sql = `
      WITH all_readings AS (
        SELECT meter_id, active_power, voltage_ry, voltage_yb, voltage_br, current_l1, current_l2, current_l3, avg_pf, reading_timestamp 
        FROM meter_reading_secure
        WHERE date(reading_timestamp) = $1::date -- ONLY fetch data for the SELECTED day
        UNION ALL
        SELECT meter_id, active_power, 0 as voltage_ry, 0 as voltage_yb, 0 as voltage_br, 0 as current_l1, 0 as current_l2, 0 as current_l3, avg_pf, reading_timestamp 
        FROM meter_reading_lt
        WHERE date(reading_timestamp) = $1::date -- ONLY fetch data for the SELECTED day
      ),
      latest_readings AS (
        SELECT DISTINCT ON (meter_id) 
          meter_id, active_power, 
          (COALESCE(voltage_ry,0) + COALESCE(voltage_yb,0) + COALESCE(voltage_br,0)) / 3.0 as avg_v_raw,
          (COALESCE(current_l1,0) + COALESCE(current_l2,0) + COALESCE(current_l3,0)) / 3.0 as avg_a_raw,
          avg_pf, reading_timestamp 
        FROM all_readings 
        ORDER BY meter_id, reading_timestamp DESC -- Gets the latest reading OF THAT SPECIFIC DAY
      ),
      daily_cons AS (
        -- We calculate consumption on the fly to ensure accuracy per meter
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