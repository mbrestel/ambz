// ==UserScript==
// @name         ambzv2 – Apple Music playlist search & sort
// @namespace    ambzv2
// @version      0.2.2
// @description  Replaces a playlist's song list with a complete one (no lazy loading) and adds search and sorting to the playlist header.
// @match        https://music.apple.com/*
// @match        https://beta.music.apple.com/*
// @grant        GM_addStyle
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
        count: (n, total) => `${n} von ${total} Titeln`,
        progress: (done, total) => (total ? `Lade ${done} / ${total} …` : `Lade ${done} …`),
      }
    : {
        search: 'Search in playlist', sort: 'Sort', loading: 'Loading…', error: 'Loading failed',
        pos: 'Playlist order', title: 'Song', artist: 'Artist', album: 'Album', dur: 'Time',
        release: 'Release date', added: 'Date added', asc: 'Ascending', desc: 'Descending',
        native: 'Show original list', reload: 'Reload', none: 'No matching songs',
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

  async function apiGet(path) {
    const mk = await waitForMK();
    const res = await mk.api.music(path);
    return fromPage(res.data);
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
    return {
      id: String((pp && pp.id) || item.id),
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
    .ambz-dur {
      padding-inline-end: var(--ambz-dur-end, 53px); text-align: end; font: var(--body, 13px/16px system-ui, sans-serif);
      font-variant-numeric: tabular-nums;
    }
    @media (max-width: 900px) {
      .ambz-head, .ambz-row { grid-template-columns: minmax(0, 58fr) minmax(0, 42fr) 76px; }
      .ambz-list { --ambz-dur-end: 18px; }
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
    sortBtn.addEventListener('click', () => (ui.menu ? closeMenu() : openMenu()));

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

    body.addEventListener('click', (e) => {
      const row = e.target.closest && e.target.closest('.ambz-row');
      if (!row) return;
      const i = Number(row.dataset.i);
      if (e.target.closest('.ambz-art')) playOrToggle(i);
      else select(row);
    });
    body.addEventListener('dblclick', (e) => {
      const row = e.target.closest && e.target.closest('.ambz-row');
      if (row && !e.target.closest('.ambz-art')) play(Number(row.dataset.i));
    });

    ui = { search, searchBox, sortBtn, actions, info, head, headCols, body, root, menu: null };
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

  // ---- sort menu
  function isDark() {
    const el = document.getElementById('scrollable-page') || document.body;
    const color = getComputedStyle(el).color;
    const m = color.startsWith('rgb') && color.match(/[\d.]+/g);
    if (!m) return matchMedia('(prefers-color-scheme: dark)').matches;
    return 0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2] > 140; // light text means dark page
  }

  function openMenu() {
    closeMenu();
    const menu = h('div', { class: isDark() ? 'ambz-menu ambz-dark' : 'ambz-menu', role: 'menu' });
    const item = (label, checked, fn) =>
      h('button', {
        class: 'ambz-item', type: 'button', role: 'menuitemcheckbox', 'aria-checked': String(!!checked),
        onclick: () => {
          closeMenu();
          fn();
        },
      }, h('span', { class: 'ambz-check' }, checked ? '✓' : ''), label);
    const sep = () => h('div', { class: 'ambz-sep' });

    for (const key of SORT_KEYS) {
      // Offer the date sorts only when the playlist actually carries those dates.
      if ((key === 'release' || key === 'added') && !state.tracks.some((t) => t[key])) continue;
      menu.append(item(T[key], settings.sort === key, () => setSort(key, settings.desc)));
    }
    menu.append(
      sep(),
      item(T.asc, !settings.desc, () => setSort(settings.sort, false)),
      item(T.desc, settings.desc, () => setSort(settings.sort, true)),
      sep(),
      item(T.native, state.showNative, () => {
        state.showNative = !state.showNative;
        sync();
      }),
      item(T.reload, false, () => {
        if (state.pl) {
          cache.delete(state.pl.id);
          load(state.pl);
        }
      })
    );

    document.body.append(menu);
    const r = ui.sortBtn.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8));
    const below = r.bottom + 6;
    const top = below + mh > window.innerHeight - 8 ? Math.max(8, r.top - mh - 6) : below;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    ui.menu = menu;
    ui.sortBtn.setAttribute('aria-expanded', 'true');
  }

  function closeMenu() {
    if (!ui || !ui.menu) return;
    ui.menu.remove();
    ui.menu = null;
    ui.sortBtn.setAttribute('aria-expanded', 'false');
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
          h('div', { class: 'ambz-title', title: t.title }, t.title, t.explicit ? h('span', { class: 'ambz-e' }, 'E') : null)),
        h('div', { class: 'ambz-cell', title: t.artist }, t.artist),
        h('div', { class: 'ambz-cell', title: t.album }, t.album),
        h('div', { class: 'ambz-dur' }, fmtDur(t.dur))
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
      if (ui.menu && !ui.menu.contains(e.target) && !ui.sortBtn.contains(e.target)) closeMenu();
    }, true);
    window.addEventListener('resize', closeMenu);
    document.addEventListener('scroll', closeMenu, true);

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
