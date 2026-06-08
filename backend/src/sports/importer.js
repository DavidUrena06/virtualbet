// sports/importer.js
// Importa partidos de TheSportsDB (gratis, sin API key) y mantiene los scores
// en vivo sincronizados. Cuando un partido termina, resuelve apuestas automáticamente.

const { PrismaClient } = require('@prisma/client');
const { resolveMatch } = require('./resolver');
const prisma = new PrismaClient();

const API_BASE = process.env.SPORTS_API_BASE || 'https://www.thesportsdb.com/api/v1/json/3';

// Ligas que importamos. El nombre va al campo Match.league (uppercase para filtros).
const LEAGUES = [
  { id: '4328', name: 'PREMIER_LEAGUE' },
  { id: '4335', name: 'LA_LIGA' },
  { id: '4332', name: 'SERIE_A' },
  { id: '4480', name: 'CHAMPIONS_LEAGUE' },
  { id: '4346', name: 'MLS' },
];

// Odds por defecto para partidos importados (no tenemos feed de odds real)
const DEFAULT_ODDS = { home: 2.0, draw: 3.2, away: 2.0 };

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'VirtualBet/1.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
  return res.json();
}

function parseStartsAt(event) {
  // TheSportsDB devuelve dateEvent (YYYY-MM-DD) y strTimestamp (ISO con TZ) o strTime.
  if (event.strTimestamp) {
    const d = new Date(event.strTimestamp);
    if (!isNaN(d.getTime())) return d;
  }
  if (event.dateEvent && event.strTime) {
    const d = new Date(`${event.dateEvent}T${event.strTime}Z`);
    if (!isNaN(d.getTime())) return d;
  }
  if (event.dateEvent) {
    const d = new Date(`${event.dateEvent}T20:00:00Z`);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

// 1. fetchUpcomingMatches(leagueId) → próximos partidos formateados
async function fetchUpcomingMatches(leagueId) {
  const data = await fetchJSON(`${API_BASE}/eventsnextleague.php?id=${leagueId}`);
  const events = data?.events || [];
  return events
    .filter(e => e.strHomeTeam && e.strAwayTeam)
    .map(e => ({
      externalId: e.idEvent,
      teamHome:   e.strHomeTeam,
      teamAway:   e.strAwayTeam,
      startsAt:   parseStartsAt(e),
    }))
    .filter(m => m.startsAt && m.startsAt > new Date(Date.now() + 5 * 60 * 1000));
}

// 2. importMatchesToDB → inserta partidos nuevos por liga
async function importMatchesToDB() {
  const summary = { imported: 0, skipped: 0, errors: 0, perLeague: {} };

  for (const league of LEAGUES) {
    summary.perLeague[league.name] = { imported: 0, skipped: 0 };
    try {
      const matches = await fetchUpcomingMatches(league.id);
      for (const m of matches) {
        try {
          const existing = await prisma.match.findUnique({
            where: { externalId: m.externalId },
          });
          if (existing) {
            summary.skipped++;
            summary.perLeague[league.name].skipped++;
            continue;
          }
          await prisma.match.create({
            data: {
              externalId: m.externalId,
              league:     league.name,
              teamHome:   m.teamHome.trim(),
              teamAway:   m.teamAway.trim(),
              oddHome:    DEFAULT_ODDS.home,
              oddDraw:    DEFAULT_ODDS.draw,
              oddAway:    DEFAULT_ODDS.away,
              startsAt:   m.startsAt,
              status:     'UPCOMING',
            },
          });
          summary.imported++;
          summary.perLeague[league.name].imported++;
        } catch (err) {
          summary.errors++;
          console.error(`[IMPORTER] match ${m.externalId}:`, err.message);
        }
      }
    } catch (err) {
      summary.errors++;
      console.error(`[IMPORTER] liga ${league.name} (${league.id}):`, err.message);
    }
  }

  console.log(`[IMPORTER] Resumen: +${summary.imported} importados, ${summary.skipped} ya existían, ${summary.errors} errores`);
  return summary;
}

// 4. autoResolveMatch — determina ganador desde scores y resuelve apuestas
async function autoResolveMatch(matchId, scoreHome, scoreAway) {
  const result =
    scoreHome > scoreAway ? 'HOME' :
    scoreHome < scoreAway ? 'AWAY' : 'DRAW';
  return resolveMatch(matchId, result, { scoreHome, scoreAway });
}

// 3. updateLiveScores → actualiza scores de partidos LIVE y resuelve los terminados
async function updateLiveScores() {
  let data;
  try {
    data = await fetchJSON(`${API_BASE}/eventslive.php?s=Soccer`);
  } catch (err) {
    // La API a veces falla — no rompemos el cron
    console.error('[IMPORTER] eventslive:', err.message);
    return { updated: 0, resolved: 0 };
  }

  const events = data?.events || [];
  if (!Array.isArray(events) || events.length === 0) {
    return { updated: 0, resolved: 0 };
  }

  let updated = 0, resolved = 0;

  for (const e of events) {
    const externalId = e.idEvent;
    if (!externalId) continue;

    const dbMatch = await prisma.match.findUnique({ where: { externalId } });
    if (!dbMatch) continue;

    const scoreHome = parseInt(e.intHomeScore ?? '0', 10) || 0;
    const scoreAway = parseInt(e.intAwayScore ?? '0', 10) || 0;
    const progress  = (e.strProgress || '').toLowerCase();
    const status    = (e.strStatus   || '').toLowerCase();

    const isFinished =
      progress.includes('ft') || progress.includes('finished') ||
      status.includes('match finished') || status === 'ft' || status === 'finished';

    if (dbMatch.status === 'UPCOMING' || dbMatch.status === 'LIVE') {
      // Marca LIVE si aún no lo está y actualiza marcador
      if (dbMatch.status === 'UPCOMING') {
        await prisma.match.update({
          where: { id: dbMatch.id },
          data:  { status: 'LIVE', scoreHome, scoreAway },
        });
      } else {
        await prisma.match.update({
          where: { id: dbMatch.id },
          data:  { scoreHome, scoreAway },
        });
      }
      updated++;
    }

    if (isFinished && dbMatch.status !== 'FINISHED' && dbMatch.status !== 'CANCELLED') {
      try {
        await autoResolveMatch(dbMatch.id, scoreHome, scoreAway);
        resolved++;
      } catch (err) {
        console.error(`[IMPORTER] auto-resolve ${dbMatch.id}:`, err.message);
      }
    }
  }

  if (updated || resolved) {
    console.log(`[IMPORTER] live: ${updated} actualizados, ${resolved} resueltos automáticamente`);
  }
  return { updated, resolved };
}

module.exports = {
  fetchUpcomingMatches,
  importMatchesToDB,
  updateLiveScores,
  autoResolveMatch,
  LEAGUES,
};
