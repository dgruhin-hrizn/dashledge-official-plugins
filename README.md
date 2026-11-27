# Dashledge official plugins

The first-party plugins for [Dashledge](https://github.com/dgruhin-hrizn/dashledge). Each one ships through the [Dashledge Marketplace](https://github.com/dgruhin-hrizn/dashledge-plugins) like any outside author's plugin: a tagged release here, then a listing in the registry that a maintainer reviews.

## Layout

```
plugins/<name>/        one plugin per folder
  widget.json          id plugin.dashledge.<name>, version x.y.z
  view/ connector.js icon.svg README.md …
scripts/check.sh       packs and checks every plugin (CI runs it)
scripts/release.sh     packs one plugin and creates its GitHub release (CI runs it)
```

A plugin's folder name is its ID's last part: `plugins/download-clients/` is `plugin.dashledge.download-clients`. Build plugins with the [author guide](https://github.com/dgruhin-hrizn/dashledge/blob/main/widgets/README.md). Plugins in this repository are never Node collectors: if a widget needs this Mac itself, it stays bundled in Dashledge.

## Checks

Every pull request and push to `main` builds `dashledge-package` from the Dashledge source and runs `scripts/check.sh`. For each plugin it:

- requires the ID `plugin.dashledge.<folder>` and a version such as `1.2.0`;
- packs the folder with `dashledge-package pack`, which applies the same rules as the app and Widget Studio's Submit to Marketplace and makes the same bytes every time;
- refuses a change to a version that's already released. Packing the folder as it was at the release tag must give the same package, or the version has to go up.

The packed ZIPs are attached to each run as the `packages` artifact, so you can install a build with **Install from file** before releasing it.

## Releasing a plugin

1. Raise `version` in the plugin's `widget.json` and merge it to `main`.
2. Tag that commit `<folder>-v<version>` and push the tag:

   ```sh
   git tag download-clients-v1.0.0 && git push origin download-clients-v1.0.0
   ```

3. The release workflow checks that the tag and `widget.json` agree, packs the plugin and creates a GitHub release with `<folder>-<version>.zip`. It never replaces a published ZIP, because its listing pins the sha256.
4. The release notes hold the registry listing. Add it to [dashledge-plugins](https://github.com/dgruhin-hrizn/dashledge-plugins) as `listings/plugin.dashledge.<folder>/<version>.json` in a pull request. After it merges, the plugin appears in the Marketplace within a few minutes.

## Building the checker locally

```sh
git clone https://github.com/dgruhin-hrizn/dashledge.git ../dashledge
cargo build --release --manifest-path ../dashledge/src-tauri/package-core/Cargo.toml --bin dashledge-package
DASHLEDGE_PACKAGE=../dashledge/src-tauri/target/release/dashledge-package bash scripts/check.sh
```

`DASHLEDGE_REF` in both workflows names the Dashledge branch or commit the checker is built from.
