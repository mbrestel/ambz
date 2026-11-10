# ambz

Userscripts for the Apple Music web app (music.apple.com). Both load a playlist's complete song list at once through Apple Music's own API and add search and sorting.

## Versions

**v1 (0.1.1) – `ambz.user-v1.js`: side panel**

- Full list in a panel on the right, opened automatically or via the red button at the bottom right.
- Search box and sort dropdown inside the panel.
- Single click on a row plays the song.
- Apple's own list stays untouched underneath.

**v2 (0.4.0) – `ambz.user-v2.js`: built into the page**

- Full list replaces Apple's list in place and copies its look and column layout.
- Search field and sort button sit in the header row next to play and shuffle; column headers sort too.
- Double-click a row or click its artwork to play, as in Apple's list.
- Song title, artist and album are links to their pages (opened inside the app, playback keeps running).
- "…" button and right-click menu per song: play next, play last, add to playlist, add to library, favourite, go to song/album/artist, copy link, copy Spotify link, remove from playlist (own playlists only).
- Reordering songs is not built in. Use "Originalliste anzeigen" in the sort menu to get Apple's list back for that.

### Spotify link (v2)

"Spotify-Link kopieren" looks the song up through Spotify's Web API by its ISRC. One-time setup:

1. Create an app at <https://developer.spotify.com/dashboard> (any name; redirect URI can be `http://127.0.0.1`; API: Web API).
2. On first use the script asks for the app's Client ID and Client Secret and keeps them in Violentmonkey's storage.

If the song isn't found, a Spotify search link is copied instead. Wrong credentials are forgotten automatically, so the next click asks again.

## Both versions

- Ctrl+F focuses the search; Esc clears or closes it.
- Starting a song queues up to 200 songs around it in the order shown (`QUEUE_MAX` at the top of the script).
- The two files have different script names, so Violentmonkey can hold both. Enable only one at a time.

## Install

1. In the Apple Music web app press Ctrl+Shift+A and install **Violentmonkey**.
2. Serve this folder: `python3 -m http.server 8765 --bind 127.0.0.1`
3. Violentmonkey dashboard → **+** → **Install from URL** → `http://127.0.0.1:8765/ambz.user-v2.js` (or `-v1.js`).
4. Stop the server and reload Apple Music with F5.

If something breaks, press Ctrl+Shift+K in the web app and look for lines starting with `[ambz]`.
