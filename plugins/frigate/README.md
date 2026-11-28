# Frigate

Live video from your [Frigate](https://frigate.video) NVR on the Edge. One camera fills its placement, or several share it in a grid, each with what it detected last. Tap a camera in a grid to see it full size, and tap again to go back.

For fun, the **CRT security monitor** look puts every camera on an old curved tube in a monitor housing, with scanlines, a rolling hum bar, a blocky on-screen clock, and snow when a camera loses its signal. It comes in colour and in black and white.

## What it shows

- **Live video** through Frigate's go2rtc restream, for up to four cameras per placement at once. Small tiles play a camera's sub stream and large ones its main stream, H.264 or H.265.
- **Snapshots** about once a second for the other cameras, for cameras without a go2rtc stream, and when a placement chooses snapshots. A tile shows the latest frame at once and swaps to video when it plays.
- **Signal:** a camera Frigate gets no frames from says *No signal*, and one turned off in Frigate says so.
- **Wide cameras:** a dual-lens panorama shows whole over a blurred copy of itself, or fills its tile and lets you drag it to choose what shows. Snapshots are drawn at the camera's real shape, even when Frigate's detect size squashes them.
- **Detections:** what's in view now, highlighted, or the last thing seen in the past two hours, such as *Person · 3 min ago*. Frigate sub labels, such as a recognised face, are shown in place of the label.

A placement plays at most four cameras live, the first four in its order. Dashledge also limits how many streams it opens for one widget, so when several placements share a Frigate connection, a tile Dashledge refuses a stream shows snapshots and tries again every 30 seconds.

## Connecting

Choose how Dashledge reaches Frigate when you add the connection:

- **Signed in (port 8971 or a proxy).** Frigate's authenticated port, at home (`https://frigate.local:8971/`) or from outside through your proxy (`https://cameras.example.com/`). Enter a Frigate user's name and password. A user with the viewer role is enough. Frigate's own certificate on port 8971 is self-signed, and Dashledge accepts only certificates this Mac trusts: give Frigate a trusted one ([Frigate's TLS guide](https://docs.frigate.video/configuration/tls)), or set its certificate to **Always Trust** in Keychain Access.
- **On my network (port 5000, no sign-in).** Frigate's internal port, such as `http://frigate.local:5000/`. Anyone on your network can use it, so keep it off networks you don't trust.

Both work from anywhere Dashledge can reach the address. If you serve Frigate under a path, such as `https://example.com/frigate/`, include the path.

## Settings

Each placement keeps its own:

| Setting | What it does |
| --- | --- |
| Cameras | One camera, or several for a grid. Every camera on Frigate's dashboard by default. Tap **Check now** to look again. |
| Camera names | Your own name for a camera on this placement. |
| Several cameras as | An even grid, or one large camera with the rest beside it. |
| Look | Standard, CRT security monitor, or the black and white CRT. |
| Video | Live video, or a snapshot every second. |
| Video quality | Automatic, always the main stream, or always the sub stream. |
| Fit pictures | **Fill, but show very wide pictures whole** (a dual-lens panorama shows whole over a blurred copy of itself), **Fill, and drag a picture to choose what shows**, or **Show the whole picture**. Where you drag each camera is remembered for that camera on this Frigate. |
| Show detections | What each camera saw last. |

## What it may do

| Grant | Why |
| --- | --- |
| The Frigate connection, signed in or on port 5000 | Reads `api/config` (cameras and their go2rtc streams), `api/go2rtc/streams`, `api/stats` (each camera's frame rate) and `api/events` (recent detections). Camera inputs in `api/config`, which often hold the camera's password, stay in the connector and never reach the view. |
| Sign-in form `api/login` | For signed-in connections, Dashledge posts the saved user and password to Frigate's login and keeps the session cookie. The plugin never sees either. |
| Images `api/*/latest.jpg` | Each camera's latest frame, for snapshots and while video starts. |
| Stream `live/mse/api/ws?src={stream}` | Live video from go2rtc as fragmented MP4. |
| Settings, settings.choices | Each placement's cameras and look, and the list of cameras the settings offer. |
| ui | Dashledge's look. |

The connector reaches no host but the Frigate connection.

## Frigate versions

Tested against Frigate 0.15. It reads Frigate 0.16 and later's `live.streams` (the first stream is the main one, a stream named like *sub* is used for small tiles) and 0.14 and 0.15's `live.stream_name` (a go2rtc stream with the same name plus `_sub` is used for small tiles).

Cameras that Frigate plays with its jsmpeg player, because go2rtc doesn't restream them, show snapshots here.

## Changes

- **1.0.0:** First release: live video and snapshots for one camera or several, detections, and the CRT security monitor look.
