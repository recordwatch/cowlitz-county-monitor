import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchRoster } from './scrapers/cowlitz.js';
import { nowLocalIso } from './utils.js';
import { buildStats } from './stats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_DIR = path.join(__dirname, 'data');
fs.mkdirSync(STORAGE_DIR, { recursive: true });

const LOG_FILE    = path.join(STORAGE_DIR, 'change_log.json');
const STATS_FILE  = path.join(STORAGE_DIR, 'stats.json');
const STATUS_FILE = path.join(STORAGE_DIR, 'status.json');

// If the roster suddenly shrinks below this fraction of who we think is in
// custody, assume the page is broken/partial rather than mass release, and
// don't mark anyone released this run.
const MIN_ROSTER_RATIO = 0.5;

function readJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    console.error(`Could not parse ${file}: ${e.message}`);
    process.exit(1); // never overwrite history with an empty array
  }
  return fallback;
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

async function run() {
  const now = nowLocalIso();
  console.log(`[${now}] Running scrape...`);

  // change_log.json is every booking we've ever seen, newest booking first.
  // Entries are updated in place (charges refresh, release) — no separate roster file.
  const log = readJSON(LOG_FILE, []);
  const isFirstRun = log.length === 0;

  let inmates;
  try {
    inmates = await fetchRoster();
  } catch (err) {
    console.error('Roster fetch failed:', err.message);
    process.exit(1);
  }

  const byId = new Map(log.map(e => [e.id, e]));
  const wasInCustody = log.filter(e => e.status === 'in_custody');

  if (inmates.length === 0 || (wasInCustody.length > 20 && inmates.length < wasInCustody.length * MIN_ROSTER_RATIO)) {
    console.error(`Got ${inmates.length} inmates (expected ~${wasInCustody.length}) — skipping diff to avoid false releases.`);
    process.exit(1);
  }

  const currentIds = new Set();
  let newCount = 0;

  for (const inmate of inmates) {
    if (currentIds.has(inmate.id)) continue;
    currentIds.add(inmate.id);

    const existing = byId.get(inmate.id);
    if (!existing) {
      console.log(`  NEW: ${inmate.name} (${inmate.inmateNumber})`);
      const entry = {
        ...inmate,
        status: 'in_custody',
        firstSeen: now,
        releasedAt: null,
        // true = already in jail when monitoring started, so we didn't watch
        // this booking happen. Stats use it to avoid skewed "new booking" counts.
        baseline: isFirstRun
      };
      log.push(entry);
      byId.set(entry.id, entry);
      newCount++;
      continue;
    }

    // Still in custody: refresh fields that change during a stay (cell moves,
    // added charges, bond set). Keep old charges if the page shows none, so a
    // flaky render never wipes good data.
    existing.status = 'in_custody';
    existing.releasedAt = null;
    existing.name = inmate.name;
    existing.location = inmate.location;
    existing.arrestingAgency = inmate.arrestingAgency || existing.arrestingAgency;
    existing.bondTotal = inmate.bondTotal ?? existing.bondTotal;
    if (inmate.charges.length) existing.charges = inmate.charges;
  }

  // Cowlitz publishes no release feed, so release time = the scrape where
  // they were first missing. Accurate to within one scrape interval (~30 min).
  let releasedCount = 0;
  for (const entry of wasInCustody) {
    if (currentIds.has(entry.id)) continue;
    console.log(`  RELEASED: ${entry.name} (${entry.inmateNumber})`);
    entry.status = 'released';
    entry.releasedAt = now;
    releasedCount++;
  }

  log.sort((a, b) => (b.bookedAt || '').localeCompare(a.bookedAt || ''));

  writeJSON(LOG_FILE, log);
  writeJSON(STATUS_FILE, { inCustody: currentIds.size, lastUpdated: now });
  writeJSON(STATS_FILE, buildStats(log, now));
  console.log(`[${nowLocalIso()}] Done. ${newCount} new, ${releasedCount} released, ${currentIds.size} in custody.`);
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
