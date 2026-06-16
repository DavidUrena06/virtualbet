// scripts/generate-vapid.js
// Genera un par de claves VAPID para Web Push.
// Ejecutar UNA SOLA VEZ y guardar las claves en variables de entorno
// (Render → Environment Variables).
//
// Uso:
//   node scripts/generate-vapid.js

const webpush = require('web-push');
const keys = webpush.generateVAPIDKeys();

console.log('\n══════════════════════════════════════════════════════════════');
console.log('VAPID Keys generadas — copialas a tus variables de entorno');
console.log('══════════════════════════════════════════════════════════════\n');
console.log(`VAPID_PUBLIC_KEY="${keys.publicKey}"`);
console.log(`VAPID_PRIVATE_KEY="${keys.privateKey}"`);
console.log(`VAPID_SUBJECT="mailto:admin@virtualbet.com"`);
console.log('\n⚠️  NO commitees estas keys. Guardalas en Render → Environment.\n');
