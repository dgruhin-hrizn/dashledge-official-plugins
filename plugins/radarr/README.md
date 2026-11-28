# Radarr

Your [Radarr](https://radarr.video) download queue, beside the movies coming out soon, with their posters. It connects to one Radarr server (v3 API or later, which includes Radarr 4 and 5) with its API key, which stays in Dashledge.

## What it shows

- **Header:** Radarr's mark and the server's name. Then the queue in figures, such as "2 downloading · 18.1 GB left · 1 needs attention". A status chip reads **Live** while something downloads (with a breathing dot), **Up to date**, or **Updated 12 min ago** with **Retry** when the data is stale.
- **Queue:** a card for each movie Radarr is downloading or importing, over the movie's fanart.
  - Each card shows the poster, a status eyebrow ("Downloading", "Can't import", "Failed"), the title, and its year, quality and download client.
  - Under them run a progress rail, what's done of the size, the time left, and the percent as the reading.
  - Problems show Radarr's own reason, in amber for a warning and red for a failure.
  - Downloading movies come first, soonest done first. Then come importing, problems, paused and queued.
  - Up to three cards share the width. More scroll sideways, the next one fading in at the edge.
  - With nothing downloading, the queue features the next release to come, over its artwork.
- **Coming up:** a shelf of posters for monitored movies with a cinema, digital or physical release in the days ahead.
  - Each movie appears once, at its next release. A chip on its poster says when: **Today** and **Tomorrow** in the accent colour, then "In 3 days", then the date. A badge gives the release type.
  - The caption gives the title, year and date, and any later release.
  - A movie that's downloading shows its progress along the poster's foot. One already downloaded shows a check.
  - A movie released in the last two weeks that Radarr calls available but has no file for comes first, marked **Missing**, with a **Search** button.
- **Layout:**
  - The full Edge, or any placement 1000 pixels wide or more, shows the queue and Coming up side by side. An idle queue gives Coming up more of the width.
  - A smaller placement shows one, with the other a tap away on the tabs at the top.
  - A tall, narrow placement stacks the cards and wraps the posters into a grid. A short one slims the header and captions.
  - Artwork keeps its space, with the title's initial, while it loads or when Radarr has none.
- **States:**
  - Connecting, and no server chosen (with **Choose a server**).
  - An empty queue, and nothing coming up (with **Change what's shown**).
  - Radarr unavailable, with Radarr's reason and **Retry**. A refused API key also offers **Check connection**.
  - Stale data after a failed refresh, or after a restart until Radarr answers: the last good data stays, and the status chip says how old it is.

## Settings (per placement)

- **Days ahead:** how far Coming up looks, 1 to 60 days. The default is 30.
- **Release dates:** which dates Coming up lists: in cinemas, digital, physical, or any of them (the default).
- **In a small placement, show:** which pane a small placement opens on. **Queue while something downloads** (the default) opens on the queue when something is downloading, else on Coming up.

## Connecting

In Widget Studio, add a connection with your **Radarr URL**, such as `http://radarr.local:7878/` (include a URL base like `/radarr/` if you use one), and your **API key** from Radarr's **Settings → General → Security**. **Test** reads `api/v3/system/status`. It passes only when Radarr answers with JSON, and a wrong key fails with HTTP 401. The widget names the server with the name you gave the connection, else Radarr's own instance name.

## What it may do

| Grant | Why |
|---|---|
| A connection (`X-Api-Key` header) | Reads your Radarr. Dashledge adds the key to requests for that address only, so the plugin never sees it. |
| Connector, no other hosts | It reads three routes, all read-only. `api/v3/system/status` gives the server's name, every 10 minutes. `api/v3/queue` gives the queue: every 5 seconds while something downloads, else every 30. `api/v3/calendar` gives releases from 14 days back to 61 ahead, every 15 minutes. It reaches nothing but your Radarr, and never the routes that return settings or keys. |
| Command `refresh` | **Retry**: reads all three routes again now. |
| Command `search` | **Search** on a missing movie. It sends Radarr's `MoviesSearch` command (`POST api/v3/command`) for that movie only. The connector refuses any movie that isn't monitored, released and missing, and repeats a search at most every 2 minutes. |
| `images` for `api/v3/mediacover/*/*` | Posters and fanart, from Radarr's own resized copies (`poster-500.jpg`, `fanart-360.jpg`), else the originals. Only artwork Radarr says it has is asked for. |
| `settings` | Each placement keeps its own days ahead, release dates and first pane. |
| `ui` | Dashledge's look: its tokens, panels, rows, buttons and state styles. |

One connector serves every placement on a connection. Placement settings reach only the view, so the connector always reads the widest window any placement may ask for, and each view filters it. The last good queue and calendar are stored, up to 256 KiB, so a restart shows them at once, marked stale until Radarr answers.

## Changes

- **1.0.0:** First release. The queue as cards over each movie's fanart, and Coming up as a shelf of posters. They sit side by side on the Edge, or a tap apart in a small placement. It searches for missing movies, and each placement chooses its days ahead, release dates and first pane.
