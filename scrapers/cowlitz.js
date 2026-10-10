import fs from 'fs';
import * as cheerio from 'cheerio';

export const ROSTER_URL = 'https://apps.co.cowlitz.wa.us/CCCD/custody/default/Index.html';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5'
};

// Per-request cap. A stalled connection would otherwise hang the Actions job.
const REQUEST_TIMEOUT_MS = 30_000;

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Retry wrapper. Backoff: 2s, 5s, 10s.
async function getWithRetry(url, attempts = 3) {
  const backoff = [2000, 5000, 10000];
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        console.error(`  Request failed (attempt ${i + 1}/${attempts}): ${err.message} — retrying in ${backoff[i] / 1000}s`);
        await delay(backoff[i]);
      }
    }
  }
  throw lastErr;
}

function clean(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

// "$1,500.00" / "$500,000" -> 1500 / 500000. Blank or $0 -> null.
function parseDollars(text) {
  const m = (text || '').match(/\$\s*([\d,]+\.?\d*)/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(/,/g, ''));
  return v > 0 ? v : null;
}

// The roster prints Pacific local time as "2026-08-14 12:22:28".
// Store it as "2026-08-14T12:22:28" so browsers parse it reliably (Safari
// rejects the space form) and strings still sort chronologically.
function toLocalIso(text) {
  const t = clean(text);
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t) ? t.replace(' ', 'T') : (t || null);
}

// Cowlitz's "Number" is a per-person inmate number that is reused across
// bookings, so a booking is identified by inmate number + booking time.
export function bookingId(inmateNumber, bookedAt) {
  return `${inmateNumber}-${(bookedAt || '').replace(/\D/g, '')}`;
}

// Everything (roster, profile, charges) is in one static page: the table
// rows plus a hidden Bootstrap modal per inmate (#Modal-tab-<number>).
export function parseRoster(html) {
  const $ = cheerio.load(html);
  const inmates = [];

  $('#basic-btn tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 5) return;

    const name = clean($(cells[0]).text());
    const inmateNumber = clean($(cells[2]).text());
    const bookedAt = toLocalIso($(cells[3]).text());
    const location = clean($(cells[4]).text()) || null;
    if (!inmateNumber || !name) return;

    const modal = $(`#Modal-tab-${inmateNumber}`);

    // Profile tab is a two-column <th>/<td> table. Labels are keyed with all
    // whitespace removed because "Arresting<br/>Agency" reads as "ArrestingAgency".
    const profile = {};
    modal.find(`#profile_${inmateNumber} tr`).each((_, tr) => {
      const label = $(tr).find('th').text().replace(/\s+/g, '');
      if (label) profile[label] = clean($(tr).find('td').text());
    });

    const charges = [];
    modal.find(`#charges_${inmateNumber} tbody tr`).each((_, tr) => {
      // Use toArray(), not .map().get(): cheerio's map drops null results,
      // which would shift every column after an empty cell.
      const tds = $(tr).find('td').toArray().map(td => clean($(td).text()) || null);
      if (!tds[0]) return;
      charges.push({
        description:     tds[0],
        offenseDate:     toLocalIso(tds[1]),
        arrestingAgency: tds[2],
        court:           tds[3],
        warrantNumber:   tds[4],
        disposition:     tds[5],
        billingAgency:   tds[6],
        bondType:        tds[7],
        bondAmount:      parseDollars(tds[8])
      });
    });

    inmates.push({
      id: bookingId(inmateNumber, bookedAt),
      inmateNumber,
      name,
      bookedAt,
      location,
      arrestingAgency: profile['ArrestingAgency'] || null,
      bondTotal: parseDollars(profile['BondTotal']),
      charges
    });
  });

  return inmates;
}

// Set ROSTER_HTML_FILE to parse a saved copy of the page instead of
// fetching (handy for testing the parser offline).
export async function fetchRoster() {
  const html = process.env.ROSTER_HTML_FILE
    ? fs.readFileSync(process.env.ROSTER_HTML_FILE, 'utf-8')
    : await getWithRetry(ROSTER_URL);
  return parseRoster(html);
}
