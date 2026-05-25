/* ═══════════════════════════════════════════════════════════════
   config/env.js  –  Environment validation (fail-fast on startup)
═══════════════════════════════════════════════════════════════ */

const REQUIRED_ENV = [
  'MSGCLUB_URL',
  'MSGCLUB_AUTH_KEY',
  'MSGCLUB_SENDER_ID',
  'MSGCLUB_TEMPLATE_NAME',
  'BASE_PUBLIC_URL',
];

export function validateEnv() {
  const missing = REQUIRED_ENV.filter(k => !process.env[k]);

  if (missing.length) {
    console.error('❌  Missing required environment variables:', missing.join(', '));
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
}
