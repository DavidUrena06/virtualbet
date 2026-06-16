// security/startup.js
// Verificaciones de seguridad que corren al arrancar el servidor.
// Falla rápido en producción si hay configuración insegura.

function validateStartup() {
  const isProd = process.env.NODE_ENV === 'production';
  const errors  = [];
  const warns   = [];

  // JWT_SECRET
  const secret = process.env.JWT_SECRET || '';
  if (!secret) {
    errors.push('JWT_SECRET no está configurado');
  } else if (secret.length < 32) {
    errors.push(`JWT_SECRET demasiado corto (${secret.length} chars, mínimo 32). Generá con: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`);
  } else if (['secret', 'changeme', 'jwt_secret', 'mysecret', 'password'].includes(secret.toLowerCase())) {
    errors.push('JWT_SECRET es un valor genérico inseguro. Generá uno nuevo.');
  }

  // ADMIN_PASSWORD default check
  const adminPwd = process.env.ADMIN_PASSWORD || '';
  if (isProd && adminPwd.toLowerCase().includes('cambiaesto')) {
    errors.push('ADMIN_PASSWORD sigue usando el valor de ejemplo. Cambialo YA.');
  }

  // DATABASE_URL
  if (!process.env.DATABASE_URL) {
    errors.push('DATABASE_URL no está configurado');
  }

  // FRONTEND_URL (CORS)
  if (isProd && !process.env.FRONTEND_URL) {
    warns.push('FRONTEND_URL no está configurado en producción → CORS permitirá solo localhost');
  }

  // VAPID keys (push opcionales)
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    warns.push('VAPID keys no configuradas → push notifications deshabilitadas. Generá con: node scripts/generate-vapid.js');
  }

  // bcrypt: chequea que esté disponible (no podemos verificar rounds usados sin ejecutar)
  try { require('bcryptjs'); } catch { errors.push('bcryptjs no instalado'); }

  // Logging
  for (const w of warns) console.warn(`⚠️  [SECURITY] ${w}`);
  for (const e of errors) console.error(`❌ [SECURITY] ${e}`);

  if (errors.length > 0) {
    if (isProd) {
      console.error('❌ Fallos de seguridad en producción. Abortando.');
      process.exit(1);
    } else {
      console.warn('⚠️  Fallos de seguridad detectados (no aborta en dev)');
    }
  } else {
    console.log('✅ Security startup checks OK');
  }
}

module.exports = { validateStartup };
