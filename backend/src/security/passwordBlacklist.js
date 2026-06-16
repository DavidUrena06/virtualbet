// security/passwordBlacklist.js
// Lista de passwords comunes que prohibimos. Lista corta intencional —
// para una lista completa usar zxcvbn (200KB+) o pwned passwords API.

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'password!', 'p@ssword',
  '12345678', '123456789', '1234567890', '11111111', '00000000',
  'qwerty123', 'qwertyuiop', 'asdfghjkl',
  'letmein', 'letmein123', 'welcome1', 'welcome123', 'admin123', 'administrator',
  'iloveyou', 'monkey123', 'football', 'baseball',
  'superman', 'batman123', 'starwars',
  'virtualbet', 'virtualbet1', 'casino123', 'jugador1',
  'contraseña', 'contrasena', 'contraseña1',
]);

// Returns null if OK, or a string error message
function checkPassword(password, username = '', email = '') {
  if (!password || password.length < 8) {
    return 'La contraseña debe tener al menos 8 caracteres';
  }
  if (password.length > 128) {
    return 'La contraseña es demasiado larga (máx 128 caracteres)';
  }
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) {
    return 'Esta contraseña es muy común. Elegí otra más segura';
  }
  if (username && lower.includes(username.toLowerCase())) {
    return 'La contraseña no puede contener tu nombre de usuario';
  }
  if (email && lower.includes(email.split('@')[0].toLowerCase())) {
    return 'La contraseña no puede contener tu email';
  }
  // 3+ repetidos seguidos
  if (/(.)\1{3,}/.test(password)) {
    return 'La contraseña tiene demasiados caracteres repetidos';
  }
  // Sólo dígitos
  if (/^\d+$/.test(password)) {
    return 'La contraseña no puede ser solo números';
  }
  return null;
}

module.exports = { checkPassword, COMMON_PASSWORDS };
