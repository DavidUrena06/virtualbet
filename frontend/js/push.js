// frontend/js/push.js
// Cliente Web Push: registra service worker, suscribe al usuario, manda al backend.
//
// Uso:
//   PushClient.enable()  — pide permiso + suscribe
//   PushClient.disable() — desuscribe
//   PushClient.status()  — devuelve 'granted' | 'denied' | 'default' | 'unsupported'

const PushClient = (() => {
  const SW_PATH = '/sw.js';

  function isSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  function status() {
    if (!isSupported()) return 'unsupported';
    return Notification.permission;
  }

  function urlBase64ToUint8Array(base64) {
    const padding = '='.repeat((4 - base64.length % 4) % 4);
    const b64     = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw     = atob(b64);
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  }

  async function registerSW() {
    return navigator.serviceWorker.register(SW_PATH);
  }

  async function enable() {
    if (!isSupported()) {
      throw new Error('Tu navegador no soporta notificaciones push');
    }

    // Pide permiso
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      throw new Error('Permiso de notificaciones denegado');
    }

    // Trae la public key del server
    const { publicKey } = await VB.push.publicKey();

    const reg = await registerSW();
    await navigator.serviceWorker.ready;

    // Si ya hay una suscripción, reutilizamos; si no, creamos
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }

    // Manda al backend
    const json = sub.toJSON();
    await VB.push.subscribe({
      endpoint:  json.endpoint,
      keys:      { p256dh: json.keys.p256dh, auth: json.keys.auth },
      userAgent: navigator.userAgent,
    });

    return true;
  }

  async function disable() {
    if (!isSupported()) return false;
    const reg = await navigator.serviceWorker.getRegistration(SW_PATH);
    if (!reg) return false;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await VB.push.unsubscribe({ endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
    }
    return true;
  }

  async function test() {
    return VB.push.test();
  }

  // Llamar al cargar páginas — registra SW silenciosamente si ya tiene permiso
  async function autoRegister() {
    if (!isSupported() || Notification.permission !== 'granted') return;
    try { await registerSW(); } catch { /* silent */ }
  }

  return { enable, disable, test, status, isSupported, autoRegister };
})();

// Auto-registro al cargar
if (typeof window !== 'undefined') {
  window.addEventListener('load', () => PushClient.autoRegister());
}
