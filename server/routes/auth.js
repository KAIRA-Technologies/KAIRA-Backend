import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { authPool } from '../db.js';

const router = express.Router();

const allowedDomains = [
  "gmail.com",
  "honda.com",
  "wipro.com",
  "kaira-technologies.com",
  "kalpataruprojects.com",
  "siemens.com",
  "harshaengineers.com",
  "gravitaindia.com",
  "prakash.com",
  "adityabirla.com",
  "ceat.com"
];

function isCorporateEmail(email) {
  const domain = email.split("@")[1];
  return allowedDomains.includes(domain);
}

/* ================= SIGNUP ================= */
router.post("/signup", async (req, res) => {
  try {
    const {
      firstName, lastName, email, username, phone,
      country, location, companyName, jobTitle,
      securityQuestion, securityAnswer, password
    } = req.body;

    if (!isCorporateEmail(email)) {
      return res.status(403).json({ message: "Unauthorized email domain" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const answerHash = await bcrypt.hash(securityAnswer, 10);

    await authPool.query(
      `INSERT INTO users
      (first_name, last_name, email, username, phone, country, location, company_name, job_title,
       security_question, security_answer_hash, password_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        firstName, lastName, email, username, phone, country,
        location, companyName, jobTitle, securityQuestion,
        answerHash, passwordHash
      ]
    );

    res.json({ message: "Account created" });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(400).json({ message: "Email or username already exists" });
    }
    console.error("Signup error:", err);
    res.status(500).json({ message: "Signup failed" });
  }
});

/* ================= LOGIN ================= */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    const result = await authPool.query(
      "SELECT * FROM users WHERE email=$1 OR username=$1",
      [email]
    );

    if (!result.rows.length) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const user = result.rows[0];

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign(
      { id: user.id },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );

    res.json({
      token,
      user: {
        id: user.id,
        firstName: user.first_name,
        lastName: user.last_name,
        email: user.email
      }
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ message: "Login failed" });
  }
});

/* ================= FORGOT PASSWORD ================= */
router.post("/forgot-password", async (req, res) => {
  res.json({ message: "Password reset link will be emailed (to be implemented)" });
});

export default router;