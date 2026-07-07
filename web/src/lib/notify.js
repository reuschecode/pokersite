// Notificaciones locales del navegador (sin servidor push).
// Solo avisan cuando la pestaña está en segundo plano — en primer plano ya
// están los toasts y sonidos.

export function canAskNotifications() {
  return 'Notification' in window && Notification.permission === 'default';
}

export async function askNotifications() {
  if (!('Notification' in window)) return false;
  const p = await Notification.requestPermission();
  return p === 'granted';
}

export function notify(title, body) {
  try {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    if (!document.hidden) return; // pestaña visible → no molestar
    const n = new Notification(title, { body, icon: '/pwa-192x192.png', silent: false });
    n.onclick = () => { window.focus(); n.close(); };
    setTimeout(() => n.close(), 8000);
  } catch {}
}
