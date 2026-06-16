// security/loginAttempts.js
// Tracking de intentos fallidos de login con bloqueo temporal.
// In-memory: en cluster cada instance tiene su propio store. Para nuestro caso
// (Render free tier = 1 instancia) es suficiente. Si escalamos, migrar a Redis.
//
// Política:
//   - 5 intentos fallidos por email → 15 min de lockout
//   - 10 intentos fallidos por IP    → 30 min de lockout
//   - Login exitoso resetea ambos contadores

const MAX_PER_EMAIL    = 5;
const MAX_PER_IP       = 10;
const EMAIL_LOCKOUT_MS = 15 * 60 * 1000;
const IP_LOCKOUT_MS    = 30 * 60 * 1000;
const WINDOW_MS        = 15 * 60 * 1000;

const emailAttempts = new Map(); // email → { count, firstAt, lockedUntil }
const ipAttempts    = new Map(); // ip    → { count, firstAt, lockedUntil }

function nowMs() { return Date.now(); }

function getRecord(map, key) {
  const r = map.get(key);
  if (!r) return null;
  // Reset si pasó la ventana sin estar bloqueado
  if (!r.lockedUntil && nowMs() - r.firstAt > WINDOW_MS) {
    map.delete(key);
    return null;
  }
  return r;
}

// Devuelve { blocked: boolean, retryAfterMs: number, reason: string }
function check(email, ip) {
  const now = nowMs();
  const e   = email ? getRecord(emailAttempts, email.toLowerCase()) : null;
  const i   = ip    ? getRecord(ipAttempts, ip) : null;

  if (e?.lockedUntil && e.lockedUntil > now) {
    return { blocked: true, retryAfterMs: e.lockedUntil - now, reason: 'email' };
  }
  if (i?.lockedUntil && i.lockedUntil > now) {
    return { blocked: true, retryAfterMs: i.lockedUntil - now, reason: 'ip' };
  }
  return { blocked: false };
}

function recordFailure(email, ip) {
  const now = nowMs();

  if (email) {
    const key = email.toLowerCase();
    const r   = emailAttempts.get(key);
    if (!r || now - r.firstAt > WINDOW_MS) {
      emailAttempts.set(key, { count: 1, firstAt: now, lockedUntil: null });
    } else {
      r.count++;
      if (r.count >= MAX_PER_EMAIL) {
        r.lockedUntil = now + EMAIL_LOCKOUT_MS;
        console.warn(`[SECURITY] Email lockout: ${key} hasta ${new Date(r.lockedUntil).toISOString()}`);
      }
    }
  }

  if (ip) {
    const r = ipAttempts.get(ip);
    if (!r || now - r.firstAt > WINDOW_MS) {
      ipAttempts.set(ip, { count: 1, firstAt: now, lockedUntil: null });
    } else {
      r.count++;
      if (r.count >= MAX_PER_IP) {
        r.lockedUntil = now + IP_LOCKOUT_MS;
        console.warn(`[SECURITY] IP lockout: ${ip} hasta ${new Date(r.lockedUntil).toISOString()}`);
      }
    }
  }

  // GC del Map: si crece mucho, limpiar entradas viejas
  if (emailAttempts.size > 5000) {
    for (const [k, v] of emailAttempts) {
      if (v.lockedUntil && v.lockedUntil < now) emailAttempts.delete(k);
      else if (!v.lockedUntil && now - v.firstAt > WINDOW_MS) emailAttempts.delete(k);
    }
  }
  if (ipAttempts.size > 5000) {
    for (const [k, v] of ipAttempts) {
      if (v.lockedUntil && v.lockedUntil < now) ipAttempts.delete(k);
      else if (!v.lockedUntil && now - v.firstAt > WINDOW_MS) ipAttempts.delete(k);
    }
  }
}

function recordSuccess(email, ip) {
  if (email) emailAttempts.delete(email.toLowerCase());
  if (ip)    ipAttempts.delete(ip);
}

module.exports = { check, recordFailure, recordSuccess };
