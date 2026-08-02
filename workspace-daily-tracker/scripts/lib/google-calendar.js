'use strict';
// Shared Google Calendar API v3 helper for cal-read.js / cal-add.js / cal-delete.js.
// Auth: OAuth2 refresh-token flow. Credentials live in CREDENTIALS_FILE, written once
// by scripts/google-oauth-setup.js. No googleapis dependency — Node 22's built-in
// fetch is enough, matching this codebase's existing no-heavy-deps style.

const fs = require('fs');

const CREDENTIALS_FILE = process.env.OPENCLAW_GOOGLE_CALENDAR_CREDENTIALS ||
  '/Users/aaronmacmini/.openclaw/credentials/google-calendar.json';
const TOKEN_URL = process.env.OPENCLAW_GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const API_BASE = process.env.OPENCLAW_GOOGLE_CALENDAR_API_BASE || 'https://www.googleapis.com/calendar/v3';
const TIMEZONE = process.env.OPENCLAW_CALENDAR_TIMEZONE || 'America/New_York';

function loadCredentials() {
  const raw = fs.readFileSync(CREDENTIALS_FILE, 'utf8');
  return JSON.parse(raw);
}

async function getAccessToken() {
  const { client_id, client_secret, refresh_token } = loadCredentials();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id, client_secret, refresh_token, grant_type: 'refresh_token' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`token refresh failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

async function apiFetch(path, { method = 'GET', body, query } = {}) {
  const token = await getAccessToken();
  const url = new URL(`${API_BASE}${path}`);
  if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error body, fall through */ }
  if (!res.ok) throw new Error((data && data.error && data.error.message) || text || `HTTP ${res.status}`);
  return data;
}

// Local-midnight-to-local-midnight bounds for dateStr (YYYY-MM-DD), using the
// system's local timezone (America/New_York) so DST is handled automatically.
function dayBounds(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const start = new Date(y, m - 1, d, 0, 0, 0);
  const end = new Date(y, m - 1, d, 23, 59, 59);
  return { timeMin: start.toISOString(), timeMax: end.toISOString() };
}

function rangeBounds(startDateStr, endDateStr) {
  const [sy, sm, sd] = startDateStr.split('-').map(Number);
  const [ey, em, ed] = endDateStr.split('-').map(Number);
  const start = new Date(sy, sm - 1, sd, 0, 0, 0);
  const end = new Date(ey, em - 1, ed, 0, 0, 0);
  return { timeMin: start.toISOString(), timeMax: end.toISOString() };
}

function dateKeyInTimezone(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function nextDateKey(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const next = new Date(y, m - 1, d + 1, 12, 0, 0);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
}

function fmtHM(date) {
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function reminderSuppressed(event) {
  const privateFlag = event.extendedProperties && event.extendedProperties.private &&
    event.extendedProperties.private.openclawNoReminder;
  if (/^(?:1|true|yes)$/i.test(String(privateFlag || '').trim())) return true;
  return event.reminders && event.reminders.useDefault === false &&
    Array.isArray(event.reminders.overrides) && event.reminders.overrides.length === 0;
}

// Returns events for dateStr. Existing callers use startTime/endTime/title;
// eventId and ISO fields let new deterministic workflows mutate one exact
// event instead of deleting every event with the same title.
async function listEvents(calendar, dateStr) {
  const { timeMin, timeMax } = dayBounds(dateStr);
  const data = await apiFetch(`/calendars/${encodeURIComponent(calendar)}/events`, {
    query: { timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', timeZone: TIMEZONE },
  });
  const items = (data && data.items) || [];
  return items.map((e) => {
    if (e.start && e.start.dateTime && e.end && e.end.dateTime) {
      const s = new Date(e.start.dateTime);
      const en = new Date(e.end.dateTime);
      return {
        eventId: e.id,
        startTime: fmtHM(s),
        endTime: fmtHM(en),
        startIso: e.start.dateTime,
        endIso: e.end.dateTime,
        allDay: false,
        title: e.summary || '',
        noReminder: reminderSuppressed(e),
      };
    }
    // All-day event (only a "date", no "dateTime") — represent as spanning the day.
    return {
      eventId: e.id,
      startTime: '0:00',
      endTime: '23:59',
      startIso: e.start && e.start.date,
      endIso: e.end && e.end.date,
      allDay: true,
      title: e.summary || '',
      noReminder: reminderSuppressed(e),
    };
  });
}

// Returns all expanded events in [startDateStr, endDateStr), with one row per
// day for multi-day all-day events. The dashboard month view can therefore
// group a single API response by date without making 28–31 separate requests.
async function listEventsRange(calendar, startDateStr, endDateStr) {
  const { timeMin, timeMax } = rangeBounds(startDateStr, endDateStr);
  const data = await apiFetch(`/calendars/${encodeURIComponent(calendar)}/events`, {
    query: { timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', timeZone: TIMEZONE },
  });
  const events = [];
  for (const e of (data && data.items) || []) {
    if (e.start && e.start.dateTime && e.end && e.end.dateTime) {
      const start = new Date(e.start.dateTime);
      const end = new Date(e.end.dateTime);
      events.push({
        eventId: e.id,
        date: dateKeyInTimezone(start),
        startTime: fmtHM(start),
        endTime: fmtHM(end),
        startIso: e.start.dateTime,
        endIso: e.end.dateTime,
        allDay: false,
        title: e.summary || '',
        noReminder: reminderSuppressed(e),
      });
      continue;
    }

    const eventStart = (e.start && e.start.date) || startDateStr;
    const eventEnd = (e.end && e.end.date) || nextDateKey(eventStart);
    let date = eventStart < startDateStr ? startDateStr : eventStart;
    const exclusiveEnd = eventEnd < endDateStr ? eventEnd : endDateStr;
    while (date < exclusiveEnd) {
      events.push({
        eventId: e.id,
        date,
        startTime: '0:00',
        endTime: '23:59',
        startIso: eventStart,
        endIso: eventEnd,
        allDay: true,
        title: e.summary || '',
        noReminder: reminderSuppressed(e),
      });
      date = nextDateKey(date);
    }
  }
  return events;
}

async function createEvent({ calendar, title, startIso, durationMin, extendedProperties }) {
  const start = new Date(startIso);
  const end = new Date(start.getTime() + durationMin * 60000);
  const toLocal = (d) => {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  return apiFetch(`/calendars/${encodeURIComponent(calendar)}/events`, {
    method: 'POST',
    body: {
      summary: title,
      start: { dateTime: toLocal(start), timeZone: TIMEZONE },
      end: { dateTime: toLocal(end), timeZone: TIMEZONE },
      ...(extendedProperties ? { extendedProperties } : {}),
    },
  });
}

async function updateEvent({ calendar, eventId, title, startIso, durationMin }) {
  const start = new Date(startIso);
  const end = new Date(start.getTime() + durationMin * 60000);
  const toLocal = (d) => {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  return apiFetch(`/calendars/${encodeURIComponent(calendar)}/events/${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    body: {
      summary: title,
      start: { dateTime: toLocal(start), timeZone: TIMEZONE },
      end: { dateTime: toLocal(end), timeZone: TIMEZONE },
    },
  });
}

