// sports/importer.js
// Importa partidos y mantiene scores en vivo + auto-resolución de apuestas.
//
// FUENTES DE DATOS:
//   - Listado de próximos partidos: TheSportsDB eventsnextleague.php (free tier)
//   - Scores en vivo: ESPN scoreboard (free, sin key, ~30s refresh) — PRIMARIO
//   - Fallback de scores: TheSportsDB lookupevent.php (free tier)
//   - Cuotas: calculadas dinámicamente por forma reciente (oddsCalculator.js)
//
// AUTO-RESOLUCIÓN DE PARTIDOS:
//   Paso 1 — ESPN scoreboard por liga (actualiza marcadores y resuelve si state=post)
//   Paso 2 — lookupevent.php por partido (solo si ESPN no devolvió match)
//   Paso 3 — Fallback por tiempo: >150 min en LIVE/UPCOMING → resolver con marcador actual

const { PrismaClient } = require('@prisma/client');
const { resolveMatch } = require('./resolver');
const { fetchLeagueScoreboard, findMatchingEvent, ESPN_LEAGUE_SLUGS } = require('./espn');
const { computeMatchOdds, DEFAULT_ODDS } = require('./oddsCalculator');
const prisma = new PrismaClient();

const API_BASE = process.env.SPORTS_API_BASE || 'https://www.thesportsdb.com/api/v1/json/3';
const MATCH_MAX_DURATION_MS = 150 * 60 * 1000; // 150 min = 90 juego + 60 buffer

