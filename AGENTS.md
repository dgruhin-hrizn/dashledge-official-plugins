# Dashledge first-party plugins

Everything in this repository is a **first-party** Dashledge plugin: Dashledge's own, shown in the Marketplace as **by Dashledge** with a Dashledge badge. Every plugin the Dashledge project builds lives here, under `plugins/<name>/`, and meets the spec below. Third-party plugins live in their authors' own repositories and reach the Marketplace through the registry's review. They never come here.

The Dashledge repository's `AGENTS.md` (section *First-party and third-party plugins*) explains how the two differ in the app. Its *Widget design principles* and *Widget settings* sections apply to every plugin here in full. Build with its [author guide](https://github.com/dgruhin-hrizn/dashledge/blob/main/widgets/README.md) and [package architecture](https://github.com/dgruhin-hrizn/dashledge/blob/main/docs/widget-packages.md).

## Commands

- `DASHLEDGE_PACKAGE=<path to dashledge-package> bash scripts/check.sh`: the spec checks, packing and every test. CI runs it on every pull request and push. The README shows how to build `dashledge-package`.
- `node --test tests/*.test.mjs`: the tests alone.
- To try a plugin in Dashledge, use Widget Studio's **Load unpacked package** on `plugins/<name>/`.

## The first-party spec

`scripts/check.sh` enforces the items marked **(CI)**. Reviewers check the rest before merging.

### Identity and shipping

- **(CI)** The ID is `plugin.dashledge.<folder>`. The folder name is lowercase words joined by hyphens, and is never renamed after a release.
- **(CI)** `version` is semver. Raise it for any change to what ships. A released version's package never changes.
- Release with a tag `<folder>-v<version>` on `main`. The release workflow packs it with `dashledge-package pack` and creates the GitHub release. Never upload a ZIP by hand, and never Submit from Widget Studio.
- List it in [dashledge-plugins](https://github.com/dgruhin-hrizn/dashledge-plugins) with the listing from the release notes, in a maintainer's pull request.

### Manifest

- **(CI)** `description`, `category`, an SVG `icon`, `"license": "MIT"`, and `homepage` set to `https://github.com/dgruhin-hrizn/dashledge-official-plugins/tree/main/plugins/<folder>`.
- **(CI)** `minAppVersion` is at least `0.9.0`. Raise it to the first Dashledge release with every platform piece the plugin uses.
- Use an existing category where one fits: Music & media, Productivity, Clocks, Finance, Servers & storage, AI & development.
- Declare only what the plugin uses. Every host, image route, stream, command and permission is a grant the user approves, and an update that adds one waits for their approval.

### The Dashledge look

- **(CI)** `permissions` includes `"ui"`, and `view` sets `"theme": true` and `"viewport": "native"`.
- Build the view from the kit: `body.dl-surface`, `dl-panel`, `dl-caption`, `dl-reading` with `dl-unit`, `dl-list` with `dl-row`, `dl-button`, and `dl-loading`, `dl-empty` and `dl-error` for states. Take colour and size from the `--dl-*` tokens, never your own palette. Brand colours that identify a service or its data, such as a status or a product's mark, are the exception.
- Size with `--dl-*` tokens and `calc(… * var(--dl-scale))`, so a placement keeps its physical size at the native viewport. Lay out for the full Edge (2560 × 720) and a compact placement. Stack, or drop secondary detail, before shrinking the reading.
- Hit areas are at least `var(--dl-tap)`. Label icon buttons, and show pressed and focus states (the kit's `dl-button` does).
- Use tabular digits and reserve space for live values. Distinguish loading, empty, unavailable and stale.

### Behaviour

- Get data declaratively (`data` and `actions`), or with a connector when it needs joins, sockets, state or long operations. Never a collector.
- Name servers with `Dashledge.displayName()`. Never hardcode a server, host or place.
- When one plugin serves several products, give each its own entry in `sources.types`, with its own auth and Test.
- A placement that needs a choice before it can work shows it: an empty state whose button calls `Dashledge.settings.open()`. Failures offer **Retry**, or the connection's fix.
- Credentials stay in Dashledge. Never ask for one in a setting, and never log a reply that could echo one.
- A connector that serves several placements keys its work by what they asked for, not by placement, and forgets what nobody has asked about for a while.

### Documentation and tests

- **(CI)** `plugins/<folder>/README.md` covers what it shows, its settings, and a table of every grant with why it's needed. It names each connector host. Keep a **Changes** list with a line per version.
- **(CI)** `tests/<folder>.test.mjs` runs with `node --test`, with recorded server replies in `tests/<folder>/`. `tests/harness.mjs` runs a connector the way Dashledge does: only its declared hosts and connections, a clock the test moves, and storage that survives a restart.
  - Cover the main reply, every state the view distinguishes, a failure and its retry, and a restart.
  - Record replies from a real server, and strip anything personal from them first.
- Keep tests and samples out of `plugins/<folder>/`: `pack` ships every allowed file in the folder.
- Put a view's pure logic in its own script, such as `view/model.js`, so `loadViewScript` can test it.

### Before a release

- Load the folder unpacked in Dashledge and exercise it at the full Edge and in a compact placement. Try a long real name, an empty or missing choice, a failure, and a live refresh.
- Release notes say what changed and which new grants, if any, will ask existing users for approval.

## Adding a plugin

1. Create `plugins/<folder>/` with `widget.json`, `icon.svg`, `README.md` and the view, plus a connector if it needs one.
2. Record replies into `tests/<folder>/` and write `tests/<folder>.test.mjs` with the harness.
3. Run `scripts/check.sh`, open a pull request, and merge once CI and a review pass.
4. Tag and list it as above.

A plugin that replaces a bundled Dashledge widget also needs a Dashledge pull request. It retires the bundled package and carries over existing placements and saved connections.
