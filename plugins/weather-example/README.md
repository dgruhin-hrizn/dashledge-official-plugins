# Weather (example)

Current conditions and the next 24 hours from [Open-Meteo](https://open-meteo.com), for a place each placement chooses. It's Dashledge's reference first-party plugin: small enough to read in one sitting, and built to every rule in this repository's `AGENTS.md`.

## What it shows

- **Now:** the temperature, conditions, feels-like, today's high and low, and wind.
- **Next 24 hours:** a temperature line with every third hour labelled. It sits beside the reading on the wide Edge, below it in a tall placement, and is dropped when a placement is too small.
- **States:** no place chosen (with **Choose a place**), loading, a place Open-Meteo doesn't know, a failed first load (with **Retry**), and a stale reading after a failed refresh ("Last updated 12 min ago", with **Retry**).

## Settings (per placement)

- **Location:** a city such as `Chicago`, `Portland, OR` or `Paris, France`, or coordinates such as `41.88, -87.63`.
- **Temperature:** Fahrenheit or Celsius. Wind follows it, in mph or km/h.

## What it may do

| Grant | Why |
|---|---|
| Connector hosts `https://api.open-meteo.com` and `https://geocoding-api.open-meteo.com` | Forecasts and place search. Open-Meteo needs no account or key. |
| `settings` | Each placement keeps its own location and units. |
| `ui` | Dashledge's look: its tokens, reading, panel, button and state styles. |

It needs no connection. One connector serves every placement: each view asks for its place with the `watch` command while it's on screen. Places nobody has asked about for 15 minutes are dropped, and at most 16 are kept. The last good forecast for each place is stored, so a restart shows it at once.

## Changes

- **1.1.0:** First release built to the first-party spec, from this repository. It adds a location and units per placement, where 1.0.0 always showed Cupertino in °C. It also uses Dashledge's `ui` kit and colours, the native viewport, and adds the next 24 hours. Updating asks for approval once, because the `ui` and `settings` grants are new.
- **1.0.0:** The author guide's example, published as-is.
