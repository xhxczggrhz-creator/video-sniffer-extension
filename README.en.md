# Video Sniffer

> A Manifest V3 browser extension that detects videos on web pages and downloads them fast:
> aria2-style dynamic segmentation, HLS/DASH streaming, MSE capture, audio/video track merging
> and screen recording.

**Version 4.5.1 · Plain HTTP only. No P2P / BitTorrent / magnet links. No telemetry.**

[中文说明](README.md) · [Changelog](CHANGELOG.md) · [Security Policy](SECURITY.md) · [Privacy](PRIVACY.md) · [i18n Guide](docs/i18n.md)

---

## Features

- **Sniffing** — auto-detects direct video URLs, HLS/DASH manifests, MSE
  (`MediaSource.appendBuffer`) captures and blob URLs, then lists them in one click.
- **Multi-threaded download** — an aria2-inspired dynamic segmentation engine: one file
  downloaded over several concurrent connections, every segment length-verified, retried
  individually (falls back to a direct connection only after 3 consecutive failures), with
  live progress.
- **Streaming** — HLS segments (including AES-128 decryption) and DASH streams at the best
  available quality; finished TS streams are remuxed into standard MP4 and degrade gracefully
  instead of producing a broken file.
- **Track merging** — separate video and audio tracks are merged into a single MP4.
- **MSE capture** — intercepts `appendBuffer` payloads directly, with ad stripping and
  size-limit protection. Recording mode captures what is playing, with speed-up support and
  black-frame warnings.
- **Search & sort, copy as `curl` / `aria2c` / `ffmpeg`** — when a page exposes dozens of
  tracks, filter and sort them; copy a ready-to-run download command with the right `Referer`.
- **Paste-a-URL download** — nothing detected, or the link is somewhere else? Paste the video
  or stream URL into the popup and press Enter.
- **File-name templates** — use `{title}`, `{site}`, `{quality}`, `{format}`, `{type}`,
  `{date}` and `{time}` in the custom file name.
- **Dark mode** — follows the system theme.

## Privacy

- Every download goes through **plain HTTP(S)** (service worker proxying or MSE capture).
  Any form of P2P / BitTorrent / magnet link is **hard-disabled in code**.
- Nothing is uploaded anywhere. Sensitive payloads (hotlink-signed URLs, cookies, DRM-related
  credentials) live only in `chrome.storage.session` — session-scoped, cleared on read, never
  written to disk.

## Install (load unpacked)

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this repository's root directory.
3. Requires Chrome 111 or newer (Manifest V3).

> You can also grab `video-sniffer-<version>.zip` from
> [Releases](https://github.com/xhxczggrhz-creator/video-sniffer-extension/releases),
> unzip it, and load it the same way (a SHA256 checksum is published alongside).

## Usage

1. Open a page with a video and click the extension icon (`Alt+Shift+V` also opens it).
2. Detected resources appear in the list — direct links, stream manifests and MSE captures.
3. Click **Download** to open the download manager page; stream entries pick the best quality
   and download segment by segment.

## Project layout

```
video-sniffer-extension/
├── background/service-worker.js   # MV3 worker: state machine, message bus, DNR, stream proxy, scheduling
├── content/                       # Content scripts (mse-hook / media-sniffer / content-script)
├── lib/                           # Core libraries + i18n + vendored mp4box / ts-mux
├── download-page/                 # Download manager UI (engine, remux, merge)
├── popup/                         # Toolbar popup
├── offscreen/                     # Offscreen document
├── _locales/{zh_CN,en}/           # Message catalogs (add a language by adding a folder)
├── docs/i18n.md                   # How to translate / add a locale
├── scripts/                       # check-js (syntax gate) · i18n-check (catalog gate) · package
├── tests/                         # Regression & unit tests
└── .github/                       # Issue/PR templates + CI workflow
```

## Development

Zero runtime dependencies — `npm install` only enables the npm scripts.

```bash
npm install
npm run lint            # syntax gate for every hand-written JS file (ESM/CJS aware)
npm test                # unit regression: test-validate + test-merger
npm run test:security   # security regression: SSRF IP-literal bypass protection
npm run test:i18n       # i18n gate: catalog/code key parity, placeholder parity
npm run package         # produces dist/video-sniffer-<version>.zip + SHA256
```

## Translations

Adding a language means adding one JSON file — no code change, no build step.
See [`docs/i18n.md`](docs/i18n.md).

## Support

If this project helps you, you are welcome to scan the donation QR code in the Chinese README.
Donations are **purely voluntary**, unrelated to any feature, grant no paid privileges, and do
not affect the project's continued open-source development.

## Disclaimer

**Read this before using the extension. Installing or using it means you have read, understood
and accepted all of the following.**

1. **Intended use** — for personal study, research and technical exchange only, and only for
   media you are entitled to access and download. Commercial use, illegal profiteering,
   piracy and distribution are prohibited.
2. **Copyright** — download, save or reuse content only with the rightsholder's permission or
   where the law clearly allows it. Whether you have that permission is **your own
   responsibility**.
3. **No affiliation** — this is an independent technical tool with **no affiliation,
   authorization, sponsorship or agency relationship** with any video platform or content
   producer. It does **not** bypass paywalls, membership tiers or DRM.
4. **User responsibility** — you bear all consequences of your use. The authors accept no
   liability for misuse, loss or disputes.
5. **No warranty** — provided "AS IS", without warranty of any kind, express or implied,
   including merchantability, fitness for a particular purpose and non-infringement.
6. **Supporters** — donations are voluntary and constitute no transaction, service or privilege.
7. **Takedown** — if any part of this project is found to infringe third-party rights,
   rightsholders may contact us through a repository issue and we will cooperate, up to and
   including removal of the relevant content.

> Consult a qualified lawyer if you are unsure. All rights reserved by the project author.

## License

[MIT](LICENSE)
