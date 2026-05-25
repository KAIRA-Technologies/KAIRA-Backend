/* ═══════════════════════════════════════════════════════════════
   server.js  –  KAIRA Backend  |  Entry point
   ─────────────────────────────────────────────────────────────
   Responsibilities:
     • Load environment & validate early
     • Bootstrap Express with global middleware
     • Mount all route modules
     • Start the HTTP listener
═══════════════════════════════════════════════════════════════ */

import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors    from 'cors';
import path    from 'path';
import fs      from 'fs';

import { validateEnv }   from './config/env.js';
import { verifyToken }   from './middleware/auth.js';

import authRoutes      from './routes/auth.js';
import emailRoutes     from './routes/email.js';
import whatsappRoutes  from './routes/whatsapp.js';
import reportRoutes    from './routes/report.js';
import emsRoutes       from './routes/ems.js';

/* ─────────────────────────────────────────────
   1. ENVIRONMENT VALIDATION  (fail-fast)
───────────────────────────────────────────── */
validateEnv();

/* ─────────────────────────────────────────────
   2. APP SETUP
───────────────────────────────────────────── */
const app       = express();
const __dirname = path.resolve();
const reportsDir = path.join(__dirname, 'storage', 'reports');

// Ensure persistent PDF storage folder exists
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

/* ─────────────────────────────────────────────
   3. GLOBAL MIDDLEWARE
───────────────────────────────────────────── */
app.use(cors({ origin: true, credentials: true, methods: ['GET', 'POST'] }));
app.use(express.json({ limit: '50mb' }));

// Public static PDF serving (for Meta/WhatsApp URL validation)
app.use('/reports', express.static(reportsDir, {
  setHeaders: (res) => {
    res.setHeader('Content-Type',                'application/pdf');
    res.setHeader('Content-Disposition',         'inline');
    res.setHeader('Access-Control-Allow-Origin', '*');
  },
}));

/* ─────────────────────────────────────────────
   4. PUBLIC ROUTES  (no auth required)
───────────────────────────────────────────── */
app.use('/api/auth',  authRoutes);

// Email alarm & WhatsApp alarm are intentionally public
// (triggered by PLC/SCADA systems without user sessions)
app.use('/api/email',     emailRoutes);
app.use('/api/whatsapp',  whatsappRoutes);

/* ─────────────────────────────────────────────
   5. PROTECTED ROUTES  (JWT required)
───────────────────────────────────────────── */
app.use(verifyToken);

app.use('/api/report', reportRoutes);
app.use('/api/ems',    emsRoutes);

// Protected PDF download (forces attachment + skips ngrok warning)
app.use('/reports', express.static(reportsDir, {
  setHeaders: (res) => {
    res.setHeader('Content-Type',        'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=report.pdf');
    res.setHeader('ngrok-skip-browser-warning', 'true');
  },
}));

/* ─────────────────────────────────────────────
   6. 404 FALLBACK
───────────────────────────────────────────── */
app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));

/* ─────────────────────────────────────────────
   7. START SERVER
───────────────────────────────────────────── */
const PORT = Number(process.env.PORT) || 3001;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀  KAIRA Backend  →  http://localhost:${PORT}`);
  console.log(`📂  PDF store      →  ${reportsDir}`);
  console.log(`🌐  Public base    →  ${process.env.BASE_PUBLIC_URL}`);
});