const LEAGUES = [
  { id: '4328', name: 'PREMIER_LEAGUE',   display: 'Premier League' },
  { id: '4335', name: 'LA_LIGA',          display: 'La Liga' },
  { id: '4332', name: 'SERIE_A',          display: 'Serie A' },
  { id: '4480', name: 'CHAMPIONS_LEAGUE', display: 'UEFA Champions League' },
  { id: '4346', name: 'MLS',              display: 'MLS' },
  { id: '4815', name: 'COSTA_RICA_FPD',   display: 'Costa Rica · Liga FPD' },
  { id: '4429', name: 'FIFA_WORLD_CUP',   display: 'FIFA World Cup' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'VirtualBet/1.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
  return res.json();
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function parseStartsAt(event) {
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

function parseLookupEventStatus(e) {
  const scoreHome = parseInt(e.intHomeScore ?? '', 10);
  const scoreAway = parseInt(e.intAwayScore ?? '', 10);
  const progress  = (e.strProgress || '').trim().toLowerCase();
  const status    = (e.strStatus   || '').trim().toLowerCase();

  const isFinished =
    progress === 'ft' || progress.includes('finished') ||
    status === 'ft' || status === 'match finished' || status.includes('finished') ||
    status === 'aet' || status === 'pen';

  return {
    scoreHome: isNaN(scoreHome) ? null : scoreHome,
    scoreAway: isNaN(scoreAway) ? null : scoreAway,
    isFinished,
  };
}

async function lookupEvent(externalId) {
  try {
    const data = await fetchJSON(`${API_BASE}/lookupevent.php?id=${externalId}`);
    const e = data?.events?.[0];
    if (!e) return null;
    return parseLookupEventStatus(e);
  } catch (err) {
    console.error(`[IMPORTER] lookupevent ${externalId}:`, err.message);
    return null;
  }
}

// ─── Importación de partidos ─────────────────────────────────────────────────

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

async function importMatchesToDB() {
  const summary = { imported: 0, skipped: 0, errors: 0, oddsComputed: 0, oddsDefault: 0, perLeague: {} };

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

          // Calcula odds dinámicas para este partido
          const odds = await computeMatchOdds(m.teamHome.trim(), m.teamAway.trim());
          if (odds.source === 'computed') summary.oddsComputed++;
          else                            summary.oddsDefault++;

          await prisma.match.create({
            data: {
              externalId: m.externalId,
              league:     league.name,
              leagueName: league.display,
              teamHome:   m.teamHome.trim(),
              teamAway:   m.teamAway.trim(),
              oddHome:    odds.home,
              oddDraw:    odds.draw,
              oddAway:    odds.away,
              startsAt:   m.startsAt,
              status:     'UPCOMING',
            },
          });
          summary.imported++;
          summary.perLeague[league.name].imported++;

          await sleep(100); // throttle suave para no martillar APIs
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

  console.log(`[IMPORTER] Resumen: +${summary.imported} importados (${summary.oddsComputed} odds calculadas, ${summary.oddsDefault} default), ${summary.skipped} ya existían, ${summary.errors} errores`);
  return summary;
}

// ─── Recálculo periódico de odds para partidos UPCOMING ──────────────────────
// Las odds cambian con el tiempo (lesiones, forma, noticias). Recalculamos
// cada 6h para partidos que aún no empezaron, ignorando partidos a <2h de inicio
// para no desconcertar a usuarios que ya pusieron una apuesta.
async function recomputeUpcomingOdds() {
  const now = new Date();
  const minCutoff = new Date(now.getTime() + 2 * 60 * 60 * 1000); // 2h de antelación

  const matches = await prisma.match.findMany({
    where: {
      status:   'UPCOMING',
      startsAt: { gte: minCutoff },
    },
    select: { id: true, teamHome: true, teamAway: true },
    take: 100,
  });

  let updated = 0;
  for (const m of matches) {
    const odds = await computeMatchOdds(m.teamHome, m.teamAway);
    if (odds.source !== 'computed') continue;

    await prisma.match.update({
      where: { id: m.id },
      data: {
        oddHome: odds.home,
        oddDraw: odds.draw,
        oddAway: odds.away,
      },
    });
    updated++;
    await sleep(100);
  }

  if (updated > 0) console.log(`[IMPORTER] Recalculadas odds de ${updated} partidos UPCOMING`);
  return { updated };
}

// ─── Auto-resolución ─────────────────────────────────────────────────────────

async function autoResolveMatch(matchId, scoreHome, scoreAway) {
  const result =
    scoreHome > scoreAway ? 'HOME' :
    scoreHome < scoreAway ? 'AWAY' : 'DRAW';
  return resolveMatch(matchId, result, { scoreHome, scoreAway });
}

// ─── Actualización de scores en vivo ─────────────────────────────────────────

async function updateLiveScores() {
  let updated = 0, resolved = 0;
  const now = new Date();
  const handledIds = new Set(); // Match.id ya procesados por ESPN

  // ── Paso 1: ESPN scoreboard por liga (primario, más confiable) ──
  for (const internalLeague of Object.keys(ESPN_LEAGUE_SLUGS)) {
    const espnEvents = await fetchLeagueScoreboard(internalLeague);
    if (espnEvents.length === 0) continue;

    // Trae partidos activos de esta liga
    const dbMatches = await prisma.match.findMany({
      where: {
        league: internalLeague,
        status: { in: ['LIVE', 'UPCOMING'] },
      },
    });

    for (const dbMatch of dbMatches) {
      const espnEv = findMatchingEvent(dbMatch, espnEvents);
      if (!espnEv) continue;

      handledIds.add(dbMatch.id);

      const sh = espnEv.scoreHome;
      const sa = espnEv.scoreAway;
      const shouldBeLive = espnEv.isLive || espnEv.isFinished;

      if (shouldBeLive || dbMatch.scoreHome !== sh || dbMatch.scoreAway !== sa) {
        await prisma.match.update({
          where: { id: dbMatch.id },
          data: {
            status:    espnEv.isFinished ? dbMatch.status : (shouldBeLive ? 'LIVE' : dbMatch.status),
            scoreHome: sh,
            scoreAway: sa,
          },
        });
        updated++;
      }

      if (espnEv.isFinished && dbMatch.status !== 'FINISHED' && dbMatch.status !== 'CANCELLED') {
        try {
          await autoResolveMatch(dbMatch.id, sh, sa);
          resolved++;
        } catch (err) {
          console.error(`[IMPORTER] ESPN auto-resolve ${dbMatch.id}:`, err.message);
        }
      }
    }

    await sleep(200);
  }

  // ── Paso 2: lookupevent.php para partidos NO cubiertos por ESPN ──
  const remainingActive = await prisma.match.findMany({
    where: {
      id:         { notIn: Array.from(handledIds) },
      status:     { in: ['LIVE', 'UPCOMING'] },
      externalId: { not: null },
      startsAt:   { lte: now },
    },
  });

  for (const match of remainingActive) {
    await sleep(200);
    const info = await lookupEvent(match.externalId);
    if (!info) continue;

    const sh = info.scoreHome ?? match.scoreHome ?? 0;
    const sa = info.scoreAway ?? match.scoreAway ?? 0;

    if (info.scoreHome !== null || match.status === 'UPCOMING') {
      await prisma.match.update({
        where: { id: match.id },
        data:  { status: 'LIVE', scoreHome: sh, scoreAway: sa },
      });
      updated++;
    }

    if (info.isFinished) {
      try {
        await autoResolveMatch(match.id, sh, sa);
        resolved++;
      } catch (err) {
        console.error(`[IMPORTER] lookup auto-resolve ${match.id}:`, err.message);
      }
    }
  }

  // ── Paso 3: fallback por tiempo (cubre partidos manuales o APIs caídas) ──
  const cutoffTime = new Date(now.getTime() - MATCH_MAX_DURATION_MS);
  const stuckMatches = await prisma.match.findMany({
    where: {
      status:   { in: ['LIVE', 'UPCOMING'] },
      startsAt: { lte: cutoffTime },
    },
  });

  for (const match of stuckMatches) {
    const sh = match.scoreHome ?? 0;
    const sa = match.scoreAway ?? 0;
    console.log(`[IMPORTER] Fallback tiempo: ${match.teamHome} vs ${match.teamAway} (${sh}-${sa})`);
    try {
      await autoResolveMatch(match.id, sh, sa);
      resolved++;
    } catch (err) {
      console.error(`[IMPORTER] force-resolve ${match.id}:`, err.message);
    }
  }

  if (updated || resolved) {
    console.log(`[IMPORTER] live: ${updated} actualizados, ${resolved} resueltos`);
  }
  return { updated, resolved };
}

// ─── Limpieza de partidos viejos ─────────────────────────────────────────────
async function cleanupOldMatches(days = 7) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const oldMatches = await prisma.match.findMany({
    where: {
      status:     'FINISHED',
      resolvedAt: { lte: cutoff },
    },
    select: { id: true, teamHome: true, teamAway: true },
  });

  let deleted = 0;
  for (const match of oldMatches) {
    try {
      const pending = await prisma.sportBet.count({
        where: { matchId: match.id, status: 'PENDING' },
      });
      if (pending > 0) continue;

      await prisma.$transaction(async (tx) => {
        const pbets = await tx.privateBet.findMany({
          where:  { matchId: match.id },
          select: { id: true },
        });
        for (const pb of pbets) {
          await tx.privateBetParticipant.deleteMany({ where: { privateBetId: pb.id } });
        }
        await tx.privateBet.deleteMany({ where: { matchId: match.id } });
        await tx.sportBet.deleteMany({ where: { matchId: match.id } });
        await tx.match.delete({ where: { id: match.id } });
      });

      deleted++;
      console.log(`[IMPORTER] Eliminado (${days}d): ${match.teamHome} vs ${match.teamAway}`);
    } catch (err) {
      console.error(`[IMPORTER] cleanup ${match.id}:`, err.message);
    }
  }

  return { deleted };
}

module.exports = {
  fetchUpcomingMatches,
  importMatchesToDB,
  updateLiveScores,
  recomputeUpcomingOdds,
  autoResolveMatch,
  cleanupOldMatches,
  LEAGUES,
};
