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

- **The reading:** the total download speed of every client, or **Paused** when they all are. Beneath it, the number downloading and waiting, how much is left, and roughly how long.
- **Each client:** its name (the connection's name, else its address), its own speed or state, and **Pause** or **Resume**. A client that stops answering keeps its last queue on screen, marked with the error and its age, with **Retry**.
- **The queue:** every client's downloads in one list, downloading first, then unpacking or checking, stalled, queued and paused. Each row shows progress, done of total, time left or state, and its own pause or resume button. A coloured mark on each row says which product it came from.
- **Finished:** recent completions and failures, newest first, with the reason a download failed.
- **States:** connecting, every client unavailable (with **Retry**), nothing in the queue, paused and stale.

The full Edge sets the reading and clients, the queue, and the finished list side by side. Smaller placements stack them and drop the finished list first. The smallest tiles keep only the reading and the clients, with any client that isn't answering at the top.

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
| `ui` | Dashledge's look: its tokens, reading, panel, list, button and state styles. |

It never reads a route that returns a client's own settings (SABnzbd `get_config`, NZBGet `config`, qBittorrent `app/preferences`), because those can include passwords. It logs only errors, never a reply.

## How it reads

The connector reads every client every 3 seconds, and SABnzbd and NZBGet history every 30. qBittorrent is read with `sync/maindata`: the first reply carries every torrent, and later ones only what changed. Dashledge caps a reply at 8 MiB, so a qBittorrent with many thousands of torrents may fail its first read; it shows that error and keeps trying. Each client's last good reading is stored once a minute, so a restart shows it at once, marked stale until the client answers.

## Limits

- A placement shows the connection you choose plus your other saved Downloads connections, up to four. It can't yet show only some of them.
- Each client is named by its connection's name, else its address. With several clients in one placement there is no single server name to show.

## Changes

- **1.0.0:** First release: SABnzbd, NZBGet and qBittorrent in one placement, with pause and resume per client and per download.
