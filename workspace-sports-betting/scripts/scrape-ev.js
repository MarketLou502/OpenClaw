// scrape-ev.js
// Usage: node scrape-ev.js <bookname>
// Outputs JSON to stdout, errors to stderr
//
// Valid booknames: bet365, betmgm, fanatics, fanduel, caesars, draftkings

const { chromium } = require('playwright');

// Numeric dropdown values from the +EV Sportsbook <select> on CrazyNinjaOdds
const BOOKS = {
  bet365:     '21',
  betmgm:     '4',
  fanatics:   '22',
  fanduel:    '1',
  caesars:    '3',
  draftkings: '2',
};

const DROPDOWN_SEL = '#ContentPlaceHolderMain_ContentPlaceHolderRight_WebUserControl_FilterSportsbookSite_DropDownListSportsbookSite_All';
const PAGE_URL = 'https://crazyninjaodds.com/site/tools/positive-ev.aspx';

function delay(minMs, maxMs) {
  const ms = Math.floor(Math.random() * (maxMs - minMs) + minMs);
  return new Promise(r => setTimeout(r, ms));
}

async function scrape(bookName) {
  const bookValue = BOOKS[bookName.toLowerCase()];
  if (!bookValue) {
    process.stderr.write(JSON.stringify({
      error: `Unknown book: "${bookName}"`,
      valid: Object.keys(BOOKS),
    }) + '\n');
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  // Patch navigator.webdriver to hide automation
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();

  try {
    await page.goto(PAGE_URL, { waitUntil: 'load' });
    // Wait for the dropdown to be ready — faster than networkidle
    await page.waitForSelector(DROPDOWN_SEL, { state: 'visible', timeout: 15000 });
    await delay(800, 1500);

    // Select sportsbook from dropdown
    await page.selectOption(DROPDOWN_SEL, bookValue);
    await delay(700, 1500);

    // Arm XHR listener BEFORE clicking Update.
    // The page uses ASP.NET UpdatePanel — clicking Update fires a POST
    // back to positive-ev.aspx itself. We wait for that response to land
    // before reading the DOM.
    const xhrDone = page.waitForResponse(
      r => r.url().includes('positive-ev.aspx') && r.request().method() === 'POST',
      { timeout: 20000 }
    );

    await page.click('input[value="Update"]');
    await xhrDone;
    await delay(500, 1000);

    // Extract rows from the EV results table.
    // Column layout (0-indexed):
    //   0  LW-WC EV%
    //   1  Calc (button — skip)
    //   2  Extra (PX Odds link or blank — skip)
    //   3  Date
    //   4  Sport
    //   5  League
    //   6  Event
    //   7  Market
    //   8  Bet Name
    //   9  Odds
    //  10  Sportsbook
    //  11  Fair Odds
    //  12  Books
    const bets = await page.evaluate(() => {
      // Find the results table by locating the one with an EV% header
      const tables = Array.from(document.querySelectorAll('table'));
      let targetTable = null;
      for (const t of tables) {
        if (t.innerText && t.innerText.includes('EV%')) {
          targetTable = t;
          break;
        }
      }
      if (!targetTable) return [];

      const rows = Array.from(targetTable.querySelectorAll('tr'));
      const result = [];

      for (const row of rows.slice(1)) { // skip header row
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length < 12) continue;

        const evText = cells[0].textContent.trim().replace('%', '');
        const ev = parseFloat(evText);
        if (isNaN(ev) || ev < 3.0) continue;

        result.push({
          ev_pct:     ev,
          date:       cells[3].textContent.trim(),
          sport:      cells[4].textContent.trim(),
          league:     cells[5].textContent.trim(),
          event:      cells[6].textContent.trim(),
          market:     cells[7].textContent.trim(),
          bet_name:   cells[8].textContent.trim(),
          odds:       cells[9].textContent.trim(),
          sportsbook: cells[10].textContent.trim(),
          fair_odds:  cells[11].textContent.trim(),
          books:      cells[12] ? cells[12].textContent.trim() : '',
        });
      }

      return result;
    });

    const output = {
      book:       bookName.toLowerCase(),
      scraped_at: new Date().toISOString(),
      count:      bets.length,
      bets,
    };

    process.stdout.write(JSON.stringify(output, null, 2) + '\n');

  } finally {
    await browser.close();
  }
}

const bookArg = process.argv[2];
if (!bookArg) {
  process.stderr.write('Usage: node scrape-ev.js <bookname>\n');
  process.stderr.write(`Valid books: ${Object.keys(BOOKS).join(', ')}\n`);
  process.exit(1);
}

scrape(bookArg).catch(err => {
  process.stderr.write(JSON.stringify({ error: err.message }) + '\n');
  process.exit(1);
});
