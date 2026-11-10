// ==UserScript==
// @name         ambzv1 – Apple Music playlist search & sort
// @namespace    ambzv1
// @version      0.1.1
// @description  Loads the complete track list of a playlist at once and adds search and sorting.
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
  const QUEUE_MAX = 200;     // songs queued when you click a row
  const QUEUE_BEFORE = 20;   // of which this many come before the clicked one
  const STORE_KEY = 'ambz-settings';

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
  const settings = Object.assign({ autoOpen: true, sort: 'pos', desc: false }, readSettings());
  const cache = new Map(); // playlist id -> tracks
  const state = {
    pl: null,
    tracks: [],
    view: [],
    rows: [],
    query: '',
    loading: false,
    error: '',
    loadId: 0,
    open: false,
    nowId: undefined,
    href: '',
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
      localStorage.setItem(STORE_KEY, JSON.stringify(settings));
    } catch (e) { /* storage unavailable – settings just don't persist */ }
  }

  // ---------------------------------------------------------------- UI
  const CSS = `
    #ambz-btn, #ambz-panel { font: 13px/1.3 -apple-system, "SF Pro Text", "Helvetica Neue", Ubuntu, sans-serif; }
    #ambz-btn {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
      padding: 9px 14px; border: 0; border-radius: 999px; cursor: pointer;
      background: #fa2d48; color: #fff; font-weight: 600;
      box-shadow: 0 2px 10px rgba(0,0,0,.35);
    }
    #ambz-panel {
      --bg: #fff; --fg: #1d1d1f; --dim: #6e6e73; --line: rgba(0,0,0,.1); --hover: rgba(0,0,0,.06); --field: rgba(0,0,0,.06);
      position: fixed; top: 0; right: 0; bottom: 0; width: min(780px, 100vw); z-index: 2147483001;
      display: flex; flex-direction: column;
      background: var(--bg); color: var(--fg);
      border-left: 1px solid var(--line); box-shadow: -8px 0 30px rgba(0,0,0,.25);
    }
    @media (prefers-color-scheme: dark) {
      #ambz-panel { --bg: #1f1f1f; --fg: #f5f5f7; --dim: #a1a1a6; --line: rgba(255,255,255,.12); --hover: rgba(255,255,255,.08); --field: rgba(255,255,255,.1); }
    }
    #ambz-panel[hidden], #ambz-btn[hidden] { display: none; }
    #ambz-panel * { box-sizing: border-box; }
    .ambz-bar { display: flex; gap: 8px; align-items: center; padding: 10px 12px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
    .ambz-bar input[type=search] { flex: 1 1 180px; min-width: 0; }
    .ambz-bar input[type=search], .ambz-bar select, .ambz-bar button {
      font: inherit; color: var(--fg); background: var(--field); border: 0; border-radius: 7px; padding: 7px 10px;
    }
    .ambz-bar select option { color: #000; background: #fff; }
    .ambz-bar button { cursor: pointer; min-width: 32px; }
    .ambz-bar button:hover { background: var(--hover); }
    .ambz-sub { display: flex; gap: 12px; align-items: center; padding: 6px 12px; color: var(--dim); border-bottom: 1px solid var(--line); }
    .ambz-sub .ambz-status { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ambz-sub label { display: flex; gap: 5px; align-items: center; cursor: pointer; white-space: nowrap; }
    .ambz-list { flex: 1; overflow-y: auto; overscroll-behavior: contain; }
    .ambz-row {
      display: grid; grid-template-columns: 3.2em 40px minmax(0, 1.3fr) minmax(0, 1fr) 4em; gap: 10px; align-items: center;
      height: 52px; padding: 0 12px; cursor: pointer; border-bottom: 1px solid var(--line);
      content-visibility: auto; contain-intrinsic-size: auto 52px;
    }
    .ambz-row:hover { background: var(--hover); }
    .ambz-row.ambz-off { opacity: .45; cursor: default; }
    .ambz-row.ambz-now .ambz-title { color: #fa2d48; font-weight: 600; }
    .ambz-row img, .ambz-noart { width: 40px; height: 40px; border-radius: 4px; background: var(--field); object-fit: cover; }
    .ambz-num, .ambz-dur { color: var(--dim); text-align: right; font-variant-numeric: tabular-nums; }
    .ambz-title, .ambz-artist, .ambz-album { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ambz-artist, .ambz-album { color: var(--dim); }
    .ambz-empty { padding: 30px 12px; text-align: center; color: var(--dim); }
  `;

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

  const SORTS = [
    ['pos', 'Playlist order'],
    ['title', 'Title'],
    ['artist', 'Artist'],
    ['album', 'Album'],
    ['dur', 'Duration'],
    ['release', 'Release date'],
    ['added', 'Date added'],
  ];

  let ui = null;

  function buildUI() {
    if (typeof GM_addStyle === 'function') GM_addStyle(CSS);
    else document.head.append(h('style', null, CSS));

    const search = h('input', { type: 'search', placeholder: 'Search title, artist, album…', spellcheck: 'false' });
    const sort = h('select', { title: 'Sort by' }, ...SORTS.map(([v, label]) => h('option', { value: v }, label)));
    const dir = h('button', { type: 'button', title: 'Reverse order' });
    const refresh = h('button', { type: 'button', title: 'Reload playlist' }, '↻');
    const close = h('button', { type: 'button', title: 'Close (Esc)' }, '✕');
    const status = h('span', { class: 'ambz-status' });
    const auto = h('input', { type: 'checkbox' });
    const list = h('div', { class: 'ambz-list' });
    const panel = h('div', { id: 'ambz-panel', hidden: true },
      h('div', { class: 'ambz-bar' }, search, sort, dir, refresh, close),
      h('div', { class: 'ambz-sub' }, status, h('label', null, auto, 'Open automatically')),
      list
    );
    const btn = h('button', { id: 'ambz-btn', type: 'button', hidden: true, title: 'Show full playlist (Ctrl+F)' });

    sort.value = SORTS.some(([v]) => v === settings.sort) ? settings.sort : 'pos';
    auto.checked = !!settings.autoOpen;

    // Keep Apple Music's own shortcuts (space = play/pause, …) from firing while typing.
    for (const type of ['keydown', 'keyup', 'keypress']) {
      search.addEventListener(type, (e) => {
        if (e.key !== 'Escape') e.stopPropagation();
      });
    }

    let debounce = 0;
    search.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        state.query = search.value;
        render();
      }, 120);
    });
    sort.addEventListener('change', () => {
      settings.sort = sort.value;
      saveSettings();
      render();
    });
    dir.addEventListener('click', () => {
      settings.desc = !settings.desc;
      saveSettings();
      render();
    });
    refresh.addEventListener('click', () => {
      if (state.pl) {
        cache.delete(state.pl.id);
        load(state.pl);
      }
    });
    close.addEventListener('click', () => setOpen(false));
    auto.addEventListener('change', () => {
      settings.autoOpen = auto.checked;
      saveSettings();
    });
    btn.addEventListener('click', () => setOpen(true));
    list.addEventListener('click', (e) => {
      const row = e.target.closest && e.target.closest('.ambz-row');
      if (row) play(Number(row.dataset.i));
    });

    document.body.append(btn, panel);
    ui = { search, sort, dir, status, list, panel, btn };
  }

  function setOpen(open) {
    state.open = open && !!state.pl;
    ui.panel.hidden = !state.open;
    ui.btn.hidden = state.open || !state.pl;
    if (state.open) {
      state.nowId = undefined;
      highlight();
    }
  }

  const fmtDur = (ms) => {
    if (!ms) return '';
    const s = Math.round(ms / 1000);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
  };
  const fmtTotal = (ms) => {
    const min = Math.round(ms / 60000);
    return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
  };

  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

  function computeView() {
    const terms = norm(state.query).split(/\s+/).filter(Boolean);
    let view = terms.length
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

  function updateStatus() {
    const { tracks, view } = state;
    if (state.error) ui.status.textContent = `Error: ${state.error}`;
    else if (state.loading) ui.status.textContent = state.progress || 'Loading…';
    else {
      const total = view.reduce((sum, t) => sum + t.dur, 0);
      const count = view.length === tracks.length ? `${tracks.length} songs` : `${view.length} of ${tracks.length} songs`;
      ui.status.textContent = `${count} · ${fmtTotal(total)}`;
    }
    ui.btn.textContent = state.loading ? (state.progress || 'Loading…') : `☰ All ${tracks.length} songs`;
    ui.dir.textContent = settings.desc ? '↓' : '↑';
  }

  function render() {
    state.view = computeView();
    state.rows = [];
    const frag = document.createDocumentFragment();
    state.view.forEach((t, i) => {
      const art = t.art
        ? h('img', { src: t.art, loading: 'lazy', decoding: 'async', alt: '' })
        : h('div', { class: 'ambz-noart' });
      const row = h('div', { class: t.playable ? 'ambz-row' : 'ambz-row ambz-off', 'data-i': String(i), title: `${t.title} – ${t.artist}` },
        h('div', { class: 'ambz-num' }, String(t.pos + 1)),
        art,
        h('div', null,
          h('div', { class: 'ambz-title' }, t.title),
          h('div', { class: 'ambz-artist' }, t.artist)),
        h('div', { class: 'ambz-album' }, t.album),
        h('div', { class: 'ambz-dur' }, fmtDur(t.dur))
      );
      state.rows.push(row);
      frag.append(row);
    });
    ui.list.textContent = '';
    if (!state.view.length && !state.loading) {
      ui.list.append(h('div', { class: 'ambz-empty' },
        state.error ? 'Could not load this playlist.' : state.tracks.length ? 'No matching songs.' : 'This playlist is empty.'));
    } else {
      ui.list.append(frag);
    }
    ui.list.scrollTop = 0;
    updateStatus();
    state.nowId = undefined;
    highlight();
  }

  function highlight() {
    if (!state.open) return;
    let id = null;
    try {
      const mk = getMK();
      const item = mk && mk.nowPlayingItem;
      if (item && item.id != null) id = String(item.id);
    } catch (e) { /* ignore */ }
    if (id === state.nowId) return;
    state.nowId = id;
    state.view.forEach((t, i) => {
      state.rows[i].classList.toggle('ambz-now', id !== null && (t.id === id || t.catalogId === id));
    });
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
      state.error = `playback failed (${errText(e)})`;
      updateStatus();
      state.error = '';
    }
  }

  function errText(e) {
    try {
      return String((e && (e.message || e.name)) || e);
    } catch (x) {
      return 'unknown error';
    }
  }

  // ---------------------------------------------------------------- loading / routing
  async function load(pl) {
    const loadId = ++state.loadId;
    state.error = '';
    state.progress = '';
    if (cache.has(pl.id)) {
      state.tracks = cache.get(pl.id);
      state.loading = false;
      render();
      return;
    }
    state.tracks = [];
    state.loading = true;
    render();
    try {
      const tracks = await loadAllTracks(pl, (done, total) => {
        if (loadId !== state.loadId) return;
        state.progress = total ? `Loading ${done} / ${total}…` : `Loading ${done}…`;
        updateStatus();
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
    render();
  }

  function onRoute() {
    const pl = parsePlaylist();
    if (pl && state.pl && pl.id === state.pl.id) return;
    state.pl = pl;
    state.query = '';
    ui.search.value = '';
    if (!pl) {
      state.loadId++;
      setOpen(false);
      return;
    }
    setOpen(!!settings.autoOpen);
    load(pl);
  }

  function init() {
    buildUI();

    window.addEventListener('keydown', (e) => {
      if (!state.pl) return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(true);
        ui.search.focus();
        ui.search.select();
      } else if (e.key === 'Escape' && state.open) {
        e.stopPropagation();
        setOpen(false);
      }
    }, true);

    // Apple Music is a single-page app; polling the URL is the one approach
    // that works identically in page and content-script contexts.
    setInterval(() => {
      if (location.href !== state.href) {
        state.href = location.href;
        onRoute();
      }
      highlight();
    }, 500);
  }

  init();
})();
