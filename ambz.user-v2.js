// ==UserScript==
// @name         ambzv6 – Apple Music playlist search & sort
// @namespace    ambzv6
// @version      0.4.0
// @description  Replaces a playlist's song list with a complete one (no lazy loading) and adds search, sorting, links and a song menu.
// @match        https://music.apple.com/*
// @match        https://beta.music.apple.com/*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @connect      accounts.spotify.com
// @connect      api.spotify.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  // ---------------------------------------------------------------- config
  const PAGE_SIZE = 100;     // API maximum for playlist tracks
  const CONCURRENCY = 4;     // parallel page requests
  const QUEUE_MAX = 200;     // songs queued when you start a song from the list
  const QUEUE_BEFORE = 20;   // of which this many come before the started one
  const STORE_KEY = 'ambz-settings';
  const HIDE = 'data-ambz-hidden';

  // The page's own window. Depending on how the userscript manager injects us
  // we are either in the page context already or in a Firefox content script,
  // where the page's objects are only reachable through wrappedJSObject.
  // In that case Violentmonkey's unsafeWindow is just the content-script window,
  // so wrappedJSObject has to win whenever it exists.
  const UW = typeof unsafeWindow !== 'undefined' && unsafeWindow ? unsafeWindow : window;
  const W = window.wrappedJSObject || UW.wrappedJSObject || UW;

  // Create a plain object inside the page's compartment so page code can read it.
  const toPage = (obj) => W.JSON.parse(JSON.stringify(obj));
  // Copy a page object into ours.
  const fromPage = (obj) => JSON.parse(W.JSON.stringify(obj));

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------- texts
  const GERMAN = (document.documentElement.lang || navigator.language || '').toLowerCase().startsWith('de');
  const T = GERMAN
    ? {
        search: 'In Playlist suchen', sort: 'Sortieren', loading: 'Lade …', error: 'Laden fehlgeschlagen',
        pos: 'Playlist-Reihenfolge', title: 'Titel', artist: 'Künstler:in', album: 'Album', dur: 'Dauer',
        release: 'Erscheinungsdatum', added: 'Hinzugefügt am', asc: 'Aufsteigend', desc: 'Absteigend',
        native: 'Originalliste anzeigen', reload: 'Neu laden', none: 'Keine passenden Titel',
        more: 'Mehr', back: 'Zurück', playNext: 'Als Nächstes abspielen', playLast: 'Zuletzt abspielen',
        addToPlaylist: 'Zu Playlist hinzufügen', addToLibrary: 'Zur Mediathek hinzufügen', favorite: 'Als Favorit markieren',
        goSong: 'Titel anzeigen', goAlbum: 'Album anzeigen', goArtist: 'Künstler:in anzeigen', copyLink: 'Link kopieren',
        queuedNext: 'Wird als Nächstes gespielt', queuedLast: 'Wird zuletzt gespielt', addedLibrary: 'Zur Mediathek hinzugefügt',
        favorited: 'Als Favorit markiert', copied: 'Link kopiert', failed: 'Fehlgeschlagen', unavailable: 'Nicht verfügbar',
        remove: 'Aus Playlist entfernen', removed: 'Aus Playlist entfernt', copySpotify: 'Spotify-Link kopieren',
        copiedSpotify: 'Spotify-Link kopiert', spotifyFallback: 'Bei Spotify nicht gefunden – Suchlink kopiert',
        badSpotifyLogin: 'Spotify-Zugangsdaten ungültig, bitte erneut eingeben',
        askSpotifyId: 'Spotify Client ID\n(developer.spotify.com/dashboard → deine App → Settings)',
        askSpotifySecret: 'Spotify Client Secret',
        noPlaylists: 'Keine bearbeitbaren Playlists', addedTo: (name) => `Zu „${name}“ hinzugefügt`,
        count: (n, total) => `${n} von ${total} Titeln`,
        progress: (done, total) => (total ? `Lade ${done} / ${total} …` : `Lade ${done} …`),
      }
    : {
        search: 'Search in playlist', sort: 'Sort', loading: 'Loading…', error: 'Loading failed',
        pos: 'Playlist order', title: 'Song', artist: 'Artist', album: 'Album', dur: 'Time',
        release: 'Release date', added: 'Date added', asc: 'Ascending', desc: 'Descending',
        native: 'Show original list', reload: 'Reload', none: 'No matching songs',
        more: 'More', back: 'Back', playNext: 'Play Next', playLast: 'Play Last',
        addToPlaylist: 'Add to Playlist', addToLibrary: 'Add to Library', favorite: 'Mark as Favorite',
        goSong: 'Go to Song', goAlbum: 'Go to Album', goArtist: 'Go to Artist', copyLink: 'Copy Link',
        queuedNext: 'Playing next', queuedLast: 'Playing last', addedLibrary: 'Added to library',
        favorited: 'Marked as favorite', copied: 'Link copied', failed: 'Failed', unavailable: 'Not available',
        remove: 'Remove from Playlist', removed: 'Removed from playlist', copySpotify: 'Copy Spotify Link',
        copiedSpotify: 'Spotify link copied', spotifyFallback: 'Not found on Spotify – search link copied',
        badSpotifyLogin: 'Spotify credentials invalid, please enter them again',
        askSpotifyId: 'Spotify Client ID\n(developer.spotify.com/dashboard → your app → Settings)',
        askSpotifySecret: 'Spotify Client Secret',
        noPlaylists: 'No editable playlists', addedTo: (name) => `Added to “${name}”`,
        count: (n, total) => `${n} of ${total} songs`,
        progress: (done, total) => (total ? `Loading ${done} / ${total}…` : `Loading ${done}…`),
      };

  // ---------------------------------------------------------------- MusicKit
  function getMK() {
    try {
      return (W.MusicKit && W.MusicKit.getInstance()) || null;
    } catch (e) {
      return null;
    }
  }

  async function waitForMK(timeoutMs = 30000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const mk = getMK();
      if (mk && mk.api && mk.api.music) return mk;
      if (Date.now() > end) {
        let why = 'no global MusicKit object';
        try {
          if (W.MusicKit) why = mk ? 'instance has no api.music' : 'MusicKit.getInstance() returned nothing';
        } catch (e) {
          why = `cannot access page window (${e && e.message})`;
        }
        throw new Error(`MusicKit not available: ${why}`);
      }
      await sleep(250);
    }
  }

  async function apiGet(path, params) {
    const mk = await waitForMK();
    const res = params ? await mk.api.music(path, toPage(params)) : await mk.api.music(path);
    return fromPage(res.data);
  }

  // Write requests. MusicKit JSON-encodes an object body itself.
  async function apiSend(method, path, params, body) {
    const mk = await waitForMK();
    const options = body === undefined ? { method } : { method, body };
    const res = await mk.api.music(path, toPage(params || {}), toPage(options));
    const status = Number(res && res.status);
    if (!(status >= 200 && status < 300)) throw new Error(`HTTP ${status || '?'}`);
  }

  // ---------------------------------------------------------------- data
  function parsePlaylist() {
    const m = location.pathname.match(
      /^\/(?:([a-z]{2})\/)?(?:library\/)?playlist\/(?:[^/]+\/)?((?:pl|p)\.[A-Za-z0-9._-]+)/
    );
    if (!m) return null;
    return { id: m[2], library: m[2].startsWith('p.'), storefront: m[1] || null };
  }

  const norm = (s) =>
    String(s || '').toLowerCase().normalize('NFD').replace(/\p{M}+/gu, '');

  function toTrack(item, pos) {
    const a = item.attributes || {};
    const pp = a.playParams || null;
    const art = a.artwork && a.artwork.url
      ? a.artwork.url.replace('{w}', '80').replace('{h}', '80').replace('{f}', 'jpg')
      : '';
    const id = String((pp && pp.id) || item.id);
    const library = id.startsWith('i.');
    return {
      id,
      library,                                                        // lives in the user's library
      type: item.type || (library ? 'library-songs' : 'songs'),       // API resource type
      links: null,                                                    // song/album/artist pages, looked up on demand
      spotify: '',                                                    // Spotify address once found
      catalogId: pp && pp.catalogId ? String(pp.catalogId) : null,
      playable: !!pp,
      pos,
      title: a.name || '',
      artist: a.artistName || '',
      album: a.albumName || '',
      dur: a.durationInMillis || 0,
      release: a.releaseDate || '',
      added: a.dateAdded || '',
      explicit: a.contentRating === 'explicit',
      art,
      hay: norm(`${a.name} ${a.artistName} ${a.albumName}`),
    };
  }

  async function loadAllTracks(pl, onProgress) {
    const mk = await waitForMK();
    const sf = pl.storefront || mk.storefrontId || 'us';
    const base = pl.library
      ? `/v1/me/library/playlists/${pl.id}/tracks`
      : `/v1/catalog/${sf}/playlists/${pl.id}/tracks`;
    const page = (offset) => apiGet(`${base}?limit=${PAGE_SIZE}&offset=${offset}`);

    const first = await page(0);
    let items = first.data || [];
    const total = first.meta && first.meta.total;
    const step = items.length;
    onProgress(items.length, total);

    if (first.next && step > 0 && total > step) {
      // Total is known: fetch the remaining pages in parallel.
      const offsets = [];
      for (let o = step; o < total; o += step) offsets.push(o);
      const pages = new Array(offsets.length);
      let cursor = 0;
      let done = items.length;
      const worker = async () => {
        while (cursor < offsets.length) {
          const i = cursor++;
          const r = await page(offsets[i]);
          pages[i] = r.data || [];
          done += pages[i].length;
          onProgress(done, total);
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      for (const p of pages) items = items.concat(p);
    } else if (first.next && step > 0) {
      // Total unknown: walk page by page until the API runs out.
      for (;;) {
        let r;
        try {
          r = await page(items.length);
        } catch (e) {
          break;
        }
        if (!r.data || !r.data.length) break;
        items = items.concat(r.data);
        onProgress(items.length, undefined);
        if (!r.next) break;
      }
    }
    return items.map(toTrack);
  }

  // ---------------------------------------------------------------- state
  const settings = Object.assign({ sort: 'pos', desc: false }, readSettings());
  const cache = new Map(); // playlist id -> tracks
  const state = {
    pl: null,
    tracks: [],
    view: [],
    rows: [],
    query: '',
    ready: false,      // full track list is loaded and rendered
    readyAt: 0,
    loading: false,
    progress: '',
    error: '',
    loadId: 0,
    showNative: false, // user asked for Apple's own list
    selected: null,
    nowId: undefined,
    href: '',
    warned: false,
  };

  function readSettings() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
    } catch (e) {
      return {};
    }
  }
  function saveSettings() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ sort: settings.sort, desc: settings.desc }));
    } catch (e) { /* storage unavailable – settings just don't persist */ }
  }

  // ---------------------------------------------------------------- styles
  // Colours, fonts and radii come from Apple Music's own CSS variables, so the
  // list follows the page's light/dark theme. The fallbacks only matter if a
  // variable disappears in a future redesign.
  const CSS = `
    [${HIDE}] { display: none !important; }

    /* ---- controls in the playlist header ---- */
    .ambz-actions { display: flex; align-items: center; gap: 10px; min-width: 0; grid-column: 4; grid-row: 1; }
    .ambz-actions.ambz-actions--inline { justify-content: flex-end; margin: 0; padding: 0 0 12px; }
    @media (max-width: 999px) {
      .ambz-actions:not(.ambz-actions--inline) { grid-column: 1 / -1; grid-row: auto; justify-self: center; margin-top: 12px; }
    }
    .ambz-actions .ambz-search {
      display: flex; align-items: center; gap: 6px; box-sizing: border-box;
      width: 200px; height: 36px; padding: 0 12px; border-radius: 18px; cursor: text;
      background-color: var(--button-circle-background-color, rgba(128,128,128,.14));
      border: .75px solid var(--button-circle-border-color, rgba(128,128,128,.1));
      color: var(--keyColor, var(--systemPrimary, inherit));
      transition: width .2s ease;
    }
    .ambz-actions .ambz-search:focus-within { width: 270px; }
    .ambz-actions .ambz-search svg { flex: none; opacity: .7; }
    .ambz-actions .ambz-input {
      all: unset; flex: 1; min-width: 0; color: inherit;
      font: var(--body, 13px/16px system-ui, sans-serif);
    }
    .ambz-actions .ambz-input::placeholder { color: inherit; opacity: .55; }
    .ambz-actions .ambz-circle {
      all: unset; box-sizing: border-box; flex: none; cursor: pointer; position: relative;
      display: inline-flex; align-items: center; justify-content: center;
      width: 36px; height: 36px; border-radius: 50%;
      background-color: var(--button-circle-background-color, rgba(128,128,128,.14));
      border: .75px solid var(--button-circle-border-color, rgba(128,128,128,.1));
      color: var(--keyColor, var(--systemPrimary, inherit));
    }
    .ambz-actions .ambz-circle:hover, .ambz-actions .ambz-circle[aria-expanded="true"] { filter: brightness(1.2) contrast(.92); }
    .ambz-actions .ambz-circle:focus-visible { outline: 2px solid var(--keyColor, currentColor); outline-offset: 2px; }
    /* a sort other than playlist order is active */
    .ambz-actions .ambz-circle.ambz-active::after {
      content: ""; position: absolute; top: 6px; inset-inline-end: 6px;
      width: 6px; height: 6px; border-radius: 50%; background: currentColor;
    }

    /* ---- sort menu ---- */
    .ambz-menu {
      position: fixed; z-index: 2147483000; box-sizing: border-box; min-width: 230px; padding: 6px;
      border-radius: 12px; background: #fff; color: #1d1d1f; font-size: 13px; line-height: 1.25;
      box-shadow: 0 10px 34px rgba(0,0,0,.22), 0 0 0 .5px rgba(0,0,0,.16);
    }
    .ambz-menu.ambz-dark { background: #2c2c2e; color: #f5f5f7; box-shadow: 0 10px 34px rgba(0,0,0,.55), 0 0 0 .5px rgba(255,255,255,.16); }
    .ambz-menu .ambz-item {
      all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 6px;
      width: 100%; padding: 7px 10px; border-radius: 7px; cursor: pointer;
    }
    .ambz-menu .ambz-item:hover, .ambz-menu .ambz-item:focus-visible { background: rgba(128,128,128,.2); }
    .ambz-menu .ambz-check { flex: none; width: 14px; color: var(--musicKeyColor, #fa2d48); }
    .ambz-menu .ambz-sep { height: 1px; margin: 5px 8px; background: rgba(128,128,128,.3); }
    .ambz-menu { max-width: 340px; max-height: min(70vh, 560px); overflow-y: auto; }
    .ambz-menu .ambz-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ambz-menu .ambz-note { padding: 7px 10px; opacity: .6; }

    /* ---- short confirmation after a song action ---- */
    .ambz-toast {
      position: fixed; z-index: 2147483001; left: 50%; bottom: 96px; transform: translate(-50%, 8px);
      box-sizing: border-box; max-width: min(80vw, 440px); padding: 9px 16px; border-radius: 18px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      background: #1d1d1f; color: #fff; font-size: 13px; line-height: 1.25; box-shadow: 0 6px 24px rgba(0,0,0,.3);
      opacity: 0; pointer-events: none; transition: opacity .18s ease, transform .18s ease;
    }
    .ambz-toast.ambz-dark { background: #f5f5f7; color: #1d1d1f; }
    .ambz-toast.ambz-show { opacity: 1; transform: translate(-50%, 0); }

    /* ---- song list ---- */
    .ambz-list {
      margin-inline: var(--bodyGutter, 40px);
      font: var(--callout, 13px/16px system-ui, sans-serif);
      color: var(--systemSecondary, GrayText);
      -moz-user-select: none; user-select: none;
    }
    .ambz-head, .ambz-row {
      display: grid; align-items: center;
      grid-template-columns: var(--ambz-cols, minmax(0, 42fr) minmax(0, 29fr) minmax(0, 29fr) 141px);
    }
    .ambz-head { box-sizing: border-box; height: 32px; padding-bottom: 6px; font: var(--callout-emphasized, 600 13px/16px system-ui, sans-serif); }
    .ambz-list .ambz-hcol {
      all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 4px; position: relative;
      min-width: 0; padding-inline-end: 10px; cursor: pointer; color: inherit; font: inherit;
    }
    .ambz-list .ambz-hcol:not(:first-child):not(.ambz-time)::before {
      content: ""; position: absolute; inset-inline-start: -15px; top: 50%; transform: translateY(-50%);
      width: 1px; height: 16px; border-radius: .5px; background: var(--systemQuaternary, rgba(128,128,128,.3));
    }
    .ambz-list .ambz-hcol:first-child { padding-inline-start: 7px; }
    .ambz-list .ambz-hcol:hover, .ambz-list .ambz-hcol.ambz-sorted { color: var(--systemPrimary, inherit); }
    .ambz-list .ambz-hcol.ambz-time { justify-content: flex-end; padding-inline-end: var(--ambz-dur-end, 53px); }
    .ambz-hlabel { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ambz-arrow { flex: none; font-size: 8px; }
    .ambz-info { padding: 0 7px 10px; }
    .ambz-info[hidden] { display: none; }

    .ambz-row {
      box-sizing: border-box; height: 54px; cursor: default;
      border-top: .5px solid var(--labelDivider, rgba(128,128,128,.3));
      content-visibility: auto; contain-intrinsic-size: auto 54px;
    }
    .ambz-row:hover, .ambz-row.ambz-sel {
      background-color: var(--tracklistHoverColor, rgba(128,128,128,.12));
      border-radius: var(--songs-list-row-border-radius, 6px);
      border-top-color: transparent;
    }
    .ambz-row:hover + .ambz-row, .ambz-row.ambz-sel + .ambz-row { border-top-color: transparent; }
    .ambz-row.ambz-off { opacity: .45; }

    .ambz-song { display: flex; align-items: center; min-width: 0; padding-inline-end: 10px; }
    .ambz-art {
      position: relative; flex: none; width: 40px; height: 40px; margin-inline: 7px 12px;
      border-radius: 5px; overflow: hidden; cursor: pointer;
      background: var(--systemQuinary, rgba(128,128,128,.15));
    }
    .ambz-art img { display: block; width: 100%; height: 100%; object-fit: cover; }
    .ambz-art::before { content: ""; position: absolute; inset: 0; background: rgba(0,0,0,.45); opacity: 0; }
    .ambz-art::after { content: ""; position: absolute; inset: 0; margin: auto; opacity: 0; }
    .ambz-row:not(.ambz-off):hover .ambz-art::before, .ambz-row.ambz-now .ambz-art::before { opacity: 1; }
    .ambz-row:not(.ambz-off):not(.ambz-now):hover .ambz-art::after {
      opacity: 1; width: 0; height: 0; transform: translateX(1px);
      border-style: solid; border-width: 7px 0 7px 11px; border-color: transparent transparent transparent #fff;
    }
    .ambz-row.ambz-now .ambz-art::after {
      opacity: 1; width: 13px; height: 12px;
      background:
        linear-gradient(#fff, #fff) 0 100% / 3px 55% no-repeat,
        linear-gradient(#fff, #fff) 50% 100% / 3px 100% no-repeat,
        linear-gradient(#fff, #fff) 100% 100% / 3px 35% no-repeat;
    }
    .ambz-playing .ambz-row.ambz-now .ambz-art::after { animation: ambz-eq .9s ease-in-out infinite; }
    @keyframes ambz-eq { 50% { background-size: 3px 100%, 3px 40%, 3px 85%; } }
    @media (prefers-reduced-motion: reduce) { .ambz-playing .ambz-row.ambz-now .ambz-art::after { animation: none; } }

    .ambz-title {
      min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font: var(--body, 13px/16px system-ui, sans-serif); color: var(--systemPrimary, CanvasText);
    }
    .ambz-e {
      display: inline-block; width: 12px; margin-inline-start: 6px; border-radius: 2px;
      font-size: 9px; line-height: 12px; text-align: center; vertical-align: 1px;
      color: var(--systemSecondary, GrayText); background: color-mix(in srgb, currentColor 28%, transparent);
    }
    .ambz-cell {
      min-width: 0; padding-inline-end: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font: var(--body, 13px/16px system-ui, sans-serif);
    }
    /* duration, then the "…" button where Apple's list has its own */
    .ambz-dur {
      display: flex; align-items: center; justify-content: flex-end;
      gap: max(4px, calc(var(--ambz-dur-end, 53px) - 46px)); padding-inline-end: 18px;
      font: var(--body, 13px/16px system-ui, sans-serif); font-variant-numeric: tabular-nums;
    }
    .ambz-list .ambz-more {
      all: unset; box-sizing: border-box; flex: none; width: 28px; height: 28px; padding: 0 6.5px; cursor: pointer;
      color: var(--systemPrimary, inherit); opacity: .8;
      background: radial-gradient(circle, currentColor 1.4px, transparent 1.9px) 0 50% / 5px 5px repeat-x content-box content-box;
    }
    .ambz-list .ambz-more:hover, .ambz-list .ambz-more:focus-visible { opacity: 1; }
    .ambz-link { cursor: pointer; }
    .ambz-link:hover { text-decoration: underline; }
    .ambz-link.ambz-busy { cursor: progress; }
    @media (max-width: 900px) {
      .ambz-head, .ambz-row { grid-template-columns: minmax(0, 58fr) minmax(0, 42fr) 104px; }
      .ambz-head > :nth-child(3), .ambz-row > :nth-child(3) { display: none; }
    }
  `;

  // ---------------------------------------------------------------- DOM helpers
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (k === 'class') el.className = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, '');
        else if (v !== false && v != null) el.setAttribute(k, v);
      }
    }
    for (const c of children) if (c != null) el.append(c);
    return el;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function icon(shapes) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 16 16', width: '16', height: '16', 'aria-hidden': 'true' })) {
      svg.setAttribute(k, v);
    }
    for (const [tag, attrs] of shapes) {
      const el = document.createElementNS(SVG_NS, tag);
      const all = Object.assign(
        { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
        attrs
      );
      for (const [k, v] of Object.entries(all)) el.setAttribute(k, v);
      svg.append(el);
    }
    return svg;
  }
  const ICON_SEARCH = [['circle', { cx: '7', cy: '7', r: '4.4' }], ['path', { d: 'M10.4 10.4 14 14' }]];
  const ICON_SORT = [['path', { d: 'M5 13V3M5 3 2.4 5.6M5 3l2.6 2.6M11 3v10M11 13l-2.6-2.6M11 13l2.6-2.6' }]];

  // ---------------------------------------------------------------- UI
  const HEAD_COLS = ['title', 'artist', 'album', 'dur'];
  const SORT_KEYS = ['pos', 'title', 'artist', 'album', 'dur', 'release', 'added'];
  if (!SORT_KEYS.includes(settings.sort)) settings.sort = 'pos';

  let ui = null;

  function buildUI() {
    if (typeof GM_addStyle === 'function') GM_addStyle(CSS);
    else document.head.append(h('style', null, CSS));

    // -- header controls
    const search = h('input', {
      class: 'ambz-input', type: 'search', placeholder: T.search, 'aria-label': T.search,
      spellcheck: 'false', autocomplete: 'off', disabled: true,
    });
    const searchBox = h('label', { class: 'ambz-search' }, icon(ICON_SEARCH), search);
    const sortBtn = h('button', {
      class: 'ambz-circle', type: 'button', title: T.sort, 'aria-label': T.sort,
      'aria-haspopup': 'menu', 'aria-expanded': 'false',
    }, icon(ICON_SORT));
    const actions = h('div', { class: 'ambz-actions' }, searchBox, sortBtn);

    // Keep Apple Music's own shortcuts (space = play/pause, …) from firing while typing.
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (search.value) {
          search.value = '';
          setQuery('');
        } else {
          search.blur();
        }
      }
      e.stopPropagation();
    });
    for (const type of ['keyup', 'keypress']) search.addEventListener(type, (e) => e.stopPropagation());

    let debounce = 0;
    search.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => setQuery(search.value), 120);
    });
    sortBtn.addEventListener('click', () => {
      if (ui.menu && ui.menuAnchor && ui.menuAnchor.el === sortBtn) closeMenu();
      else showMenu({ el: sortBtn }, sortItems());
    });

    // -- list
    const headCols = HEAD_COLS.map((key) =>
      h('button', {
        class: key === 'dur' ? 'ambz-hcol ambz-time' : 'ambz-hcol', type: 'button', 'data-key': key,
        onclick: () => cycleSort(key),
      }, h('span', { class: 'ambz-hlabel' }, T[key]), h('span', { class: 'ambz-arrow' }))
    );
    const info = h('div', { class: 'ambz-info', hidden: true });
    const head = h('div', { class: 'ambz-head' }, ...headCols);
    const body = h('div', { class: 'ambz-body' });
    const root = h('div', { class: 'ambz-list' }, info, head, body);

    const rowOf = (e) => (e.target.closest ? e.target.closest('.ambz-row') : null);
    body.addEventListener('click', (e) => {
      const justClosed = ui.justClosed;
      ui.justClosed = null;
      const row = rowOf(e);
      if (!row) return;
      const i = Number(row.dataset.i);
      const more = e.target.closest('.ambz-more');
      const link = e.target.closest('.ambz-link');
      if (more) {
        select(row);
        if (justClosed !== more) showTrackMenu(i, { el: more }); // second click on "…" closes its menu
      } else if (link) {
        go(state.view[i], link.dataset.go, { x: e.clientX, y: e.clientY }, link);
      } else if (e.target.closest('.ambz-art')) {
        playOrToggle(i);
      } else {
        select(row);
      }
    });
    body.addEventListener('dblclick', (e) => {
      const row = rowOf(e);
      if (row && !e.target.closest('.ambz-art, .ambz-link, .ambz-more')) play(Number(row.dataset.i));
    });
    body.addEventListener('contextmenu', (e) => {
      const row = rowOf(e);
      if (!row) return;
      e.preventDefault();
      select(row);
      showTrackMenu(Number(row.dataset.i), { x: e.clientX, y: e.clientY });
    });

    const toastEl = h('div', { class: 'ambz-toast', role: 'status' });
    ui = {
      search, searchBox, sortBtn, actions, info, head, headCols, body, root,
      menu: null, menuAnchor: null, justClosed: null, toast: toastEl,
    };
  }

  function setQuery(q) {
    state.query = q;
    state.showNative = false;
    render();
    sync();
  }

  function setSort(key, desc) {
    settings.sort = key;
    settings.desc = desc;
    saveSettings();
    state.showNative = false;
    render();
    sync();
  }

  // Column header: ascending -> descending -> back to playlist order.
  function cycleSort(key) {
    if (settings.sort !== key) setSort(key, false);
    else if (!settings.desc) setSort(key, true);
    else setSort('pos', false);
  }

  function select(row) {
    if (state.selected) state.selected.classList.remove('ambz-sel');
    state.selected = row;
    if (row) row.classList.add('ambz-sel');
  }

  // ---- menus (sort menu and song menu) and the confirmation toast
  function isDark() {
    const el = document.getElementById('scrollable-page') || document.body;
    const color = getComputedStyle(el).color;
    const m = color.startsWith('rgb') && color.match(/[\d.]+/g);
    if (!m) return matchMedia('(prefers-color-scheme: dark)').matches;
    return 0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2] > 140; // light text means dark page
  }

  // items: null = separator, { note } = plain text, { label, checked, keep, run } = entry.
  // "keep" leaves the menu open (the entry swaps the menu's content).
  function fillMenu(menu, items) {
    menu.textContent = '';
    for (const it of items) {
      if (!it) {
        menu.append(h('div', { class: 'ambz-sep' }));
      } else if (it.note) {
        menu.append(h('div', { class: 'ambz-note' }, it.note));
      } else {
        menu.append(h('button', {
          class: 'ambz-item', type: 'button', role: 'menuitem',
          onclick: () => {
            if (!it.keep) closeMenu();
            it.run();
          },
        }, h('span', { class: 'ambz-check' }, it.checked ? '✓' : ''), h('span', { class: 'ambz-label' }, it.label)));
      }
    }
  }

  // anchor: { el } opens below that element, { x, y } opens at that point.
  function placeMenu() {
    const menu = ui.menu;
    const a = ui.menuAnchor;
    if (!menu || !a) return;
    if (a.el && a.el.isConnected) a.rect = a.el.getBoundingClientRect();
    const r = a.rect || { left: a.x || 0, right: a.x || 0, top: a.y || 0, bottom: a.y || 0 };
    const gap = a.el ? 6 : 2;
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8));
    const below = r.bottom + gap;
    const top = below + mh > window.innerHeight - 8 ? Math.max(8, r.top - mh - gap) : below;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  function showMenu(anchor, items) {
    closeMenu();
    const menu = h('div', { class: isDark() ? 'ambz-menu ambz-dark' : 'ambz-menu', role: 'menu' });
    fillMenu(menu, items);
    document.body.append(menu);
    ui.menu = menu;
    ui.menuAnchor = anchor;
    placeMenu();
    if (anchor.el === ui.sortBtn) ui.sortBtn.setAttribute('aria-expanded', 'true');
  }

  function closeMenu() {
    if (!ui || !ui.menu) return;
    ui.menu.remove();
    ui.menu = null;
    ui.menuAnchor = null;
    ui.sortBtn.setAttribute('aria-expanded', 'false');
  }

  function sortItems() {
    const items = [];
    for (const key of SORT_KEYS) {
      // Offer the date sorts only when the playlist actually carries those dates.
      if ((key === 'release' || key === 'added') && !state.tracks.some((t) => t[key])) continue;
      items.push({ label: T[key], checked: settings.sort === key, run: () => setSort(key, settings.desc) });
    }
    items.push(
      null,
      { label: T.asc, checked: !settings.desc, run: () => setSort(settings.sort, false) },
      { label: T.desc, checked: settings.desc, run: () => setSort(settings.sort, true) },
      null,
      {
        label: T.native, checked: state.showNative,
        run: () => {
          state.showNative = !state.showNative;
          sync();
        },
      },
      {
        label: T.reload,
        run: () => {
          if (state.pl) {
            cache.delete(state.pl.id);
            load(state.pl);
          }
        },
      }
    );
    return items;
  }

  let toastTimer = 0;
  function toast(text) {
    const el = ui.toast;
    el.textContent = text;
    el.className = isDark() ? 'ambz-toast ambz-dark' : 'ambz-toast';
    if (!el.isConnected) document.body.append(el);
    void el.offsetWidth; // let the hidden state apply first so the fade-in runs
    el.classList.add('ambz-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('ambz-show'), 2400);
  }

  // ---- rendering
  const fmtDur = (ms) => {
    if (!ms) return '';
    const s = Math.floor(ms / 1000);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
  };

  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

  function computeView() {
    const terms = norm(state.query).split(/\s+/).filter(Boolean);
    const view = terms.length
      ? state.tracks.filter((t) => terms.every((q) => t.hay.includes(q)))
      : state.tracks.slice();
    const key = settings.sort;
    if (key !== 'pos') {
      const numeric = key === 'dur';
      view.sort((a, b) =>
        (numeric ? a[key] - b[key] : collator.compare(a[key], b[key])) || a.pos - b.pos
      );
    }
    if (settings.desc) view.reverse();
    return view;
  }

  function updateControls() {
    ui.search.disabled = !state.ready;
    ui.search.placeholder = state.error ? T.error : state.loading ? state.progress || T.loading : T.search;
    ui.searchBox.title = state.error || '';
    ui.sortBtn.classList.toggle('ambz-active', settings.sort !== 'pos' || settings.desc);
    for (const col of ui.headCols) {
      const on = settings.sort === col.dataset.key;
      col.classList.toggle('ambz-sorted', on);
      col.lastChild.textContent = on ? (settings.desc ? '▼' : '▲') : '';
    }
    let text = '';
    if (state.query.trim()) text = state.view.length ? T.count(state.view.length, state.tracks.length) : T.none;
    ui.info.textContent = text;
    ui.info.hidden = !text;
  }

  function render() {
    state.view = computeView();
    state.rows = [];
    state.selected = null;
    const frag = document.createDocumentFragment();
    state.view.forEach((t, i) => {
      const row = h('div', { class: t.playable ? 'ambz-row' : 'ambz-row ambz-off', 'data-i': String(i) },
        h('div', { class: 'ambz-song' },
          h('div', { class: 'ambz-art' },
            t.art ? h('img', { src: t.art, loading: 'lazy', decoding: 'async', alt: '' }) : null),
          h('div', { class: 'ambz-title', title: t.title },
            catalogIdOf(t) ? h('span', { class: 'ambz-link', 'data-go': 'song' }, t.title) : t.title,
            t.explicit ? h('span', { class: 'ambz-e' }, 'E') : null)),
        h('div', { class: 'ambz-cell', title: t.artist },
          t.artist ? h('span', { class: 'ambz-link', 'data-go': 'artist' }, t.artist) : null),
        h('div', { class: 'ambz-cell', title: t.album },
          t.album ? h('span', { class: 'ambz-link', 'data-go': 'album' }, t.album) : null),
        h('div', { class: 'ambz-dur' },
          h('span', null, fmtDur(t.dur)),
          h('button', { class: 'ambz-more', type: 'button', title: T.more, 'aria-label': T.more }))
      );
      state.rows.push(row);
      frag.append(row);
    });
    ui.body.textContent = '';
    ui.body.append(frag);
    updateControls();
    state.nowId = undefined;
    highlight();
  }

  const isNow = (t) => state.nowId != null && (t.id === state.nowId || t.catalogId === state.nowId);

  function highlight() {
    if (!ui.root.isConnected) return;
    let id = null;
    let playing = false;
    try {
      const mk = getMK();
      const item = mk && mk.nowPlayingItem;
      if (item && item.id != null) id = String(item.id);
      playing = !!(mk && mk.isPlaying);
    } catch (e) { /* ignore */ }
    ui.root.classList.toggle('ambz-playing', playing);
    if (id === state.nowId) return;
    state.nowId = id;
    state.view.forEach((t, i) => state.rows[i].classList.toggle('ambz-now', isNow(t)));
  }

  // ---------------------------------------------------------------- playback
  async function play(i) {
    const track = state.view[i];
    if (!track || !track.playable) return;
    try {
      const mk = await waitForMK();
      const start = Math.max(0, i - QUEUE_BEFORE);
      const slice = state.view.slice(start, start + QUEUE_MAX).filter((t) => t.playable);
      await mk.setQueue(toPage({ songs: slice.map((t) => t.id), startWith: slice.indexOf(track) }));
      await mk.play();
    } catch (e) {
      console.error('[ambz] playback failed', e);
    }
  }

  // The artwork button: pause/resume the current song, otherwise start the song.
  async function playOrToggle(i) {
    const track = state.view[i];
    if (!track) return;
    const mk = getMK();
    if (mk && isNow(track)) {
      try {
        if (mk.isPlaying) await mk.pause();
        else await mk.play();
      } catch (e) {
        console.error('[ambz] play/pause failed', e);
      }
      return;
    }
    play(i);
  }

  function errText(e) {
    try {
      return String((e && (e.message || e.name)) || e);
    } catch (x) {
      return 'unknown error';
    }
  }

  // ---------------------------------------------------------------- links (song, album, artist pages)
  const catalogIdOf = (t) => t.catalogId || (t.library ? null : t.id);
  const kindOf = (t) => t.type.replace('library-', ''); // songs | music-videos

  function storefront() {
    const mk = getMK();
    return (state.pl && state.pl.storefront) || (mk && mk.storefrontId) || 'us';
  }

  // Moves to another page inside Apple Music's own app. Following a normal link
  // would reload the whole page and stop playback.
  function navigate(url) {
    let u;
    try {
      u = new URL(url, location.href);
    } catch (e) {
      return;
    }
    closeMenu();
    if (!/(^|\.)music\.apple\.com$/.test(u.hostname)) {
      window.open(u.href, '_blank', 'noopener');
      return;
    }
    W.history.pushState(null, '', u.pathname + u.search);
    W.dispatchEvent(new W.PopStateEvent('popstate'));
  }

  const related = (item, name) =>
    (item.relationships && item.relationships[name] && item.relationships[name].data) || [];
  const attrs = (item) => item.attributes || {};

  async function fetchLinks(t) {
    const sf = storefront();
    const cid = catalogIdOf(t);
    if (cid) {
      const r = await apiGet(`/v1/catalog/${sf}/${kindOf(t)}/${cid}`, {
        include: 'artists,albums', 'fields[artists]': 'name,url', 'fields[albums]': 'name,url',
      });
      const item = r.data && r.data[0];
      if (!item) throw new Error('not found in the catalog');
      return {
        song: attrs(item).url || '',
        isrc: attrs(item).isrc || '', // recording code shared across music services
        album: related(item, 'albums').map((a) => attrs(a).url).find(Boolean) || '',
        artists: related(item, 'artists')
          .map((a) => ({ name: attrs(a).name || t.artist, url: attrs(a).url }))
          .filter((a) => a.url),
      };
    }
    // Not in the catalog (an uploaded song, for example): use its library pages.
    const r = await apiGet(`/v1/me/library/${kindOf(t)}/${t.id}`, { include: 'artists,albums' });
    const item = r.data && r.data[0];
    if (!item) throw new Error('not found in the library');
    return {
      song: '',
      isrc: '',
      album: related(item, 'albums').map((a) => `/${sf}/library/albums/${a.id}`)[0] || '',
      artists: related(item, 'artists')
        .map((a) => ({ name: attrs(a).name || t.artist, url: `/${sf}/library/artists/${a.id}` })),
    };
  }

  // One lookup per song, on first use; a failed lookup may be retried.
  function resolveLinks(t) {
    if (!t.links) {
      t.links = fetchLinks(t);
      t.links.catch(() => {
        t.links = null;
      });
    }
    return t.links;
  }

  // what: 'song' | 'album' | 'artist'. Several artists open a small chooser at the anchor.
  async function go(t, what, anchor, el) {
    if (!t) return;
    const cid = catalogIdOf(t);
    if (what === 'song' && cid) {
      // The song page address only needs the catalogue id, so no lookup is required.
      navigate(`/${storefront()}/${kindOf(t) === 'music-videos' ? 'music-video' : 'song'}/${cid}`);
      return;
    }
    const pl = state.pl;
    if (el) el.classList.add('ambz-busy');
    let links;
    try {
      links = await resolveLinks(t);
    } catch (e) {
      console.error('[ambz] link lookup failed', e);
      toast(T.unavailable);
      return;
    } finally {
      if (el) el.classList.remove('ambz-busy');
    }
    if (state.pl !== pl) return; // the user moved on while we were looking it up
    if (what === 'artist') {
      if (links.artists.length > 1) {
        showMenu(anchor, links.artists.map((a) => ({ label: a.name, run: () => navigate(a.url) })));
      } else if (links.artists.length) {
        navigate(links.artists[0].url);
      } else {
        toast(T.unavailable);
      }
      return;
    }
    const url = what === 'album' ? links.album : links.song;
    if (url) navigate(url);
    else toast(T.unavailable);
  }

  // ---------------------------------------------------------------- song menu actions
  async function act(doneText, fn) {
    try {
      await fn();
      toast(doneText);
    } catch (e) {
      console.error('[ambz] action failed', e);
      toast(`${T.failed} (${errText(e)})`);
    }
  }

  const enqueue = (t, next) =>
    act(next ? T.queuedNext : T.queuedLast, async () => {
      const mk = await waitForMK();
      const what = toPage(kindOf(t) === 'music-videos' ? { musicVideo: t.id } : { song: t.id });
      if (next) await mk.playNext(what);
      else await mk.playLater(what);
    });

  // The three write requests below use the same paths and bodies as Apple Music's own web app.
  const addToPlaylist = (t, p) =>
    act(T.addedTo(p.name), () =>
      apiSend('POST', `/v1/me/library/playlists/${p.id}/tracks`, { representation: 'resources' },
        { data: [{ id: t.id, type: t.type }] }));

  const addToLibrary = (t) =>
    act(T.addedLibrary, () =>
      apiSend('POST', '/v1/me/library', { [`ids[${kindOf(t)}]`]: catalogIdOf(t), representation: 'ids' }));

  const favorite = (t) =>
    act(T.favorited, () =>
      apiSend('PUT', `/v1/me/ratings/${t.type}/${t.id}`, null, { type: 'rating', attributes: { value: 1 } }));

  // Same request Apple Music's web app sends. "mode=all" removes every occurrence
  // of the song from the playlist, so the local list drops them all as well.
  const removeFromPlaylist = (t) => {
    const pl = state.pl;
    return act(T.removed, async () => {
      await apiSend('DELETE', `/v1/me/library/playlists/${pl.id}/tracks`, { [`ids[${t.type}]`]: t.id, mode: 'all' });
      const rest = (cache.get(pl.id) || []).filter((x) => x.id !== t.id);
      rest.forEach((x, i) => {
        x.pos = i;
      });
      cache.set(pl.id, rest);
      if (state.pl === pl) {
        state.tracks = rest;
        render();
        sync();
      }
    });
  };

  const copyLink = (t) =>
    act(T.copied, async () => {
      const links = await resolveLinks(t);
      if (!links.song) throw new Error('no link');
      await copyText(links.song);
    });

  // ---------------------------------------------------------------- Spotify link
  // Finds the same recording on Spotify through Spotify's Web API, matching on the
  // ISRC that Apple Music reports for the song. Needs a (free) Spotify developer
  // app; its client ID and secret are asked for once and kept in the userscript
  // manager's storage, not in the page.
  const stored = (key) => (typeof GM_getValue === 'function' ? GM_getValue(key, '') : '');
  const store = (key, value) => {
    if (typeof GM_setValue === 'function') GM_setValue(key, value);
  };

  // Cross-site request through the userscript manager (the page itself may only talk to Apple).
  function gmRequest(options) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('GM_xmlhttpRequest not available'));
        return;
      }
      GM_xmlhttpRequest(Object.assign({ method: 'GET', timeout: 15000 }, options, {
        onload: resolve,
        onerror: () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('timeout')),
      }));
    });
  }

  // Works after a network round trip too, when the browser no longer counts the click.
  async function copyText(text) {
    if (typeof GM_setClipboard === 'function') GM_setClipboard(text, 'text');
    else await navigator.clipboard.writeText(text);
  }

  function spotifyCredentials() {
    let id = stored('spotifyClientId');
    let secret = stored('spotifyClientSecret');
    if (id && secret) return { id, secret };
    id = (window.prompt(T.askSpotifyId) || '').trim();
    if (!id) return null;
    secret = (window.prompt(T.askSpotifySecret) || '').trim();
    if (!secret) return null;
    store('spotifyClientId', id);
    store('spotifyClientSecret', secret);
    return { id, secret };
  }

  let spotifyToken = null; // { value, until }
  async function getSpotifyToken() {
    if (spotifyToken && Date.now() < spotifyToken.until) return spotifyToken.value;
    const cred = spotifyCredentials();
    if (!cred) return null; // the user cancelled the prompt
    const r = await gmRequest({
      method: 'POST',
      url: 'https://accounts.spotify.com/api/token',
      headers: {
        Authorization: `Basic ${btoa(`${cred.id}:${cred.secret}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data: 'grant_type=client_credentials',
    });
    if (r.status === 400 || r.status === 401) {
      // Wrong ID or secret: forget them so the next attempt asks again.
      store('spotifyClientId', '');
      store('spotifyClientSecret', '');
      throw new Error(T.badSpotifyLogin);
    }
    if (r.status !== 200) throw new Error(`Spotify HTTP ${r.status}`);
    const json = JSON.parse(r.responseText);
    spotifyToken = { value: json.access_token, until: Date.now() + (Number(json.expires_in) - 60) * 1000 };
    return spotifyToken.value;
  }

  async function copySpotify(t) {
    // Used when the exact track cannot be determined: opens Spotify's search for "title artist".
    const searchLink = `https://open.spotify.com/search/${encodeURIComponent(`${t.title} ${t.artist}`.trim())}`;
    try {
      if (!t.spotify) {
        const isrc = catalogIdOf(t) ? (await resolveLinks(t)).isrc : '';
        if (isrc) {
          const token = await getSpotifyToken();
          if (!token) return;
          const r = await gmRequest({
            url: `https://api.spotify.com/v1/search?q=${encodeURIComponent(`isrc:${isrc}`)}&type=track&limit=1`,
            headers: { Authorization: `Bearer ${token}` },
          });
          if (r.status === 401) spotifyToken = null;
          if (r.status !== 200) throw new Error(`Spotify HTTP ${r.status}`);
          const tracks = JSON.parse(r.responseText).tracks;
          const hit = tracks && tracks.items && tracks.items[0];
          t.spotify = (hit && hit.external_urls && hit.external_urls.spotify) || '';
        }
      }
      await copyText(t.spotify || searchLink);
      toast(t.spotify ? T.copiedSpotify : T.spotifyFallback);
    } catch (e) {
      console.error('[ambz] Spotify lookup failed', e);
      toast(`${T.failed} (${errText(e)})`);
    }
  }

  // The user's own (editable) playlists, cached for two minutes.
  let playlistCache = null;
  async function loadPlaylists() {
    if (playlistCache && Date.now() - playlistCache.at < 120000) return playlistCache.list;
    const list = [];
    let offset = 0;
    for (;;) {
      const r = await apiGet('/v1/me/library/playlists', { limit: 100, offset });
      const data = r.data || [];
      for (const p of data) {
        if (attrs(p).canEdit) list.push({ id: p.id, name: attrs(p).name || p.id });
      }
      offset += data.length;
      if (!r.next || !data.length) break;
    }
    list.sort((a, b) => collator.compare(a.name, b.name));
    playlistCache = { at: Date.now(), list };
    return list;
  }

  function trackItems(t, anchor) {
    const cid = catalogIdOf(t);
    const items = [
      { label: T.playNext, run: () => enqueue(t, true) },
      { label: T.playLast, run: () => enqueue(t, false) },
      null,
      { label: `${T.addToPlaylist} …`, keep: true, run: () => pickPlaylist(t, anchor) },
    ];
    if (cid && !t.library) items.push({ label: T.addToLibrary, run: () => addToLibrary(t) });
    items.push({ label: T.favorite, run: () => favorite(t) }, null);
    if (cid) items.push({ label: T.goSong, run: () => go(t, 'song', anchor) });
    items.push(
      { label: T.goAlbum, run: () => go(t, 'album', anchor) },
      { label: T.goArtist, run: () => go(t, 'artist', anchor) }
    );
    items.push(null);
    if (cid) items.push({ label: T.copyLink, run: () => copyLink(t) });
    items.push({ label: T.copySpotify, run: () => copySpotify(t) });
    // Only your own library playlists can have songs removed.
    if (state.pl && state.pl.library && t.library) {
      items.push(null, { label: T.remove, run: () => removeFromPlaylist(t) });
    }
    return items;
  }

  function showTrackMenu(i, anchor) {
    const t = state.view[i];
    if (t) showMenu(anchor, trackItems(t, anchor));
  }

  // Swaps the open song menu's content for the list of playlists.
  async function pickPlaylist(t, anchor) {
    const menu = ui.menu;
    if (!menu) return;
    const back = {
      label: `‹ ${T.back}`, keep: true,
      run: () => {
        fillMenu(menu, trackItems(t, anchor));
        placeMenu();
      },
    };
    const show = (rest) => {
      if (ui.menu !== menu) return; // closed in the meantime
      fillMenu(menu, [back, null, ...rest]);
      placeMenu();
    };
    show([{ note: T.loading }]);
    try {
      const lists = (await loadPlaylists()).filter((p) => !state.pl || p.id !== state.pl.id);
      show(lists.length
        ? lists.map((p) => ({ label: p.name, run: () => addToPlaylist(t, p) }))
        : [{ note: T.noPlaylists }]);
    } catch (e) {
      console.error('[ambz] could not load playlists', e);
      show([{ note: `${T.failed} (${errText(e)})` }]);
    }
  }

  // ---------------------------------------------------------------- page integration
  function findNativeList() {
    const scope = document.getElementById('scrollable-page') || document;
    return scope.querySelector('[data-testid="tracklist"]') || scope.querySelector('.songs-list');
  }

  // Copies the native list's column widths and header labels, so swapping the
  // lists does not shift anything. Must run while the native list is visible.
  function adoptNativeLayout(native) {
    try {
      const row = native.querySelector('.songs-list-row');
      const cell = (name) => row && row.querySelector(`:scope > .songs-list__col--${name}`);
      const cells = ['song', 'secondary', 'tertiary', 'time'].map(cell);
      const widths = cells.map((c) => (c ? c.getBoundingClientRect().width : 0));
      if (widths.every((w) => w > 1)) {
        const [a, b, c, d] = widths.map((w) => Math.round(w * 10) / 10);
        ui.root.style.setProperty('--ambz-cols', `minmax(0, ${a}fr) minmax(0, ${b}fr) minmax(0, ${c}fr) ${d}px`);
        const len = row.querySelector('[data-testid="track-duration"]') || row.querySelector('.songs-list-row__length');
        const end = len ? cells[3].getBoundingClientRect().right - len.getBoundingClientRect().right : 0;
        if (end > 0 && end < widths[3]) ui.root.style.setProperty('--ambz-dur-end', `${Math.round(end)}px`);
        else ui.root.style.removeProperty('--ambz-dur-end');
      } else {
        ui.root.style.removeProperty('--ambz-cols');
        ui.root.style.removeProperty('--ambz-dur-end');
      }
      const names = { title: 'song', artist: 'secondary', album: 'tertiary', dur: 'time' };
      for (const col of ui.headCols) {
        const el = native.querySelector(`.songs-list__header .songs-list__header-col--${names[col.dataset.key]}`);
        const label = el && el.textContent.trim();
        if (label) {
          T[col.dataset.key] = label;
          col.firstChild.textContent = label;
        }
      }
    } catch (e) {
      console.warn('[ambz] could not read the native list layout', e);
    }
  }

  function unhideNative() {
    for (const el of document.querySelectorAll(`[${HIDE}]`)) el.removeAttribute(HIDE);
  }

  // Puts our list in place of Apple's. Apple's list stays in the page (hidden),
  // so nothing in their app breaks and it can be brought back at any time.
  function placeList() {
    const want = state.ready && !state.showNative && state.tracks.length > 0;
    if (!want) {
      unhideNative();
      if (ui.root.isConnected) ui.root.remove();
      return;
    }
    const native = findNativeList();
    if (native) {
      if (!native.hasAttribute(HIDE)) {
        adoptNativeLayout(native);
        native.setAttribute(HIDE, '');
      }
      if (ui.root.previousElementSibling !== native) native.after(ui.root);
      return;
    }
    // Apple's list was not found (page layout changed?): show ours below the header anyway.
    if (!ui.root.isConnected && Date.now() - state.readyAt > 3000) {
      const header = document.querySelector('[data-testid="container-detail-header"]');
      const section = header && (header.closest('[data-testid="section-container"]') || header.parentElement);
      if (section) {
        section.after(ui.root);
        if (!state.warned) {
          state.warned = true;
          console.warn('[ambz] native song list not found; showing the full list below the header instead');
        }
      }
    }
  }

  // Puts search + sort into the header's button row, next to play and shuffle.
  function placeControls() {
    const row =
      document.querySelector('[data-testid="container-detail-header"] .primary-actions') ||
      document.querySelector('#scrollable-page .primary-actions');
    if (row) {
      if (ui.actions.parentNode !== row) {
        // Borrow the shuffle button's wrapper classes: they carry the colours the
        // header derives from the playlist artwork.
        const model = row.querySelector('.primary-actions__button--shuffle:not(.ambz-actions)');
        ui.actions.className = (model ? `${model.className} ` : '') + 'ambz-actions';
        ui.actions.style.order = '4'; // after shuffle, play and add-to-library
        row.append(ui.actions);
      }
    } else if (ui.root.isConnected && ui.actions.parentNode !== ui.root) {
      ui.actions.className = 'ambz-actions ambz-actions--inline';
      ui.actions.style.order = '';
      ui.root.prepend(ui.actions);
    }
  }

  function sync() {
    if (!state.pl) {
      closeMenu();
      unhideNative();
      ui.root.remove();
      ui.actions.remove();
      return;
    }
    placeList();
    placeControls();
  }

  // ---------------------------------------------------------------- loading / routing
  async function load(pl) {
    const loadId = ++state.loadId;
    state.error = '';
    state.progress = '';
    state.ready = false;
    state.tracks = [];
    if (cache.has(pl.id)) {
      state.tracks = cache.get(pl.id);
      state.loading = false;
    } else {
      state.loading = true;
      updateControls();
      sync();
      try {
        const tracks = await loadAllTracks(pl, (done, total) => {
          if (loadId !== state.loadId) return;
          state.progress = T.progress(done, total);
          updateControls();
        });
        if (loadId !== state.loadId) return;
        cache.set(pl.id, tracks);
        state.tracks = tracks;
      } catch (e) {
        if (loadId !== state.loadId) return;
        console.error('[ambz] loading failed', e);
        state.error = errText(e);
      }
      state.loading = false;
    }
    state.ready = !state.error;
    state.readyAt = Date.now();
    render();
    sync();
  }

  function onRoute() {
    const pl = parsePlaylist();
    if (pl && state.pl && pl.id === state.pl.id) return;
    state.pl = pl;
    state.query = '';
    state.showNative = false;
    state.ready = false;
    state.tracks = [];
    ui.search.value = '';
    closeMenu();
    if (!pl) {
      state.loadId++;
      sync();
      return;
    }
    load(pl);
  }

  function tick() {
    if (location.href !== state.href) {
      state.href = location.href;
      onRoute();
    }
    sync();
  }

  function init() {
    buildUI();

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && ui.menu) {
        e.stopPropagation();
        closeMenu();
        return;
      }
      if (!state.pl || !ui.actions.isConnected) return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        e.stopPropagation();
        if (!ui.search.disabled) {
          ui.search.focus();
          ui.search.select();
        }
      }
    }, true);
    document.addEventListener('mousedown', (e) => {
      if (!ui.menu || ui.menu.contains(e.target) || ui.sortBtn.contains(e.target)) return;
      const a = ui.menuAnchor;
      ui.justClosed = a && a.el && a.el.contains(e.target) ? a.el : null;
      closeMenu();
    }, true);
    window.addEventListener('resize', closeMenu);
    document.addEventListener('scroll', (e) => {
      // Scrolling the page closes a menu; scrolling inside a long menu must not.
      if (ui.menu && e.target instanceof Node && ui.menu.contains(e.target)) return;
      closeMenu();
    }, true);

    // Apple Music is a single-page app that re-renders freely, so re-check our
    // placement whenever the page changes, plus on a slow timer as a safety net.
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        tick();
      });
    }).observe(document.body, { childList: true, subtree: true });
    setInterval(() => {
      tick();
      highlight();
    }, 500);
    tick();
  }

  init();
})();
