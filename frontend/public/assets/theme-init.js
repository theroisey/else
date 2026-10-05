/* Blocking, same-origin bootstrap: keep this preference contract in sync with appearance/theme.ts. */
(function () {
  var preference = 'system';
  try {
    var saved = localStorage.getItem('roisey-else.appearance');
    if (saved === 'light' || saved === 'dark' || saved === 'system') preference = saved;
  } catch { /* Storage may be unavailable; System remains usable. */ }
  var dark = preference === 'dark' || (preference === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.dataset.appearance = preference;
})();
