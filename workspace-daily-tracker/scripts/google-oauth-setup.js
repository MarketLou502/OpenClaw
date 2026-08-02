#!/usr/bin/env node
// One-time interactive setup: exchanges a Google OAuth Client ID/Secret for a
// refresh token and writes it to the credentials file the calendar scripts
// (cal-read.js / cal-add.js / cal-delete.js, via lib/google-calendar.js) read.
//
// Usage:
//   node google-oauth-setup.js <client_id> <client_secret> [calendar_id]
//
// Prerequisite: a Google Cloud OAuth Client ID of type "Desktop app", with the
// Google Calendar API enabled and the consent screen's publishing status set
// to "In production" (Testing-status refresh tokens expire after 7 days).
//
// This opens your browser for a one-time consent, then writes:
//   /Users/aaronmacmini/.openclaw/credentials/google-calendar.json

const http = require('http');
const { spawnSync } = require('child_process');
const fs = require('fs');

const CREDENTIALS_FILE = '/Users/aaronmacmini/.openclaw/credentials/google-calendar.json';
const SCOPE = 'https://www.googleapis.com/auth/calendar';

async function main() {
  const [clientId, clientSecret, calendarId] = process.argv.slice(2);
  if (!clientId || !clientSecret) {
    process.stderr.write('Usage: node google-oauth-setup.js <client_id> <client_secret> [calendar_id]\n');
    process.exit(1);
  }

  const code = await getAuthCode(clientId);
  const port = code.port;
  const tokens = await exchangeCode({ clientId, clientSecret, code: code.code, redirectUri: `http://127.0.0.1:${port}` });

  if (!tokens.refresh_token) {
    process.stderr.write(
      'No refresh_token in the response. This usually means you\'ve already\n' +
      'granted this app access before. Revoke it at\n' +
      'https://myaccount.google.com/permissions and re-run this script.\n'
    );
    process.exit(1);
  }

  const creds = {
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: tokens.refresh_token,
    calendar_id: calendarId || 'aaron@marketlou.com',
  };

  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
  fs.chmodSync(CREDENTIALS_FILE, 0o600);
  process.stdout.write(`Wrote ${CREDENTIALS_FILE}\n`);
  process.stdout.write('Done. cal-read.js / cal-add.js / cal-delete.js will use this from now on.\n');
}

function getAuthCode(clientId) {
  return new Promise((resolve, reject) => {
    let port;

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(error
        ? `<h2>Authorization failed: ${error}</h2>You can close this tab.`
        : '<h2>Authorized.</h2>You can close this tab and return to the terminal.');
      server.close();
      if (error) reject(new Error(error));
      else if (code) resolve({ code, port });
      else reject(new Error('no code or error in callback'));
    });

    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}`;
      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', SCOPE);
      authUrl.searchParams.set('access_type', 'offline');
      authUrl.searchParams.set('prompt', 'consent');

      process.stdout.write(`Opening browser for consent. If it doesn't open, visit:\n${authUrl.toString()}\n\n`);
      spawnSync('open', [authUrl.toString()]);
    });
  });
}

function exchangeCode({ clientId, clientSecret, code, redirectUri }) {
  return fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  }).then(async (res) => {
    const data = await res.json();
    if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${JSON.stringify(data)}`);
    return data;
  });
}

main().catch((err) => {
  process.stderr.write(`Setup failed: ${err.message}\n`);
  process.exit(1);
});
