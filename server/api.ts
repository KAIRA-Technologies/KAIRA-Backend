import express from 'express';
import pkg from 'pg';
import dotenv from 'dotenv';
import cors from 'cors';

const result = dotenv.config({ debug: true });
if (result.error) {
  console.error('Dotenv Error:', result.error);
}
console.log('Current working directory:', process.cwd());

const { Pool } = pkg;

export const apiRouter = express.Router();

// PostgreSQL Pool Configuration
const pool = new Pool({
  host: process.env['DB_HOST'],
  port: parseInt(process.env['DB_PORT'] || '5432'),
  user: process.env['DB_USER'],
  password: String(process.env['DB_PASSWORD'] || ''),
  database: process.env['DB_NAME'] ,
  ssl: process.env['DB_SSL'] === 'true' ? { rejectUnauthorized: false } : false,
});


apiRouter.use(express.json());

// API to fetch report data
apiRouter.get('/report', async (req, res) => {
  const { start, end } = req.query;
  
  if (!start || !end) {
    res.status(400).json({ error: 'Start and end dates are required' });
    return;
  }

  try {
    const query = `
      SELECT * FROM honda_db 
      WHERE ts >= $1 AND ts <= $2 
      ORDER BY ts ASC
    `;
    const result = await pool.query(query, [start, end]);
    res.json(result.rows);
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({ error: 'Failed to fetch data from database' });
  }
});

const app = express();
app.use(cors());
app.use(express.json());
app.use('/api', apiRouter);

// If run directly or PORT is 3001, start the server
// if (process.env['PORT'] === '3001') {
//   const port = process.env['PORT'] || 3001;
//   app.listen(port, () => {
//     console.log(`🚀 API running on port ${port}`);
//   });
// }
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`🚀 API running on http://localhost:${PORT}`);
});