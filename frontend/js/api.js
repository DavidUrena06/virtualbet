// frontend/js/api.js — VirtualBet v4 (corregido)
// Moneda: BetCoins (BC)

// ── IMPORTANTE: cambiá esta URL por la de tu servidor en Render ───────────
const API_BASE = 'https://virtualbet.onrender.com/api';
// Local: const API_BASE = 'http://localhost:3000/api';

// ── Auth ──────────────────────────────────────────────────────────────────
const Auth = {
  getToken:    ()       => localStorage.getItem('vb_token'),
  getUser:     ()       => { try { return JSON.parse(localStorage.getItem('vb_user') || 'null'); } catch { return null; } },
  setSession:  (t, u)   => { localStorage.setItem('vb_token', t); localStorage.setItem('vb_user', JSON.stringify(u)); },
  clear:       ()        => { localStorage.removeItem('vb_token'); localStorage.removeItem('vb_user'); },
  isLoggedIn:  ()        => !!localStorage.getItem('vb_token'),
  isAdmin:     ()        => Auth.getUser()?.role === 'ADMIN',
};

// ── Fetch con JWT automático ──────────────────────────────────────────────
async function request(method, endpoint, body = null) {
  const headers = { 'Content-Type': 'application/json' };
  const token = Auth.getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  try {
    const res  = await fetch(`${API_BASE}${endpoint}`, opts);
    const data = await res.json();

    if (res.status === 401) {
      Auth.clear();
      // Solo redirige si no estamos ya en login
      if (!window.location.pathname.includes('login')) {
        window.location.href = '/pages/login.html';
      }
      return null;
    }

    if (!res.ok) {
      const msg = data.error || data.errors?.[0]?.msg || `Error ${res.status}`;
      throw new Error(msg);
    }

    return data;
  } catch (err) {
    if (err instanceof TypeError && err.message.includes('fetch')) {
      throw new Error('No se pudo conectar con el servidor. Verificá tu conexión.');
    }
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

// ── Endpoints ─────────────────────────────────────────────────────────────
const VB = {
  auth: {
    register: (d) => api.post('/auth/register', d),
    login:    (d) => api.post('/auth/login',    d),
    me:       ()  => api.get('/auth/me'),
  },

  wallet: {
    balance:      ()       => api.get('/wallet/balance'),
    transactions: (page=1) => api.get(`/wallet/transactions?page=${page}`),
  },

  games: {
    dice:         (d) => api.post('/games/dice',          d),
    coinflip:     (d) => api.post('/games/coinflip',      d),
    crashStart:   (d) => api.post('/games/crash/start',   d),
    crashCashout: (d) => api.post('/games/crash/cashout', d),
    minesStart:   (d) => api.post('/games/mines/start',   d),
    minesReveal:  (d) => api.post('/games/mines/reveal',  d),
    minesCashout: (d) => api.post('/games/mines/cashout', d),
    plinko:       (d) => api.post('/games/plinko',        d),
    roulette:     (d) => api.post('/games/roulette',      d),
    history:      (page=1, type='') =>
      api.get(`/games/history?page=${page}${type ? '&gameType=' + type : ''}`),
  },

  // Sportsbook — ruta: /api/sports/*
  sports: {
    matches:  (league='', status='UPCOMING') =>
      api.get(`/sports/matches?league=${encodeURIComponent(league)}&status=${encodeURIComponent(status)}`),
    match:    (id)   => api.get(`/sports/matches/${id}`),
    placeBet: (d)    => api.post('/sports/bet', d),
    history:  (p=1)  => api.get(`/sports/history?page=${p}`),
  },

  // Amigos — ruta: /api/friends/*
  friends: {
    search:         (q) => api.get(`/friends/search?q=${encodeURIComponent(q)}`),
    list:           ()  => api.get('/friends'),
    requests:       ()  => api.get('/friends/requests'),
    sendRequest:    (d) => api.post('/friends/request',  d),
    respondRequest: (d) => api.post('/friends/respond',  d),
    remove:         (d) => api.post('/friends/remove',   d),
  },

  // P2P — ruta: /api/p2p/*
  p2p: {
    create:  (d)   => api.post('/p2p/create',  d),
    join:    (d)   => api.post('/p2p/join',    d),
    cancel:  (d)   => api.post('/p2p/cancel',  d),
    get:     (id)  => api.get(`/p2p/${id}`),
    myBets:  (s='')=> api.get(`/p2p/my?status=${s}`),
  },

  // Perfil — ruta: /api/user/*
  user: {
    profile: () => api.get('/user/profile'),
    stats:   () => api.get('/user/stats'),
  },

  // Notificaciones — ruta: /api/notifications/*
  notifications: {
    list:    () => api.get('/notifications'),
    readAll: () => api.post('/notifications/read-all'),
  },

  // Admin — ruta: /api/admin/*
  admin: {
    users:           (p=1, q='') => api.get(`/admin/users?page=${p}&search=${encodeURIComponent(q)}`),
    stats:           ()          => api.get('/admin/stats'),
    logs:            (p=1)       => api.get(`/admin/logs?page=${p}`),
    giveBetCoins:    (d)         => api.post('/admin/coins/give',      d),
    giveBetCoinsAll: (d)         => api.post('/admin/coins/give-all',  d),
    removeBetCoins:  (d)         => api.post('/admin/coins/remove',    d),
    banUser:         (d)         => api.post('/admin/ban',             d),
    unbanUser:       (d)         => api.post('/admin/unban',           d),
    createMatch:     (d)         => api.post('/admin/matches',         d),
    resolveMatch:    (d)         => api.post('/admin/matches/resolve', d),
  },
};

// ── Guards de rutas ───────────────────────────────────────────────────────
function requireLogin() {
  if (!Auth.isLoggedIn()) {
    window.location.href = '/pages/login.html';
  }
}

function requireAdminRole() {
  if (!Auth.isLoggedIn() || !Auth.isAdmin()) {
    window.location.href = '/pages/login.html';
  }
}

// ── UI helpers ────────────────────────────────────────────────────────────
function showToast(message, type = 'info') {
  // Elimina toasts anteriores del mismo tipo
  document.querySelectorAll(`.vb-toast--${type}`).forEach(t => t.remove());

  const toast = document.createElement('div');
  toast.className = `vb-toast vb-toast--${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('vb-toast--visible'));
  setTimeout(() => {
    toast.classList.remove('vb-toast--visible');
    setTimeout(() => toast.remove(), 400);
  }, 3500);
}

function formatBC(amount) {
  return parseFloat(amount || 0).toLocaleString('es-CR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }) + ' BC';
}

function formatDate(d) {
  return new Date(d).toLocaleString('es-CR');
}

function timeUntil(dateStr) {
  const diff = new Date(dateStr) - new Date();
  if (diff <= 0) return 'Iniciando';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return h > 24
    ? Math.floor(h / 24) + 'd ' + (h % 24) + 'h'
    : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ── Navbar dinámica — se llama desde cada página ──────────────────────────
async function initNavbar(activeSection = '') {
  // Actualiza balance en navbar
  try {
    const data = await VB.wallet.balance();
    const bal  = parseFloat(data.wallet.balance) - parseFloat(data.wallet.lockedBalance || 0);
    const el   = document.getElementById('navBalance');
    if (el) el.textContent = bal.toLocaleString('es-CR', { minimumFractionDigits: 2 });
  } catch { /* silencioso */ }

  // Notificaciones badge
  try {
    const data = await VB.notifications.list();
    const badge = document.getElementById('notifBadge');
    if (badge && data.unread > 0) {
      badge.textContent = data.unread;
      badge.style.display = 'inline-flex';
    }
  } catch { /* silencioso */ }
}
