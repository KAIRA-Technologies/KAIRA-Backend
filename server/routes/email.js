/* ═══════════════════════════════════════════════════════════════
   routes/email.js  –  Email delivery routes
     POST /api/email/send    →  Send PDF report via email
     POST /api/email/alarm   →  Send STP critical alarm email
═══════════════════════════════════════════════════════════════ */

import { Router } from 'express';
import axios      from 'axios';

const router = Router();

/* ───────────────────────────────────────────
   POST /api/email/send
   Send a PDF report as an email attachment
─────────────────────────────────────────── */
router.post('/send', async (req, res) => {
  try {
    console.log('📧 Raw request body keys:', Object.keys(req.body));

    const { toEmailSet, reportType, date, pdfBase64, fromName, subject } = req.body;

    if (!toEmailSet || !Array.isArray(toEmailSet) || toEmailSet.length === 0)
      return res.status(400).json({ success: false, error: 'Missing field: toEmailSet' });
    if (!reportType)
      return res.status(400).json({ success: false, error: 'Missing field: reportType' });
    if (!date)
      return res.status(400).json({ success: false, error: 'Missing field: date' });
    if (!pdfBase64)
      return res.status(400).json({ success: false, error: 'Missing field: pdfBase64' });

    // Strip data URI prefix and whitespace
    let cleanedBase64 = pdfBase64.includes(',') ? pdfBase64.split(',')[1] : pdfBase64;
    cleanedBase64 = cleanedBase64.replace(/\s/g, '');

    const fileName = `Report_${reportType}_${date}.pdf`;

    const payload = {
      routeId:     15,
      fromEmail:   process.env.MSGCLUB_FROM_EMAIL,
      fromName:    fromName || process.env.MSGCLUB_FROM_NAME || 'KAIRA',
      toEmailSet,
      ccEmailSet:  [{ email: process.env.MSGCLUB_FROM_EMAIL, personName: 'KAIRA' }],
      bccEmailSet: [{ email: process.env.MSGCLUB_FROM_EMAIL, personName: 'KAIRA' }],
      contentType: 'html',
      subject:     subject || `${reportType} Report - ${date}`,
      mailContent: `
        <p>Dear User,</p>
        <p>Please find the <strong>${reportType}</strong> report for <strong>${date}</strong> attached.</p>
        <p>Regards,<br/>KAIRA System</p>
      `,
      attachmentType: '1',
      attachments: [{
        fileType: 'application/pdf',
        fileName,
        fileData: cleanedBase64,
      }],
    };

    const emailUrl = `http://msg.msgclub.net/rest/services/sendEmail/email?AUTH_KEY=${process.env.MSGCLUB_AUTH_KEY}`;

    console.log('📧 Sending to:', toEmailSet.map(e => e.email).join(', '));
    console.log('📧 Subject:', payload.subject);

    // MsgClub returns 500 on pretty-printed JSON — always minify
    const emailResponse = await axios.post(emailUrl, JSON.stringify(payload), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      timeout: 30000,
    });

    console.log('📧 MsgClub response:', emailResponse.data);

    const code = String(emailResponse.data?.responseCode);
    if (code === '3001' || code === '200')
      return res.json({ success: true, requestId: emailResponse.data.response });

    return res.status(400).json({ success: false, error: emailResponse.data });

  } catch (err) {
    console.error('❌ Email send error:', err.message);
    if (err.response) {
      console.error('❌ MsgClub detail:', JSON.stringify(err.response.data));
      return res.status(500).json({ success: false, error: err.message, detail: err.response.data });
    }
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ───────────────────────────────────────────
   POST /api/email/alarm
   Send a critical STP alarm notification email
─────────────────────────────────────────── */
router.post('/alarm', async (req, res) => {
  try {
    const { emailAddresses, plantName, equipmentName, alarmType, timestamp } = req.body;

    if (!emailAddresses || !plantName || !equipmentName || !alarmType)
      return res.status(400).json({ success: false, error: 'Missing alarm fields' });

    // Accept comma-separated string or array
    const emails    = typeof emailAddresses === 'string' ? emailAddresses.split(',') : emailAddresses;
    const toEmailSet = emails.map(email => ({ email: email.trim() }));

    const mailContent = `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#333;">
        <h2 style="color:#d9534f;">STP CRITICAL ALARM</h2>
        <p>Hello, an alarm has been triggered at <strong>${plantName}</strong>.</p>
        <p>
          <strong>Component:</strong>   ${equipmentName}<br>
          <strong>Alarm Type:</strong>  ${alarmType}<br>
          <strong>Triggered At:</strong>${timestamp || new Date().toLocaleString()}
        </p>
        <p style="color:#d9534f;font-weight:bold;">
          ACTION REQUIRED: Please check the control panel immediately.
        </p>
        <hr>
        <p style="font-size:12px;color:#777;">System generated alert by KAIRA Technologies.</p>
      </div>
    `;

    const payload = {
      routeId:     15,
      fromEmail:   process.env.MSGCLUB_FROM_EMAIL || 'info@kaira-technologies.com',
      fromName:    'KAIRA ALERTS',
      toEmailSet,
      ccEmailSet:  [],
      bccEmailSet: [],
      contentType: 'html',
      subject:     `[URGENT] CRITICAL ALARM: ${plantName} - ${alarmType}`,
      mailContent,
    };

    const emailUrl = `http://msg.msgclub.net/rest/services/sendEmail/email?AUTH_KEY=${process.env.MSGCLUB_AUTH_KEY}`;

    console.log(`📧 Sending alarm email to: ${emails.join(', ')}`);

    const emailResponse = await axios.post(emailUrl, JSON.stringify(payload), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      timeout: 25000,
    });

    console.log('📧 MsgClub alarm response:', emailResponse.data);

    const code = String(emailResponse.data?.responseCode);
    if (code === '3001' || code === '200')
      return res.json({ success: true, message: 'Alarm email sent successfully!' });

    return res.status(400).json({ success: false, error: emailResponse.data });

  } catch (err) {
    console.error('❌ Email alarm error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
