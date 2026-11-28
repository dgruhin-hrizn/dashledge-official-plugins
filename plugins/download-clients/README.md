# Downloads

Your SABnzbd, NZBGet and qBittorrent queues in one widget: how fast they're going, what's left, what just finished, and a pause or resume button for each client and each download.

## Connect your clients

In Widget Studio, open **Downloads** and add a connection for each client. Choose its type first:

| Type | Address | Credential |
|---|---|---|
| SABnzbd | The web interface, such as `http://sabnzbd.local:8080/` | The **API key** from Config → General. The NZB key isn't enough. |
| NZBGet | The web interface, such as `http://nzbget.local:6789/` | The **username and password** from Settings → Security, either the control or the restricted pair. |
| qBittorrent | The Web UI, such as `http://qbittorrent.local:8080/` | The Web UI **username and password** from Tools → Options → Web UI. |

**Test** reads each client's queue with what you entered, so a wrong key or password fails there and not on the dashboard. A placement shows up to four of your saved Downloads connections together.

## What it shows

- **The header:** how many are downloading and waiting, how much is left and roughly how long, and a status chip: **Live** while anything moves, **Up to date**, **Paused**, or amber with its age and **Retry** when a client stops answering.
- **Speed:** the total download speed of every client in large type, or **Paused** when they all are, over a graph of the last six minutes and its peak. The graph starts when the widget opens. Under it, each client: its product's tile, its name (the connection's name, else its address), its own speed or state, and **Pause** or **Resume**. A client that stops answering keeps its last queue on screen, marked with the error and its age, with **Retry**.
- **The queue:** every client's downloads as cards, downloading first, then unpacking or checking, stalled, queued and paused. Each card glows in its product's colour (SABnzbd yellow, NZBGet green, qBittorrent blue) and shows the state, the client when there are several, the name with its dots read as spaces, a progress rail with the percent, done of total, time left, and its own pause or resume button. Up to three share the width; more scroll sideways. With nothing in the queue, the last finished download is featured.
- **Finished:** recent completions and failures, newest first, with the reason a download failed.
- **States:** connecting, every client unavailable (with **Retry** and **Check connections**), nothing in the queue, paused and stale.

The full Edge sets speed, the queue and the finished list side by side, in the same design as Radarr. Between 1000 and 1600 pixels wide, speed stays and tabs switch between the queue and the finished list. Smaller placements show one at a time, with **Speed**, **Queue** and **Finished** tabs; a placement opens on the queue while something downloads, else on speed. Short placements put speed beside its clients, with any client that isn't answering first in the smallest.

## Settings (per placement)

- **Show recent finishes:** on by default.
- **Show torrents that are uploading:** off by default. qBittorrent torrents that have finished but are still sending to peers, fastest first.

## What it may do

| Grant | Why |
|---|---|
| Connection types SABnzbd, NZBGet and qBittorrent | One widget for all three. Each type sends its own credential, and only to its own address. |
| SABnzbd: the API key as `?apikey=` | How SABnzbd's API takes its key. Dashledge adds it to each request; the plugin never sees it. |
| NZBGet: Basic authentication | How NZBGet's JSON-RPC takes its username and password. |
| qBittorrent: sign-in at `api/v2/auth/login`, then its session cookie | How the qBittorrent Web API signs in. Dashledge keeps the session. |
| Up to 4 connections per placement | Several clients in one placement. |
| Connector, no other hosts | It reads only your clients' addresses: SABnzbd `api?mode=queue` and `mode=history`; NZBGet `status`, `listgroups` and `history`; qBittorrent `api/v2/sync/maindata`. |
| Commands `pause` and `resume` | The view's pause and resume buttons, for a whole client or one download: SABnzbd `mode=pause`, `mode=resume` and `mode=queue&name=pause`/`resume`; NZBGet `pausedownload`, `resumedownload` and `editqueue` `GroupPause`/`GroupResume`; qBittorrent `torrents/stop` and `start`, or `pause` and `resume` before qBittorrent 5. It never deletes a download or changes a setting. |
| qBittorrent's client **Pause** | qBittorrent has no pause for the whole client. Pause stops the torrents that are downloading at that moment and remembers which, and **Resume** starts exactly those again. Seeders and torrents you stopped yourself are never touched. The button offers Pause only while something downloads. |
| Command `refresh` | **Retry**: read one client, or all of them, again now. |
| `settings` | Each placement keeps its own two switches. |
| `ui` | Dashledge's look: its tokens, caption, button and state styles. |

It never reads a route that returns a client's own settings (SABnzbd `get_config`, NZBGet `config`, qBittorrent `app/preferences`), because those can include passwords. It logs only errors, never a reply.

## How it reads

The connector reads every client every 3 seconds, and SABnzbd and NZBGet history every 30. qBittorrent is read with `sync/maindata`: the first reply carries every torrent, and later ones only what changed. Dashledge caps a reply at 8 MiB, so a qBittorrent with many thousands of torrents may fail its first read; it shows that error and keeps trying. Each client's last good reading is stored once a minute, so a restart shows it at once, marked stale until the client answers.

## Limits

- A placement shows the connection you choose plus your other saved Downloads connections, up to four. It can't yet show only some of them.
- Each client is named by its connection's name, else its address. With several clients in one placement there is no single server name to show.

## Changes

- **1.1.0:** A new look, in the same design as Radarr: the total speed over a live graph, the queue as cards that glow in each product's colour with a progress rail, release names read as words, a status chip in the header, and tabs for smaller placements.
- **1.0.0:** First release: SABnzbd, NZBGet and qBittorrent in one placement, with pause and resume per client and per download.
