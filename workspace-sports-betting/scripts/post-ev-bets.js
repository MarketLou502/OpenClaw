// post-ev-bets.js
// Scrapes +EV bets and posts each qualifying bet directly to Discord.
// Usage: node post-ev-bets.js <bookname>
// Stdout: "Posted N bets" or "No qualifying bets found"

const { execSync } = require('child_process');
const path = require('path');

const fs = require('fs');
const privateEnv = fs.readFileSync(path.resolve(__dirname, '..', '..', '.env'), 'utf8');
const DISCORD_TOKEN = process.env.DISCORD_SPORTS_BETTING_TOKEN ||
  privateEnv.match(/^DISCORD_SPORTS_BETTING_TOKEN=(.*)$/m)?.[1]?.trim();
if (!DISCORD_TOKEN) throw new Error('DISCORD_SPORTS_BETTING_TOKEN is not configured');
const CHANNEL_ID = '1480115198844076163';
const SCRAPER = path.join(__dirname, 'scrape-ev.js');

async function postToDiscord(content) {
  const res = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bot ${DISCORD_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord API ${res.status}: ${text}`);
  }
  // Discord rate limit: 5 msg/5s per channel — 700ms gives safe headroom
  await new Promise(r => setTimeout(r, 700));
}

async function run(book) {
  let raw;
  try {
    raw = execSync(`node "${SCRAPER}" ${book}`, { timeout: 60000 }).toString();
  } catch (err) {
    process.stdout.write(`Scraper error: ${err.message}\n`);
    process.exit(1);
  }

  const data = JSON.parse(raw);
  const bets = (data.bets || [])
    .sort((a, b) => b.ev_pct - a.ev_pct)
    .slice(0, 2);

  if (bets.length === 0) {
    process.stdout.write('No qualifying bets found\n');
    return;
  }

  for (const bet of bets) {
    const msg = `${bet.event} Market: ${bet.market}\nPick: ${bet.bet_name} ${bet.odds} EV: +${bet.ev_pct}%`;
    await postToDiscord(msg);
  }

  process.stdout.write(`Posted ${bets.length} bets\n`);
}

const book = process.argv[2];
if (!book) {
  process.stderr.write('Usage: node post-ev-bets.js <bookname>\n');
  process.exit(1);
}

run(book).catch(err => {
  process.stdout.write(`Error: ${err.message}\n`);
  process.exit(1);
});
