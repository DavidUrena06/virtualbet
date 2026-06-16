// sports/espn.js
// Integración con la API pública oculta de ESPN para scores en vivo.
// No requiere API key, actualiza marcadores cada ~30s, muy estable.
// Fuente: site.api.espn.com/apis/site/v2/sports/soccer/{league}/scoreboard
//
// Mapeo de nuestras ligas internas → slug de ESPN:

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';

const ESPN_LEAGUE_SLUGS = {
  PREMIER_LEAGUE:   'eng.1',
  LA_LIGA:          'esp.1',
  SERIE_A:          'ita.1',
  CHAMPIONS_LEAGUE: 'uefa.champions',
  MLS:              'usa.1',
  COSTA_RICA_FPD:   'crc.1',
  FIFA_WORLD_CUP:   'fifa.world',
};

async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'VirtualBet/1.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
  return res.json();
}

// Normaliza nombre de equipo para matching cross-API
// "Manchester United FC" ≈ "Man United" → mismas tokens base
function normalizeTeamName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove diacritics
    .replace(/\b(fc|cf|sc|ac|cd|club|football|deportivo|sporting|united|city|de|del|la|el|los|las|real|atletico|athletic)\b/gi, ' ')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

// Calcula similitud simple por prefijo común — suficiente para matching de equipos
function teamMatches(a, b) {
  const na = normalizeTeamName(a);
  const nb = normalizeTeamName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length < 3 || nb.length < 3) return false;
  // Coincidencia si una contiene a la otra (cubre "ManUtd" ⊂ "ManchesterUtd")
  return na.includes(nb) || nb.includes(na);
}

// Devuelve la lista de eventos de la liga con su estado y marcador
async function fetchLeagueScoreboard(internalLeague) {
  const slug = ESPN_LEAGUE_SLUGS[internalLeague];
  if (!slug) return [];

  let data;
  try {
    data = await fetchJSON(`${ESPN_BASE}/${slug}/scoreboard`);
  } catch (err) {
    console.error(`[ESPN] scoreboard ${internalLeague}:`, err.message);
    return [];
  }

  const events = data?.events || [];
  const result = [];

  for (const event of events) {
    const comp = event.competitions?.[0];
    if (!comp) continue;

    const home = comp.competitors?.find(c => c.homeAway === 'home');
    const away = comp.competitors?.find(c => c.homeAway === 'away');
    if (!home || !away) continue;

    const statusType = event.status?.type || {};
    const state = (statusType.state || '').toLowerCase(); // 'pre' | 'in' | 'post'
    const completed = statusType.completed === true;

    result.push({
      espnId:     event.id,
      teamHome:   home.team?.displayName || '',
      teamAway:   away.team?.displayName || '',
      scoreHome:  parseInt(home.score, 10) || 0,
      scoreAway:  parseInt(away.score, 10) || 0,
      startsAt:   event.date ? new Date(event.date) : null,
      isLive:     state === 'in',
      isFinished: state === 'post' || completed,
      statusDetail: statusType.detail || statusType.shortDetail || '',
    });
  }

  return result;
}

// Busca el evento de ESPN que coincide con un Match de la DB.
// Match es por nombre de equipo + ventana de fecha (±2 días para cubrir TZ).
function findMatchingEvent(dbMatch, espnEvents) {
  const dayMs = 24 * 60 * 60 * 1000;
  const startTs = dbMatch.startsAt?.getTime?.() ?? new Date(dbMatch.startsAt).getTime();

  return espnEvents.find(e => {
    if (!teamMatches(e.teamHome, dbMatch.teamHome)) return false;
    if (!teamMatches(e.teamAway, dbMatch.teamAway)) return false;
    if (e.startsAt && Math.abs(e.startsAt.getTime() - startTs) > 2 * dayMs) return false;
    return true;
  });
}

module.exports = {
  ESPN_LEAGUE_SLUGS,
  fetchLeagueScoreboard,
  findMatchingEvent,
  normalizeTeamName,
  teamMatches,
};
