# Sonarr

Upcoming episodes and the download queue from your [Sonarr](https://sonarr.tv) server, with series posters. It works with Sonarr v3 and v4, which share the v3 API.

## What it shows

- **Upcoming:** episodes airing from today through the days you choose, in this Mac's time zone. Each row shows the series poster and name, the episode (`S02E05 · Title`, with a season or series finale marked), and when it airs ("Today · 9:00 PM", "Tomorrow", "Wed", or "Fri, Dec 4" further out). It also shows what the episode is doing:
  - **Downloaded**;
  - **Downloading 45%**, from the queue, or the queue's problem when it has one;
  - **Missing**, for a monitored episode that has aired without a file, with a **Search** button;
  - **Searching…** for a few minutes after you tap Search;
  - nothing yet, for one still to air.
- **Queue:** what Sonarr is downloading, one row per download. A season pack's episodes share one row ("Season 1 · 10 episodes"). Rows show a progress bar, percent and time left, or Paused, Queued, Delayed, Importing, Needs attention or Failed with Sonarr's reason. Problems come first, then downloads by time left. Past 50 downloads it says how many more Sonarr has.
- **Layout:** the full Edge shows Upcoming and Queue side by side. A smaller placement shows one, with a button for each and its count, so the other is a tap away. A short placement drops the posters and detail lines before shrinking anything.
- **States:**
  - a placement with no connection, with **Choose connection**;
  - connecting and loading;
  - a wrong API key ("Sonarr refused the API key (HTTP 401)"), with **Check connection** and **Retry**;
  - Sonarr unavailable or answering with an error, with **Retry**;
  - nothing airing, nothing downloading;
  - stale: the last reading stays on screen after a failed refresh, with "Last updated 5 min ago · Sonarr answered HTTP 503" and **Retry**.

## Connection

Add a connection with your **Sonarr URL**, such as `http://sonarr.local:8989/`, and its **API key**, from Sonarr's Settings › General › Security. Test reads `api/v3/system/status`: it passes on an HTTP 2xx JSON reply, and a wrong key gets HTTP 401. The server's own instance name (Settings › General) names the widget unless you name the connection.

## Settings (per placement)

- **Days ahead:** how far Upcoming looks, counting today, 1 to 14. Default 7.
- **Hide downloaded episodes:** Upcoming then lists only what you don't have yet.
- **In a small placement, show first:** Upcoming or Queue. Tapping the other list switches until the placement's settings change.

## What it may do

| Grant | Why |
|---|---|
| A Sonarr connection, its key sent as `X-Api-Key` | Reads `api/v3/system/status` (the instance name), `api/v3/calendar` and `api/v3/queue`. Dashledge adds the key to those requests; the plugin never sees it. It never calls routes that echo secrets, such as `api/v3/config/*`. |
| Connector, with no outside hosts | Joins the calendar with the queue, keeps the last good reading across restarts, and runs Search. It reaches only the connection's address. |
| Connector command `watch` | A view on screen says so, and asks for a refresh on **Retry**. With nobody watching for 15 minutes, polling stops until a view asks again. |
| Connector command `search` | Sends Sonarr's `EpisodeSearch` command (`POST api/v3/command`) for one episode. The connector refuses any episode that isn't in the calendar, monitored, aired and missing. |
| `images`, for `api/v3/mediacover/*/poster-*.jpg` | Series posters from Sonarr's own cover cache, at `poster-250.jpg`. |
| `settings` | Each placement keeps its days ahead, hidden downloads and first list. |
| `ui` | Dashledge's look: its tokens, panels, rows, buttons and state styles. |

It reads the queue every 10 seconds while something is downloading and every 30 seconds when it's empty. It reads the calendar every 5 minutes, and again soon after a download leaves the queue. It reads the status every 30 minutes. After a failure it waits 30 seconds, then 1, 2, 5 and 10 minutes. The connector stores the last reading, up to 128 KiB, and only for the server it came from.

## Changes

- **1.0.0:** First release.
