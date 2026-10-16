/* Independent, CSP-safe recovery when the application module cannot start. */
;(() => {
  let ready = false
  let failed = false
  let shown = false
  let checkedWorker = false
  const updateMessages = {
    en: 'An update is ready. Save work in other tabs, close all Roisey Else tabs and windows, then reopen the application.',
    tr: 'Bir güncelleme hazır. Diğer sekmelerdeki çalışmalarınızı kaydedin, tüm Roisey Else sekmelerini ve pencerelerini kapatıp uygulamayı yeniden açın.',
    ro: 'O actualizare este pregătită. Salvați lucrul din celelalte file, închideți toate filele și ferestrele Roisey Else, apoi redeschideți aplicația.',
    de: 'Ein Update ist bereit. Speichern Sie Ihre Arbeit in anderen Tabs, schließen Sie alle Roisey-Else-Tabs und -Fenster und öffnen Sie die Anwendung erneut.',
    fr: 'Une mise à jour est prête. Enregistrez votre travail dans les autres onglets, fermez tous les onglets et fenêtres Roisey Else, puis rouvrez l’application.',
  }
  async function checkUpdate(locale) {
    if (checkedWorker || !('serviceWorker' in navigator)) return
    checkedWorker = true
    try {
      const registration = await navigator.serviceWorker.getRegistration(
        location.origin + '/',
      )
      const known =
        registration?.active ||
        registration?.waiting ||
        registration?.installing
      if (
        !known ||
        registration.scope !== location.origin + '/' ||
        new URL(known.scriptURL).pathname !== '/sw.js'
      )
        return
      const explain = () => {
        const description = document.getElementById('startup-description')
        if (!registration.waiting || !description) return
        description.textContent = updateMessages[locale] || updateMessages.en
        document.getElementById('startup-reload')?.remove()
      }
      registration.addEventListener('updatefound', () => {
        registration.installing?.addEventListener('statechange', explain)
      })
      registration.installing?.addEventListener('statechange', explain)
      explain()
      if (!registration.waiting && !registration.installing)
        await registration.update()
      explain()
    } catch {
      /* Optional update checks never replace normal recovery. */
    }
  }
  const messages = {
    en: [
      'Application could not load',
      'A required application file is unavailable. Check your connection, then reload. If this continues, contact your administrator.',
      'Reload application',
    ],
    tr: [
      'Uygulama yüklenemedi',
      'Gerekli bir uygulama dosyasına erişilemiyor. Bağlantınızı kontrol edip yeniden yükleyin. Sorun sürerse yöneticinize başvurun.',
      'Uygulamayı yeniden yükle',
    ],
    ro: [
      'Aplicația nu s-a putut încărca',
      'Un fișier necesar nu este disponibil. Verificați conexiunea și reîncărcați. Dacă problema continuă, contactați administratorul.',
      'Reîncarcă aplicația',
    ],
    de: [
      'Die Anwendung konnte nicht geladen werden',
      'Eine benötigte Datei ist nicht verfügbar. Prüfen Sie die Verbindung und laden Sie neu. Besteht das Problem weiter, wenden Sie sich an die Administration.',
      'Anwendung neu laden',
    ],
    fr: [
      'L’application n’a pas pu se charger',
      'Un fichier nécessaire est indisponible. Vérifiez la connexion, puis rechargez. Si le problème persiste, contactez votre administrateur.',
      'Recharger l’application',
    ],
  }
  function show() {
    if (ready || !failed || shown) return
    const panel = document.getElementById('startup-error')
    if (!panel) return
    shown = true
    let locale = 'en'
    try {
      locale = localStorage.getItem('roisey-else.locale') || 'en'
    } catch {
      /* English fallback. */
    }
    const text = messages[locale] || messages.en
    for (const [index, id] of [
      'startup-title',
      'startup-description',
      'startup-reload',
    ].entries()) {
      document.getElementById(id).textContent = text[index]
    }
    document.getElementById('startup-reload').onclick = () =>
      window.location.reload()
    document.getElementById('root').hidden = true
    panel.hidden = false
    void checkUpdate(locale)
  }
  window.addEventListener(
    'error',
    (event) => {
      const target = event.target
      const source =
        target instanceof HTMLScriptElement
          ? target.src
          : target instanceof HTMLLinkElement
            ? target.href
            : ''
      if (!source) return
      const url = new URL(source, location.href)
      if (
        url.origin !== location.origin ||
        !url.pathname.startsWith('/assets/')
      )
        return
      if (
        (target instanceof HTMLScriptElement && target.type === 'module') ||
        (target instanceof HTMLLinkElement &&
          ['stylesheet', 'modulepreload'].includes(target.rel))
      ) {
        failed = true
        show()
      }
    },
    true,
  )
  document.addEventListener('DOMContentLoaded', show, { once: true })
  window.addEventListener(
    'roisey:ready',
    () => {
      ready = true
      if (!failed) document.getElementById('startup-error')?.remove()
    },
    { once: true },
  )
})()
