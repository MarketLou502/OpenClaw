#!/usr/bin/env node
// Usage: node run-survey.js <SURVEY_CODE> [EMAIL]
// Fills out the Zaxby's Voice of the Guest survey with top-box answers.

const { chromium } = require('playwright');

const SURVEY_URL = 'https://www.myzaxbysfeedback.com';
const DEFAULT_EMAIL = 'aaron143574@icloud.com';

// Direct JS click — bypasses Playwright actionability checks (visibility, overlap, etc.)
// Much more reliable for survey radio buttons and submit buttons.
async function jsClick(el) {
  await el.evaluate(node => node.click());
}

async function clickNext(page) {
  // Try each selector in order; use JS click to avoid timeout on hidden/overlapping elements
  const selectors = ['input[type="submit"]', 'input[value="Next"]', 'button'];
  for (const sel of selectors) {
    const btns = await page.$$(sel);
    for (const btn of btns) {
      const text = await btn.evaluate(n => (n.value || n.textContent || '').trim());
      if (/^(next|start|submit)$/i.test(text)) {
        await jsClick(btn);
        await page.waitForLoadState('networkidle').catch(() => {});
        await page.waitForTimeout(500);
        return;
      }
    }
  }
  // Last resort: click the first visible submit-type button
  const any = await page.$('input[type="submit"], button[type="submit"]');
  if (any) {
    await jsClick(any);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(500);
  }
}

// Pick the first radio per name group (= "Highly Satisfied" / "Highly Likely")
async function pickFirstRadioPerGroup(page) {
  const radios = await page.$$('input[type="radio"]');
  const chosen = new Set();
  for (const radio of radios) {
    const name = await radio.getAttribute('name');
    if (name && !chosen.has(name)) {
      await jsClick(radio);
      chosen.add(name);
    }
  }
}

async function runSurvey(surveyCode, email = DEFAULT_EMAIL) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    // Step 1: Enter survey code and click Start
    await page.goto(SURVEY_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input[type="text"]', { timeout: 15000 });
    await page.fill('input[type="text"]', surveyCode);

    const startBtn = await page.$('input[type="submit"], button');
    if (startBtn) await jsClick(startBtn);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(2000);

    // Check for rejection on entry page
    const entryText = await page.textContent('body');
    if (/not valid|invalid|not found|not recognized|expired/i.test(entryText)) {
      await browser.close();
      return { success: false, message: `Code "${surveyCode}" was rejected. Check that it's copied exactly from the receipt.` };
    }

    let stepCount = 0;
    const maxSteps = 25;

    while (stepCount < maxSteps) {
      stepCount++;
      const bodyText = await page.textContent('body');
      const url = page.url();

      // Done
      if (/thank you|check your email/i.test(bodyText)) {
        await browser.close();
        return { success: true, message: 'Survey complete! Check your email for the coupon.' };
      }

      // Already used
      if (/already.*(complet|taken|used|submit)/i.test(bodyText)) {
        await browser.close();
        return { success: false, message: 'This survey code has already been used.' };
      }

      // Email page — fill both fields
      if (/email address/i.test(bodyText)) {
        const inputs = await page.$$('input[type="text"], input[type="email"]');
        for (const inp of inputs) {
          const name = (await inp.getAttribute('name') || '').toLowerCase();
          const id   = (await inp.getAttribute('id')   || '').toLowerCase();
          if (name.includes('email') || id.includes('email') || inputs.length <= 2) {
            await inp.fill(email);
          }
        }
        await clickNext(page);
        continue;
      }

      // "More questions?" page — pick "No, thanks" (last radio)
      if (/answer more questions|no,?\s*thanks/i.test(bodyText)) {
        const radios = await page.$$('input[type="radio"]');
        // Find radio whose label contains "no"
        let picked = false;
        for (const radio of radios) {
          const label = await radio.evaluate(el => {
            const l = document.querySelector(`label[for="${el.id}"]`);
            return l ? l.textContent : '';
          });
          if (/no/i.test(label)) { await jsClick(radio); picked = true; break; }
        }
        if (!picked && radios.length > 0) await jsClick(radios[radios.length - 1]);
        await clickNext(page);
        continue;
      }

      // Any page with radio buttons — pick first per group (= top-box answer)
      const radios = await page.$$('input[type="radio"]');
      if (radios.length > 0) {
        await pickFirstRadioPerGroup(page);
        await clickNext(page);
        continue;
      }

      // Free-text comment box — fill with a short positive response and move on
      const textareas = await page.$$('textarea');
      if (textareas.length > 0) {
        for (const ta of textareas) {
          await ta.fill('Great food and service, very satisfied!');
        }
        await clickNext(page);
        continue;
      }

      // Checkbox question (e.g. "Which LTO items...") — pick "None of the above" if present, else first checkbox
      const checkboxes = await page.$$('input[type="checkbox"]');
      if (checkboxes.length > 0) {
        let pickedNone = false;
        for (const cb of checkboxes) {
          const label = await cb.evaluate(el => {
            const l = document.querySelector(`label[for="${el.id}"]`);
            return l ? l.textContent.trim() : '';
          });
          if (/none/i.test(label)) {
            await jsClick(cb);
            pickedNone = true;
            break;
          }
        }
        if (!pickedNone) await jsClick(checkboxes[0]);
        await clickNext(page);
        continue;
      }

      // No radios, not email, not done — diagnose
      const snippet = bodyText.slice(0, 400).replace(/\s+/g, ' ').trim();
      await browser.close();
      return { success: false, message: `Stuck on unexpected page at ${url}. Content: "${snippet}"` };
    }

    await browser.close();
    return { success: false, message: 'Exceeded max steps without completing survey.' };

  } catch (err) {
    await browser.close();
    return { success: false, message: `Error: ${err.message}` };
  }
}

const [,, surveyCode, email] = process.argv;
if (!surveyCode) {
  console.error('Usage: node run-survey.js <SURVEY_CODE> [EMAIL]');
  process.exit(1);
}

runSurvey(surveyCode.trim().toUpperCase(), email)
  .then(result => {
    console.log(JSON.stringify(result));
    process.exit(result.success ? 0 : 1);
  })
  .catch(err => {
    console.log(JSON.stringify({ success: false, message: err.message }));
    process.exit(1);
  });
