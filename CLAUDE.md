# CLAUDE.md

## Language

- All project content is **English only**: UI text, code comments, log messages, README and other docs.
- There is no German (or other) version; do not add translations or i18n.
- Dates/times are formatted with the `en-GB` locale (24-hour clock, day/month/year).
- Chat with the user may be in German; this rule applies to files in the repository.

## Project

Static web app (no build step) that syncs the clock of Xiaomi MJWSD05MMC thermometers via Web Bluetooth.
Based on pvvx's Telink BLE OTA Flasher; see `README.md` for protocol details and references.

- `index.html` – Bootstrap 5.3 UI (loaded from CDN), mobile-first, kept plain and simple
- `js/ble-clock.js` – BLE protocol (`ClockDevice`)
- `js/app.js` – UI logic
- Reading and setting the time is always triggered by the user; nothing happens automatically after connecting.

Run locally with `python -m http.server 8000` and open http://localhost:8000.
