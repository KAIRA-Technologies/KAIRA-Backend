/* ═══════════════════════════════════════════════════════════════
   routes/report.js  –  Honda STP report data
     GET /api/report?start=<ISO>&end=<ISO>  →  Fetch time-range rows
═══════════════════════════════════════════════════════════════ */

import { Router } from 'express';
import { authPool } from '../db.js';

const router = Router();

/* ───────────────────────────────────────────
   GET /api/report
   Returns honda_db rows between start and end timestamps
─────────────────────────────────────────── */
router.get('/', async (req, res) => {
  const { start, end } = req.query;

  if (!start || !end)
    return res.status(400).json({ error: 'start and end query params are required (ISO 8601)' });

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

export default router;
