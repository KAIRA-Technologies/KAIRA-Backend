/* ═══════════════════════════════════════════════════════════════
   routes/whatsapp.js  –  WhatsApp delivery routes
     POST /api/whatsapp/send    →  Send PDF report via WhatsApp template
     POST /api/whatsapp/alarm   →  Send STP critical alarm via WhatsApp
═══════════════════════════════════════════════════════════════ */

import { Router } from 'express';
import axios      from 'axios';

const router = Router();

/* ───────────────────────────────────────────
   POST /api/whatsapp/send
   Deliver a PDF report using a WhatsApp template message
─────────────────────────────────────────── */
router.post('/send', async (req, res) => {
  try {
    const { mobileNumber, reportType, date, pdfBase64 } = req.body;

    if (!mobileNumber || !reportType || !date || !pdfBase64)
      return res.status(400).json({ success: false, error: 'Missing fields' });

    // Strip non-digits; number must be in format 91XXXXXXXXXX
    const cleanPhone = mobileNumber.replace(/\D/g, '');

    let cleanedBase64 = pdfBase64.includes(',') ? pdfBase64.split(',')[1] : pdfBase64;
    cleanedBase64 = cleanedBase64.replace(/\s/g, '');

    const buttonValue = `Report_${date}.pdf`;

    const payload = {
      senderId: process.env.MSGCLUB_SENDER_ID,
      component: {
        messaging_product: 'whatsapp',
        recipient_type:    'individual',
        to:                cleanPhone,
        type:              'template',
        template: {
          name:     process.env.MSGCLUB_TEMPLATE_NAME,
          language: { code: 'en' },
          components: [
            {
              type: 'header',
              parameters: [{
                type:     'document',
                document: { mediaFileData: cleanedBase64, filename: buttonValue },
              }],
            },
            {
              type: 'body',
              parameters: [
                { type: 'text', text: 'KAIRA'      },   // {{1}}
                { type: 'text', text: reportType   },   // {{2}}
              ],
            },
            {
              type:     'button',
              sub_type: 'url',
              index:    0,
              parameters: [{ type: 'text', text: buttonValue }],  // URL button {{1}}
            },
          ],
        },
      },
    };

    const msgUrl      = `${process.env.MSGCLUB_URL}?AUTH_KEY=${process.env.MSGCLUB_AUTH_KEY}`;
    const msgResponse = await axios.post(msgUrl, payload);

    const code = String(msgResponse.data?.responseCode);
    if (code === '3001' || code === '200')
      return res.json({ success: true, requestId: msgResponse.data.response });

    return res.status(400).json({ success: false, error: msgResponse.data });

  } catch (err) {
    console.error('❌ WhatsApp send error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ───────────────────────────────────────────
   POST /api/whatsapp/alarm
   Send a critical STP alarm via WhatsApp template
─────────────────────────────────────────── */
router.post('/alarm', async (req, res) => {
  try {
    const { mobileNumbers, plantName, equipmentName, alarmType, timestamp } = req.body;

    if (!mobileNumbers || !plantName || !equipmentName || !alarmType)
      return res.status(400).json({ success: false, error: 'Missing alarm fields' });

    const cleanPhone = mobileNumbers.replace(/\D/g, '');

    const payload = {
      mobileNumbers: cleanPhone,
      senderId:      process.env.MSGCLUB_SENDER_ID,
      component: {
        messaging_product: 'whatsapp',
        recipient_type:    'individual',
        type:              'template',
        to:                cleanPhone,
        template: {
          name:     'stp_alarm_notification',
          language: { code: 'en' },
          components: [{
            type:  'body',
            index: 0,
            parameters: [
              { type: 'text', text: plantName                             },  // {{1}}
              { type: 'text', text: equipmentName                        },  // {{2}}
              { type: 'text', text: alarmType                            },  // {{3}}
              { type: 'text', text: timestamp || new Date().toLocaleString() },  // {{4}}
            ],
          }],
        },
        qrImageUrl: false,
        qrLinkUrl:  false,
      },
    };

    const msgUrl      = `${process.env.MSGCLUB_URL}?AUTH_KEY=${process.env.MSGCLUB_AUTH_KEY}`;
    const msgResponse = await axios.post(msgUrl, payload, { timeout: 20000 });

    const code = String(msgResponse.data?.responseCode);
    if (code === '3001' || code === '200')
      return res.json({ success: true, message: 'Alarm sent successfully!' });

    return res.status(400).json({ success: false, error: msgResponse.data });

  } catch (err) {
    console.error('❌ WhatsApp alarm error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
