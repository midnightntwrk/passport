const LOCAL_IP_HOSTS = new Set(['127.0.0.1', '0.0.0.0', '[::1]']);

if (
  window.location.protocol === 'http:' &&
  LOCAL_IP_HOSTS.has(window.location.hostname)
) {
  const next = new URL(window.location.href);
  next.hostname = 'localhost';
  window.location.replace(next.toString());
}
