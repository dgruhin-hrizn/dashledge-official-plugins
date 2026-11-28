# Sonarr

Your [Sonarr](https://sonarr.tv) download queue over each series' artwork, beside a shelf of the episodes coming up. It works with Sonarr v3 and v4, which share the v3 API.

## What it shows

- **Header:** Sonarr's mark and the server's name. Then the queue in figures, such as "2 downloading · 5.4 GB left · 1 needs attention". A status chip reads **Live** while something downloads (with a breathing dot), **Up to date**, or **Updated 12 min ago** with **Retry** when the data is stale.
- **Queue:** a card for each download, over the series' fanart.
  - Each card shows the series poster, an eyebrow with the episode and what it's doing ("S02E10 · Downloading", "Season 1 · Importing", "Needs attention"), the series, and the episode title, quality and download client. A season pack's episodes share one card ("Season 1", "3 episodes").
  - Under them run a progress rail, what's done of the size, the time left, and the percent as the reading.
  - Problems show Sonarr's own reason, in amber for a warning and red for a failure.
  - Downloads come first, soonest done first. Then come importing, problems, paused and queued. Past 50 downloads the header says how many more Sonarr has.
  - Up to three cards share the width. More scroll sideways, the next one fading in at the edge.
  - With nothing downloading, the queue features the next episode to air, over its series' artwork.
- **Coming up:** a shelf of series posters, one for each episode airing from today through the days you choose, in this Mac's time zone.
  - A chip on the poster says when: **Today** and **Tomorrow** in the accent colour, then the weekday ("Wed"), then the date ("Dec 4"). The air time sits at the poster's foot.
  - Under the poster: the series and episode (`S02E05`), then the episode's title, with a season or series finale marked.
  - An episode that's downloading shows its percent in the chip and its progress along the poster's foot, or the queue's problem in amber. One already downloaded shows a check.
  - A monitored episode that has aired without a file comes first, marked **Missing**, with a **Search** button. After a tap it reads **Searching…** for a few minutes, or says why the search failed. Yesterday's episodes stay while they have no file, so last night's missed episode can still be searched in the morning.
- **Layout:**
  - The full Edge, or any placement 1000 pixels wide or more, shows the queue and Coming up side by side. An idle queue gives Coming up more of the width.
  - A smaller placement shows one, with the other a tap away on the tabs at the top.
  - A tall, narrow placement stacks the cards and wraps the posters into a grid. A short one slims the header and captions.
  - Artwork keeps its space, with the series' initial, while it loads or when Sonarr has none.
- **States:**
  - Connecting, and no connection chosen (with **Choose connection**).
  - An empty queue, and nothing airing (with **Change what's shown**).
  - Sonarr unavailable, with Sonarr's reason and **Retry**. A refused API key ("Sonarr refused the API key (HTTP 401)") also offers **Check connection**.
  - Stale data after a failed refresh, or after a restart until Sonarr answers: the last good data stays, and the status chip says how old it is.

## Connection

Add a connection with your **Sonarr URL**, such as `http://sonarr.local:8989/`, and its **API key**, from Sonarr's Settings › General › Security. Test reads `api/v3/system/status`: it passes on an HTTP 2xx JSON reply, and a wrong key gets HTTP 401. The server's own instance name (Settings › General) names the widget unless you name the connection.

## Settings (per placement)

- **Days ahead:** how far Coming up looks, counting today, 1 to 14. Default 7.
- **Hide downloaded episodes:** Coming up then lists only what you don't have yet.
- **In a small placement, show first:** Coming up or Queue. Tapping the other list switches until the placement's settings change.

## What it may do

| Grant | Why |
|---|---|
| A Sonarr connection, its key sent as `X-Api-Key` | Reads `api/v3/system/status` (the instance name), `api/v3/calendar` and `api/v3/queue`. Dashledge adds the key to those requests; the plugin never sees it. It never calls routes that echo secrets, such as `api/v3/config/*`. |
| Connector, with no outside hosts | Joins the calendar with the queue, keeps the last good reading across restarts, and runs Search. It reaches only the connection's address. |
| Connector command `watch` | A view on screen says so, and asks for a refresh on **Retry**. With nobody watching for 15 minutes, polling stops until a view asks again. |
| Connector command `search` | Sends Sonarr's `EpisodeSearch` command (`POST api/v3/command`) for one episode. The connector refuses any episode that isn't in the calendar, monitored, aired and missing. |
| `images`, for `api/v3/mediacover/*/poster*.jpg` and `api/v3/mediacover/*/fanart*.jpg` | Series posters and fanart from Sonarr's own cover cache: `poster-500.jpg` and `fanart-360.jpg`, or the full-size `poster.jpg` and `fanart.jpg` when Sonarr has no resized copy. Only for series Sonarr has that artwork for. |
| `settings` | Each placement keeps its days ahead, hidden downloads and first list. |
| `ui` | Dashledge's look: its tokens, panels, rows, buttons and state styles. |

It reads the queue every 10 seconds while something is downloading and every 30 seconds when it's empty. It reads the calendar every 5 minutes, and again soon after a download leaves the queue. It reads the status every 30 minutes. After a failure it waits 30 seconds, then 1, 2, 5 and 10 minutes. The connector stores the last reading, up to 128 KiB, and only for the server it came from.

## Changes

- **1.1.0:** The same design as the Radarr plugin: Sonarr's mark, queue figures and a live status chip in the header; queue cards over each series' fanart with a progress rail and sizes; and Coming up as a shelf of posters with day chips and Search on the poster. Cards show the quality and download client. The image grant adds `fanart*.jpg` (and the full-size `poster.jpg`), so existing users are asked to approve it.
- **1.0.0:** First release.
