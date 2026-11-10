# ambz

Userscripts for the Apple Music web app (music.apple.com). Both load a playlist's complete song list at once through Apple Music's own API and add search and sorting.

## Versions

**v1 (0.1.1) – `ambz.user-v1.js`: side panel**

- Full list in a panel on the right, opened automatically or via the red button at the bottom right.
- Search box and sort dropdown inside the panel.
- Single click on a row plays the song.
- Apple's own list stays untouched underneath.

**v2 (0.2.2) – `ambz.user-v2.js`: built into the page**

- Full list replaces Apple's list in place and copies its look and column layout.
- Search field and sort button sit in the header row next to play and shuffle; column headers sort too.
- Double-click a row or click its artwork to play, as in Apple's list.
- No "…" menu per song. Use "Originalliste anzeigen" in the sort menu to get Apple's list back for removing or reordering songs.

## Both versions

- Ctrl+F focuses the search; Esc clears or closes it.
- Starting a song queues up to 200 songs around it in the order shown (`QUEUE_MAX` at the top of the script).
- Both files share the same script name, so installing one in Violentmonkey replaces the other.

## Install

1. In the Apple Music web app press Ctrl+Shift+A and install **Violentmonkey**.
2. Serve this folder: `python3 -m http.server 8765 --bind 127.0.0.1`
3. Violentmonkey dashboard → **+** → **Install from URL** → `http://127.0.0.1:8765/ambz.user-v2.js` (or `-v1.js`).
4. Stop the server and reload Apple Music with F5.

If something breaks, press Ctrl+Shift+K in the web app and look for lines starting with `[ambz]`.
