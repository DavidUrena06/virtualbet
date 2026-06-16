// sports/oddsCalculator.js
// Calcula cuotas (odds) dinámicas para un partido basadas en la forma reciente
// de cada equipo (últimos 5 partidos vía TheSportsDB).
//
// Modelo:
//   1. Forma de cada equipo = puntos ponderados de últimos 5 partidos (más recientes pesan más)
//      → score normalizado en [0, 1]
//   2. Fuerza local = formHome + HOME_ADVANTAGE
//      Fuerza visita = formAway
//   3. Probabilidad de empate baja cuando los equipos son disparejos
//   4. Probabilidad restante se reparte por diferencia de fuerza
//   5. Se aplica overround (HOUSE_EDGE) y se convierte a cuotas decimales

const API_BASE = process.env.SPORTS_API_BASE || 'https://www.thesportsdb.com/api/v1/json/3';
const HOUSE_EDGE = parseFloat(process.env.HOUSE_EDGE || '0.05');

const HOME_ADVANTAGE = 0.12;       // boost de fuerza para el local
const MIN_ODDS       = 1.10;       // piso de cuota (evita cuotas insanas)
const MAX_ODDS       = 15.00;      // techo de cuota
const FORM_LAST_N    = 5;          // últimos N partidos a considerar

// Odds default cuando no hay datos suficientes (cold start)
const DEFAULT_ODDS = { home: 2.10, draw: 3.30, away: 3.20 };

// Cache de team IDs (nombre → idTeam de TheSportsDB) para no resolver cada vez
const teamIdCache = new Map();

async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'VirtualBet/1.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
  return res.json();
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Resuelve el ID interno de un equipo en TheSportsDB
async function getTeamId(teamName) {
  if (!teamName) return null;
  const cached = teamIdCache.get(teamName);
  if (cached !== undefined) return cached;

  try {
    const data = await fetchJSON(`${API_BASE}/searchteams.php?t=${encodeURIComponent(teamName)}`);
    const teams = data?.teams || [];
    // Preferir equipos de fútbol soccer
    const soccer = teams.find(t => (t.strSport || '').toLowerCase() === 'soccer') || teams[0];
    const id = soccer?.idTeam || null;
    teamIdCache.set(teamName, id);
    return id;
  } catch (err) {
    console.error(`[ODDS] getTeamId ${teamName}:`, err.message);
    teamIdCache.set(teamName, null);
    return null;
  }
}

// Trae los últimos N partidos jugados por el equipo
async function getTeamLastResults(teamId) {
  if (!teamId) return [];
  try {
    const data = await fetchJSON(`${API_BASE}/eventslast.php?id=${teamId}`);
    return data?.results || [];
  } catch (err) {
    console.error(`[ODDS] eventslast ${teamId}:`, err.message);
    return [];
  }
}

// Convierte últimos partidos en un score de forma [0..1]
// 3 pts ganar, 1 pt empatar, 0 pts perder. Ponderado: más reciente pesa más.
function computeFormScore(teamName, lastEvents) {
  const events = (lastEvents || []).slice(0, FORM_LAST_N);
  if (events.length === 0) return null; // sin datos

  const nameLc = teamName.toLowerCase();
  let total = 0;
  let maxPossible = 0;

  events.forEach((e, i) => {
    const weight = FORM_LAST_N - i; // 5, 4, 3, 2, 1
    const isHome = (e.strHomeTeam || '').toLowerCase() === nameLc;
    const sh = parseInt(e.intHomeScore ?? '', 10);
    const sa = parseInt(e.intAwayScore ?? '', 10);

    if (isNaN(sh) || isNaN(sa)) {
      // Partido sin marcador, ignorar
      return;
    }

    let points = 0;
    if (sh === sa)                                  points = 1;
    else if (isHome  && sh > sa)                    points = 3;
    else if (!isHome && sa > sh)                    points = 3;

    total       += points * weight;
    maxPossible += 3      * weight;
  });

  if (maxPossible === 0) return null;
  return total / maxPossible; // 0..1
}

// Convierte probabilidades a cuotas decimales con overround (house edge)
function probsToOdds(pHome, pDraw, pAway) {
  // Normaliza a suma=1
  const sum = pHome + pDraw + pAway;
  pHome /= sum; pDraw /= sum; pAway /= sum;

  // Aplica overround: sum(1/odds) = 1 + houseEdge
  const factor = 1 + HOUSE_EDGE;
  const clamp = (o) => Math.min(MAX_ODDS, Math.max(MIN_ODDS, o));

  return {
    home: +clamp(1 / (pHome * factor)).toFixed(2),
    draw: +clamp(1 / (pDraw * factor)).toFixed(2),
    away: +clamp(1 / (pAway * factor)).toFixed(2),
  };
}

// Convierte forma → probabilidades (modelo heurístico simple)
function formsToProbs(homeForm, awayForm) {
  const sHome = homeForm + HOME_ADVANTAGE;
  const sAway = awayForm;
  const diff  = sHome - sAway; // típicamente -1 a +1.12

  // Probabilidad de empate: máxima cuando equipos son parejos, baja con desbalance
  const pDrawRaw     = 0.28 - Math.abs(diff) * 0.18;
  const pDraw        = Math.max(0.16, Math.min(0.32, pDrawRaw));

  // Reparte el resto según diff
  const remaining    = 1 - pDraw;
  const homeShareRaw = 0.5 + diff * 0.55;
  const homeShare    = Math.max(0.15, Math.min(0.85, homeShareRaw));

  return {
    pHome: remaining * homeShare,
    pDraw,
    pAway: remaining * (1 - homeShare),
  };
}

// Función principal: calcula odds para un partido dado los nombres de equipos
// Devuelve { home, draw, away, source: 'computed' | 'default' }
async function computeMatchOdds(teamHome, teamAway) {
  try {
    const [homeId, awayId] = await Promise.all([
      getTeamId(teamHome),
      getTeamId(teamAway),
    ]);

    if (!homeId || !awayId) {
      return { ...DEFAULT_ODDS, source: 'default' };
    }

    await sleep(150); // throttle

    const [homeLast, awayLast] = await Promise.all([
      getTeamLastResults(homeId),
      getTeamLastResults(awayId),
    ]);

    const homeForm = computeFormScore(teamHome, homeLast);
    const awayForm = computeFormScore(teamAway, awayLast);

    if (homeForm === null || awayForm === null) {
      return { ...DEFAULT_ODDS, source: 'default' };
    }

    const { pHome, pDraw, pAway } = formsToProbs(homeForm, awayForm);
    const odds = probsToOdds(pHome, pDraw, pAway);
    return { ...odds, source: 'computed', homeForm, awayForm };
  } catch (err) {
    console.error(`[ODDS] computeMatchOdds ${teamHome} vs ${teamAway}:`, err.message);
    return { ...DEFAULT_ODDS, source: 'default' };
  }
}

module.exports = {
  computeMatchOdds,
  computeFormScore,
  formsToProbs,
  probsToOdds,
  DEFAULT_ODDS,
  HOUSE_EDGE,
};
