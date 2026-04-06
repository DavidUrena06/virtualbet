// frontend/js/api.js — VirtualBet v2
// Moneda: BetCoins (BC)

const API_BASE = 'https://virtualbet.onrender.com/api';
// En local: const API_BASE = 'http://localhost:3000/api';

// ── Auth local ────────────────────────────────────────────────────────────
const Auth = {
  getToken:   ()        => localStorage.getItem('vb_token'),
  getUser:    ()        => JSON.parse(localStorage.getItem('vb_user') || 'null'),
  setSession: (t, u)   => { localStorage.setItem('vb_token', t); localStorage.setItem('vb_user', JSON.stringify(u)); },
  clear:      ()        => { localStorage.removeItem('vb_token'); localStorage.removeItem('vb_user'); },
  isLoggedIn: ()        => !!localStorage.getItem('vb_token'),
  isAdmin:    ()        => Auth.getUser()?.role === 'ADMIN',
};

// ── Fetch base ────────────────────────────────────────────────────────────
async function request(method, endpoint, body = null) {
  const headers = { 'Content-Type': 'application/json' };
  const token = Auth.getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  try {
    const res  = await fetch(`${API_BASE}${endpoint}`, opts);
    const data = await res.json();

    if (res.status === 401) { Auth.clear(); window.location.href = '/pages/login.html'; return; }
    if (!res.ok) throw new Error(data.error || data.errors?.[0]?.msg || 'Error desconocido');

    return data;
  } catch (err) {
    if (err instanceof TypeError) throw new Error('No se pudo conectar con el servidor');
    throw err;
  }
}

const api = {
  get:    (ep)      => request('GET',    ep),
  post:   (ep, b)   => request('POST',   ep, b),
  put:    (ep, b)   => request('PUT',    ep, b),
  patch:  (ep, b)   => request('PATCH',  ep, b),
  delete: (ep)      => request('DELETE', ep),
};

// ── Todos los endpoints organizados ──────────────────────────────────────
const VB = {
  auth: {
    register: (d) => api.post('/auth/register', d),
    login:    (d) => api.post('/auth/login',    d),
    me:       ()  => api.get('/auth/me'),
  },

  wallet: {
    balance:      ()        => api.get('/wallet/balance'),
    transactions: (page=1)  => api.get(`/wallet/transactions?page=${page}`),
  },

  games: {
    dice:          (d) => api.post('/games/dice',          d),
    coinflip:      (d) => api.post('/games/coinflip',      d),
    crashStart:    (d) => api.post('/games/crash/start',   d),
    crashCashout:  (d) => api.post('/games/crash/cashout', d),
    minesStart:    (d) => api.post('/games/mines/start',   d),
    minesReveal:   (d) => api.post('/games/mines/reveal',  d),
    minesCashout:  (d) => api.post('/games/mines/cashout', d),
    plinko:        (d) => api.post('/games/plinko',        d),
    roulette:      (d) => api.post('/games/roulette',      d),
    history:       (page=1, type='') =>
      api.get(`/games/history?page=${page}${type ? '&gameType='+type : ''}`),
  },

  // Sportsbook (apuestas vs la casa)
  sports: {
    matches:    (league='', status='UPCOMING') =>
      api.get(`/sports/matches?league=${league}&status=${status}`),
    match:      (id)  => api.get(`/sports/matches/${id}`),
    placeBet:   (d)   => api.post('/sports/bet', d),
    history:    (p=1) => api.get(`/sports/history?page=${p}`),
  },

  // Sistema de amigos
  friends: {
    search:         (q)    => api.get(`/friends/search?q=${encodeURIComponent(q)}`),
    list:           ()     => api.get('/friends'),
    requests:       ()     => api.get('/friends/requests'),
    sendRequest:    (d)    => api.post('/friends/request',  d),
    respondRequest: (d)    => api.post('/friends/respond',  d),
    remove:         (d)    => api.post('/friends/remove',   d),
  },

  // Apuestas P2P
  p2p: {
    create:  (d)    => api.post('/p2p/create',  d),
    join:    (d)    => api.post('/p2p/join',     d),
    cancel:  (d)    => api.post('/p2p/cancel',   d),
    get:     (id)   => api.get(`/p2p/${id}`),
    myBets:  (s='') => api.get(`/p2p/my?status=${s}`),
  },

  // Perfil
  user: {
    profile: () => api.get('/user/profile'),
  },

  // Notificaciones
  notifications: {
    list:    ()  => api.get('/notifications'),
    readAll: ()  => api.post('/notifications/read-all'),
  },

  // Admin
  admin: {
    users:          (p=1, q='') => api.get(`/admin/users?page=${p}&search=${q}`),
    stats:          ()          => api.get('/admin/stats'),
    logs:           (p=1)       => api.get(`/admin/logs?page=${p}`),
    giveBetCoins:   (d)         => api.post('/admin/coins/give',      d),
    giveBetCoinsAll:(d)         => api.post('/admin/coins/give-all',  d),
    removeBetCoins: (d)         => api.post('/admin/coins/remove',    d),
    banUser:        (d)         => api.post('/admin/ban',             d),
    unbanUser:      (d)         => api.post('/admin/unban',           d),
    createMatch:    (d)         => api.post('/admin/matches',         d),
    resolveMatch:   (d)         => api.post('/admin/matches/resolve', d),
  },
};

// ── Guards ────────────────────────────────────────────────────────────────
function requireLogin()     { if (!Auth.isLoggedIn()) window.location.href = '/pages/login.html'; }
function requireAdminRole() { if (!Auth.isLoggedIn() || !Auth.isAdmin()) window.location.href = '/pages/login.html'; }

// ── Helpers UI ────────────────────────────────────────────────────────────
function showToast(message, type = 'info') {
  const t = document.createElement('div');
  t.className = `vb-toast vb-toast--${type}`;
  t.textContent = message;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('vb-toast--visible'));
  setTimeout(() => {
    t.classList.remove('vb-toast--visible');
    setTimeout(() => t.remove(), 400);
  }, 3000);
}

// Formatea BetCoins con símbolo
function formatBC(amount) {
  return parseFloat(amount).toLocaleString('es-CR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }) + ' BC';
}

function formatDate(d) { return new Date(d).toLocaleString('es-CR'); }

function timeUntil(dateStr) {
  const diff = new Date(dateStr) - new Date();
  if (diff <= 0) return 'Iniciando';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}