// frontend/js/api.js
// Cliente HTTP del frontend — maneja JWT, errores y base URL automáticamente
// Importar este archivo en todas las páginas antes de usar fetch

const API_BASE = 'https://virtualbet.onrender.com/api';
// En desarrollo local: const API_BASE = 'http://localhost:3000/api';

// ─── Manejo de sesión local ───────────────────────────────────────────────────
const Auth = {
  getToken:  ()      => localStorage.getItem('vb_token'),
  getUser:   ()      => JSON.parse(localStorage.getItem('vb_user') || 'null'),
  setSession: (token, user) => {
    localStorage.setItem('vb_token', token);
    localStorage.setItem('vb_user', JSON.stringify(user));
  },
  clear: () => {
    localStorage.removeItem('vb_token');
    localStorage.removeItem('vb_user');
  },
  isLoggedIn: ()     => !!localStorage.getItem('vb_token'),
  isAdmin:    ()     => Auth.getUser()?.role === 'ADMIN',
};

// ─── Request helper base ──────────────────────────────────────────────────────
async function request(method, endpoint, body = null) {
  const headers = { 'Content-Type': 'application/json' };

  const token = Auth.getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);

  try {
    const res = await fetch(`${API_BASE}${endpoint}`, options);
    const data = await res.json();

    // Sesión expirada → redirige al login
    if (res.status === 401) {
      Auth.clear();
      window.location.href = '/pages/login.html';
      return;
    }

    if (!res.ok) {
      throw new Error(data.error || data.errors?.[0]?.msg || 'Error desconocido');
    }

    return data;
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error('No se pudo conectar con el servidor. Verificá tu conexión.');
    }
    throw err;
  }
}

const api = {
  get:    (endpoint)       => request('GET',    endpoint),
  post:   (endpoint, body) => request('POST',   endpoint, body),
  put:    (endpoint, body) => request('PUT',    endpoint, body),
  patch:  (endpoint, body) => request('PATCH',  endpoint, body),
  delete: (endpoint)       => request('DELETE', endpoint),
};

// ─── Endpoints organizados ────────────────────────────────────────────────────
const VB = {
  // Auth
  auth: {
    register: (data)  => api.post('/auth/register', data),
    login:    (data)  => api.post('/auth/login',    data),
    me:       ()      => api.get('/auth/me'),
  },

  // Wallet
  wallet: {
    balance:      ()       => api.get('/wallet/balance'),
    transactions: (page=1) => api.get(`/wallet/transactions?page=${page}`),
  },

  // Juegos
  games: {
    dice:          (data)   => api.post('/games/dice',          data),
    coinflip:      (data)   => api.post('/games/coinflip',      data),
    crashStart:    (data)   => api.post('/games/crash/start',   data),
    crashCashout:  (data)   => api.post('/games/crash/cashout', data),
    history:       (page=1) => api.get(`/games/history?page=${page}`),
  },

  // Apuestas deportivas
  betting: {
    matches:    (league='', status='') =>
      api.get(`/betting/matches?league=${league}&status=${status}`),
    placeBet:   (data)   => api.post('/betting/place',   data),
    history:    (page=1) => api.get(`/betting/history?page=${page}`),
  },

  // Perfil
  user: {
    profile: () => api.get('/user/profile'),
  },

  // Admin (solo rol ADMIN)
  admin: {
    users:        (page=1, search='') =>
      api.get(`/admin/users?page=${page}&search=${search}`),
    stats:        ()       => api.get('/admin/stats'),
    logs:         (page=1) => api.get(`/admin/logs?page=${page}`),
    giveCoins:    (data)   => api.post('/admin/coins/give',      data),
    giveCoinsAll: (data)   => api.post('/admin/coins/give-all',  data),
    removeCoins:  (data)   => api.post('/admin/coins/remove',    data),
    banUser:      (data)   => api.post('/admin/ban',             data),
    unbanUser:    (data)   => api.post('/admin/unban',           data),
    createMatch:  (data)   => api.post('/admin/matches',         data),
    resolveMatch: (data)   => api.post('/admin/matches/resolve', data),
  },
};

// ─── Guard de rutas: redirige si no está logueado ────────────────────────────
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

// ─── Helpers UI ───────────────────────────────────────────────────────────────
function showToast(message, type = 'info') {
  // type: 'success' | 'error' | 'info'
  const toast = document.createElement('div');
  toast.className = `vb-toast vb-toast--${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  // Animación
  requestAnimationFrame(() => toast.classList.add('vb-toast--visible'));

  setTimeout(() => {
    toast.classList.remove('vb-toast--visible');
    setTimeout(() => toast.remove(), 400);
  }, 3000);
}

function formatCoins(amount) {
  return parseFloat(amount).toLocaleString('es-CR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }) + ' 🪙';
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleString('es-CR');
}
