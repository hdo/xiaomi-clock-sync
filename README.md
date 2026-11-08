# MJWSD05MMC Clock Sync

A lightweight web app to sync the clock of **Xiaomi MJWSD05MMC** thermometers via Bluetooth (Web Bluetooth).
Derived from the [Telink BLE OTA Flasher](https://pvvx.github.io/ATC_MiThermometer/TelinkMiFlasher.html) by
[pvvx](https://github.com/pvvx), reduced to the clock function, built with Bootstrap 5 and optimized for smartphones.

## Features

- Device search limited to MJWSD05MMC (name filter `BTH_`, `BTE_`, `MJWSD05MMC`, adjustable under “Advanced”)
- Read the device time and show the offset from the computer/phone time
- Set the time with one click (aligned to the full second)
- List of recently synced devices (stored locally in the browser)
- Light/dark theme following the system setting

## Usage

1. Click **Find device** and select the thermometer in the browser dialog.
2. Optionally click **Read time from device** to see the current offset.
3. Click **Sync time**. The time is then read again for verification.

Nothing is read or set automatically after connecting; both actions are triggered by the user.

## Supported firmware

| Firmware | Device name | Protocol |
|---|---|---|
| pvvx custom firmware (recommended) | `BTH_xxxxxx` (ch), `BTE_xxxxxx` (en) | Service `0x1F10`, char. `0x1F1F`, command `0x23` + local time (uint32 LE) |
| Stock Xiaomi | `MJWSD05MMC` | Char. `ebe0ccb7-…` (UTC uint32 LE + time zone). May require a Mi login depending on the firmware version; untested |

## Running

Web Bluetooth requires a secure context (`https://` or `localhost`) and Chrome/Edge (desktop or Android).
On iOS it only works with the “Bluefy” app.

Locally:

```bash
python -m http.server 8000
```

Then open <http://localhost:8000>. To use it on a smartphone, publish the project, e.g. via GitHub Pages.

## Files

- `index.html` – user interface (Bootstrap 5.3)
- `js/ble-clock.js` – BLE protocol (connect, read/set time)
- `js/app.js` – UI logic
- `css/app.css` – a few custom styles
- `manifest.webmanifest`, `icons/` – web app manifest and home-screen icons (SVG sources plus rendered PNGs)

## Home screen

In Chrome on Android, open the page and choose **Add to home screen** / **Install app**.
The app then starts in its own window with the clock icon. If a shortcut was created before the icon existed,
remove it and add it again.

## References

- [pvvx](https://github.com/pvvx) – author of the custom firmware and the original flasher
- [ATC_MiThermometer](https://github.com/pvvx/ATC_MiThermometer) – the original project: custom firmware for Xiaomi and other Telink BLE thermometers, including the MJWSD05MMC
- [Telink BLE OTA Flasher](https://pvvx.github.io/ATC_MiThermometer/TelinkMiFlasher.html) – the web flasher this project is based on ([source](https://github.com/pvvx/pvvx.github.io/tree/master/ATC_MiThermometer))
- [MJWSD05MMC device page](https://pvvx.github.io/MJWSD05MMC) – pvvx documentation for this device
- [Device IDs](https://pvvx.github.io/) – overview of the devices supported by pvvx
- [Lucide](https://lucide.dev/) – the app icon uses the “history” glyph (ISC license)