async function deleteEvent({ calendar, eventId }) {
  return apiFetch(`/calendars/${encodeURIComponent(calendar)}/events/${encodeURIComponent(eventId)}`, {
    method: 'DELETE',
  });
}

// Deletes every event with an exact-match title, searched over a window wide
// enough to cover realistic "reschedule/delete the thing I just added" usage
// (AppleScript's "whose summary is" was unbounded, but an unbounded search over
// years of recurring-event expansion isn't worth replicating for this use case).
async function deleteEventsByTitle({ calendar, title }) {
  const now = new Date();
  const timeMin = new Date(now.getTime() - 14 * 86400000).toISOString();
  const timeMax = new Date(now.getTime() + 365 * 86400000).toISOString();
  const data = await apiFetch(`/calendars/${encodeURIComponent(calendar)}/events`, {
    query: { timeMin, timeMax, singleEvents: 'true', q: title },
  });
  const items = ((data && data.items) || []).filter((e) => e.summary === title);
  for (const e of items) {
    await apiFetch(`/calendars/${encodeURIComponent(calendar)}/events/${encodeURIComponent(e.id)}`, { method: 'DELETE' });
  }
  return items.length;
}

module.exports = { listEvents, listEventsRange, createEvent, updateEvent, deleteEvent, deleteEventsByTitle };
