# Dashledge official plugins

The first-party plugins for [Dashledge](https://github.com/dgruhin-hrizn/dashledge): Dashledge's own, shown in the Marketplace as **by Dashledge**. Each one ships through the [Dashledge Marketplace](https://github.com/dgruhin-hrizn/dashledge-plugins): a tagged release here, then a listing in the registry that a maintainer reviews.

Every plugin here meets the **first-party spec** in [AGENTS.md](AGENTS.md). It requires a complete manifest, Dashledge's look (the `ui` kit, theme colours, native viewport), a README with every grant explained, and tests against recorded server replies. CI enforces what a script can check. Third-party plugins live in their authors' own repositories.

## Layout

```
plugins/<name>/        one plugin per folder: exactly what ships
  widget.json          id plugin.dashledge.<name>, version x.y.z
  view/ connector.js icon.svg README.md …
tests/<name>.test.mjs  the plugin's tests (never shipped)
tests/<name>/          recorded server replies for them
tests/harness.mjs      runs a connector or view script the way Dashledge does
scripts/check.sh       spec checks, packing and tests for every plugin (CI runs it)
scripts/release.sh     packs one plugin and creates its GitHub release (CI runs it)
```

A plugin's folder name is its ID's last part: `plugins/download-clients/` is `plugin.dashledge.download-clients`. Build plugins with the [author guide](https://github.com/dgruhin-hrizn/dashledge/blob/main/widgets/README.md). Plugins in this repository are never Node collectors: if a widget needs this Mac itself, it stays bundled in Dashledge.

## Checks

Every pull request and push to `main` builds `dashledge-package` from the Dashledge source and runs `scripts/check.sh`. For each plugin it:

- requires the ID `plugin.dashledge.<folder>` and a version such as `1.2.0`;
- checks every first-party spec item a script can: manifest fields, the `ui` kit, theme and native viewport, `minAppVersion`, a README naming each connector host, and a test file;
- packs the folder with `dashledge-package pack`, which applies the same rules as the app and Widget Studio's Submit to Marketplace and makes the same bytes every time;
- refuses a change to a version that's already released. Packing the folder as it was at the release tag must give the same package, or the version has to go up;
- runs `node --test tests/*.test.mjs`.

The packed ZIPs are attached to each run as the `packages` artifact, so you can install a build with **Install from file** before releasing it.

## Releasing a plugin

1. Raise `version` in the plugin's `widget.json` and merge it to `main`.
2. Tag that commit `<folder>-v<version>` and push the tag:

   ```sh
   git tag download-clients-v1.0.0 && git push origin download-clients-v1.0.0
   ```

3. The release workflow runs the same checks and tests as a pull request. It refuses a tag that isn't on `main`, or one that disagrees with `widget.json`. It then packs the plugin and creates a GitHub release with `<folder>-<version>.zip`. It never replaces a published ZIP, because its listing pins the sha256.
4. The release notes say what changed and what existing users must approve. They take the version's line from the plugin README's **Changes** list, which CI requires. They also compare this version's grants with the previous release's, then list the new ones or say there are none.
5. The release notes hold the registry listing, with the Changes line as its `notes`. Add it to [dashledge-plugins](https://github.com/dgruhin-hrizn/dashledge-plugins) as `listings/plugin.dashledge.<folder>/<version>.json` in a pull request. After it merges, the plugin appears in the Marketplace within a few minutes.

## Building the checker locally

```sh
git clone https://github.com/dgruhin-hrizn/dashledge.git ../dashledge
cargo build --release --manifest-path ../dashledge/src-tauri/package-core/Cargo.toml --bin dashledge-package
DASHLEDGE_PACKAGE=../dashledge/src-tauri/target/release/dashledge-package bash scripts/check.sh
```

`DASHLEDGE_REF` in both workflows names the Dashledge branch or commit the checker is built from.

## License

MIT. See [LICENSE](LICENSE).
