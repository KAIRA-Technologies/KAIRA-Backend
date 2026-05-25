/* ═══════════════════════════════════════════════════════════════
   routes/ems.js  –  Energy Management System routes
     GET /api/ems/meters           →  Full meter master list
     GET /api/ems/daily            →  Last-5-days SECURE energy by building
     GET /api/ems/hourly?date=     →  Hourly load profile for a given date
     GET /api/ems/monthly          →  Monthly summary (all meters)
     GET /api/ems/semimonthly      →  Semi-monthly summary
     GET /api/ems/ugvcl            →  UGVCL monthly summary
     GET /api/ems/dashboard-stats?date=  →  Latest readings + day energy
═══════════════════════════════════════════════════════════════ */

import { Router } from 'express';
import { emsPool } from '../db.js';

const router = Router();

/* ───────────────────────────────────────────
   GET /api/ems/meters
─────────────────────────────────────────── */
router.get('/meters', async (_req, res) => {
  try {
    const result = await emsPool.query('SELECT * FROM ems_master ORDER BY meter_id');
    res.json(result.rows);
  } catch (err) {
    console.error('EMS DB Error [/meters]:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

/* ───────────────────────────────────────────
   GET /api/ems/daily
   Last 5 days, SECURE meters grouped by building
─────────────────────────────────────────── */
router.get('/daily', async (_req, res) => {
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
    console.error('EMS DB Error [/daily]:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

/* ───────────────────────────────────────────
   GET /api/ems/hourly?date=YYYY-MM-DD
─────────────────────────────────────────── */
router.get('/hourly', async (req, res) => {
  const targetDate = req.query.date || new Date().toISOString().split('T')[0];
  const sql = `
    SELECT
      date_trunc('hour', s.reading_timestamp)  AS hour,
      m.building_name,
      GREATEST(0, AVG(s.active_power))         AS avg_load
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
    console.error('EMS DB Error [/hourly]:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

/* ───────────────────────────────────────────
   GET /api/ems/monthly
─────────────────────────────────────────── */
router.get('/monthly', async (_req, res) => {
  try {
    const result = await emsPool.query(
      'SELECT * FROM vw_meter_monthly_summary ORDER BY month DESC, meter_id ASC',
    );
    res.json(result.rows);
  } catch (err) {
    console.error('EMS DB Error [/monthly]:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

/* ───────────────────────────────────────────
   GET /api/ems/semimonthly
─────────────────────────────────────────── */
router.get('/semimonthly', async (_req, res) => {
  try {
    const result = await emsPool.query(
      'SELECT * FROM vw_meter_semimonthly_summary ORDER BY report_period DESC, meter_id ASC',
    );
    res.json(result.rows);
  } catch (err) {
    console.error('EMS DB Error [/semimonthly]:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

/* ───────────────────────────────────────────
   GET /api/ems/ugvcl
─────────────────────────────────────────── */
router.get('/ugvcl', async (_req, res) => {
  try {
    const result = await emsPool.query(
      'SELECT * FROM vw_meter_ugvcl_monthly_summary ORDER BY report_period DESC, meter_id ASC',
    );
    res.json(result.rows);
  } catch (err) {
    console.error('EMS DB Error [/ugvcl]:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

/* ───────────────────────────────────────────
   GET /api/ems/dashboard-stats?date=YYYY-MM-DD
   Latest readings + day energy for all SECURE & LT meters
─────────────────────────────────────────── */
router.get('/dashboard-stats', async (req, res) => {
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
    console.error('EMS DB Error [/dashboard-stats]:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
