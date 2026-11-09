# Technical Notes: Time Synchronization Protocol

This document describes how Xiaomi Clock Sync reads and sets the clock of the supported thermometers over
Bluetooth Low Energy (BLE). It covers both the **pvvx custom firmware** and the **stock Xiaomi firmware**.

The protocol details come from the [Telink BLE OTA Flasher](https://pvvx.github.io/ATC_MiThermometer/TelinkMiFlasher.html)
by pvvx, the [ATC_MiThermometer](https://github.com/pvvx/ATC_MiThermometer) firmware sources, and
[bluetooth-clocks](https://github.com/koenvervloesem/bluetooth-clocks) for the older LYWSD02. The implementation is in
[`js/ble-clock.js`](js/ble-clock.js).

## Contents

1. [Supported devices](#1-supported-devices)
2. [Time representations](#2-time-representations)
3. [Connection and firmware detection](#3-connection-and-firmware-detection)
4. [pvvx custom firmware](#4-pvvx-custom-firmware)
5. [Stock Xiaomi firmware](#5-stock-xiaomi-firmware)
6. [Sync procedure in the app](#6-sync-procedure-in-the-app)
7. [Offset calculation and display](#7-offset-calculation-and-display)
8. [Web Bluetooth specifics](#8-web-bluetooth-specifics)
9. [Errors and limitations](#9-errors-and-limitations)
10. [Quick reference](#10-quick-reference)

---

## 1. Supported devices

| Device | Firmware | Advertised name | Time protocol | Status |
|---|---|---|---|---|
| MJWSD05MMC (Chinese display) | pvvx custom | `BTH_xxxxxx` | Custom command `0x23` | Tested¹ |
| MJWSD05MMC (English display) | pvvx custom | `BTE_xxxxxx` | Custom command `0x23` | Tested¹ |
| MJWSD05MMC | Stock | `MJWSD05MMC` | MiClock, 6 bytes | Untested |
| LYWSD02MMC | pvvx custom (v5.8+) | `D02_xxxxxx` | Custom command `0x23` | Untested |
| LYWSD02MMC | Stock | `LYWSD02MMC` | MiClock, 6 bytes | Tested |
| LYWSD02 (older model) | Stock | `LYWSD02` | MiClock, 5 bytes | Untested |

¹ The MJWSD05MMC was tested on real devices; which display variant (ch/en) was not recorded.

`xxxxxx` is the last three bytes of the device MAC address in hex. With pvvx firmware the name can be changed
by the user; the name filter in the app (“Advanced”) can then be extended.

The device chooser only lists devices whose name starts with one of the configured prefixes. The defaults are
`BTH_`, `BTE_`, `MJWSD05MMC`, `D02_` and `LYWSD02`.

---

## 2. Time representations

Two different representations of time are used, depending on the firmware. Mixing them up shifts the clock by
the time zone offset, so it is worth being precise.

### Local time (pvvx custom firmware)

The pvvx firmware has no notion of time zones. It stores **local wall-clock time** as seconds since
1970-01-01 00:00:00, i.e. a Unix timestamp with the UTC offset already added:

```
local_seconds = unix_seconds + utc_offset_seconds
```

In JavaScript:

```js
const localSeconds = Math.floor(Date.now() / 1000) - new Date().getTimezoneOffset() * 60;
```

`getTimezoneOffset()` returns minutes *behind* UTC (for example `-60` for CET), hence the subtraction. Daylight
saving time is included automatically because the offset is taken for the current moment. The device does not
switch DST on its own; it has to be synced again after the change.

### UTC plus time zone (stock firmware)

The stock Xiaomi firmware stores a real **Unix timestamp (UTC)** plus a separate **time zone offset in whole
hours**. The device adds the offset itself for the display.

```
displayed_time = unix_seconds + tz_hours * 3600
```

Time zones with a 30 or 45 minute offset cannot be represented exactly. The 6-byte format has a byte that the
Telink Flasher labels “local time step 15 m”, but it is always written as `0` and its meaning is not confirmed.

### Byte order

All multi-byte integers are **little endian** (least significant byte first).

---

## 3. Connection and firmware detection

### GATT services used

| Service | UUID | Used for |
|---|---|---|
| pvvx custom service | `00001f10-0000-1000-8000-00805f9b34fb` (0x1F10) | Custom firmware commands |
| Xiaomi main service | `ebe0ccb0-7a0a-4b0c-8a1a-6ff2997da3a6` | Stock firmware clock |
| Device Information | `0000180a-0000-1000-8000-00805f9b34fb` (0x180A) | Firmware/hardware revision (optional) |

Web Bluetooth only allows access to services that are named when the device is requested, so all three are
passed as `optionalServices` to `navigator.bluetooth.requestDevice()`.

### Detection order

After `gatt.connect()` the app does the following:

1. Reads the **Device Information** service (optional, errors are ignored):
   - `0x2A26` Firmware Revision String
   - `0x2A27` Hardware Revision String
2. Tries the **pvvx custom service** `0x1F10` with characteristic `0x1F1F`.
   If found, it subscribes to notifications and selects mode `custom`.
3. Otherwise, tries the **Xiaomi main service** `ebe0ccb0-…` with characteristic `ebe0ccb7-…`.
   If found, it selects mode `mi` (stock firmware).
4. If neither exists, the app disconnects with the error “No clock function found on this device.”

The custom service is checked first because the pvvx firmware may keep Xiaomi-compatible services as well.

Nothing is read or written after connecting until the user presses **Read time from device** or **Sync time**.

---

## 4. pvvx custom firmware

### Characteristic

| Item | Value |
|---|---|
| Service | `00001f10-0000-1000-8000-00805f9b34fb` |
| Characteristic | `00001f1f-0000-1000-8000-00805f9b34fb` |
| Properties | Read, Write, Notify |

The characteristic is a command channel: the first byte of every write is a command ID, and the device answers
with a notification whose first byte is the same ID. Many other settings of the pvvx firmware use the same
channel; this app only uses command `0x23`.

Notifications must be enabled (`startNotifications()`) before sending commands, otherwise the replies are lost.

### Command 0x23 – set time

Write 5 bytes:

| Offset | Size | Type | Content |
|---|---|---|---|
| 0 | 1 | uint8 | `0x23` |
| 1 | 4 | uint32 LE | Local time in seconds (see [section 2](#local-time-pvvx-custom-firmware)) |

The firmware sets its clock and also remembers this value as the “last set” time. It may answer with a `0x23`
notification (same format as below); the app does not depend on it.

### Command 0x23 – read time

Write 1 byte:

| Offset | Size | Type | Content |
|---|---|---|---|
| 0 | 1 | uint8 | `0x23` |

The device answers with a notification:

| Offset | Size | Type | Content |
|---|---|---|---|
| 0 | 1 | uint8 | `0x23` |
| 1 | 4 | uint32 LE | Current device time (local seconds) |
| 5 | 4 | uint32 LE | Time of the last clock setting (local seconds), optional |

The app waits up to 4 seconds for a notification starting with `0x23` and at least 5 bytes long. Other
notifications on the same characteristic (the firmware also sends measurements and status blocks) are ignored.

### Clock drift correction (not used by this app)

The Telink Flasher also offers a drift correction via command `0x24`:

- Write `[0x24, delta_lo, delta_hi]` with `delta` as int16 LE in the range −32767…32767.
  According to the flasher UI the unit is 1/16 µs per second. The flasher sends the time again afterwards.
- The flasher's “Calc delta time” uses the current time and the last-set time from the `0x23` reply
  (offset 5), and needs at least 3 hours between setting and calculating.

This app does not implement drift correction; it is listed here for completeness.

### Example

Sync at 2026-11-09 12:00:00 CET (UTC+1):

```
Unix time (UTC)  = 1794222000 = 0x6AF1A7B0
Local seconds    = 1794225600 = 0x6AF1B5C0   (+3600 s)

Write  -> 23 c0 b5 f1 6a
```

Reading three seconds later, with the clock last set a week earlier:

```
Write  -> 23
Notify <- 23 c3 b5 f1 6a 40 7b e8 6a
          |  |-----------| |---------|
          |  current       last set
          command 0x23
```

`0x6AF1B5C3` = 12:00:03 local time, `0x6AE87B40` = 2026-11-02 12:00:00 local time.

---

## 5. Stock Xiaomi firmware

### Characteristic

| Item | Value |
|---|---|
| Service | `ebe0ccb0-7a0a-4b0c-8a1a-6ff2997da3a6` |
| Characteristic (“MiClock” / “Time”) | `ebe0ccb7-7a0a-4b0c-8a1a-6ff2997da3a6` |
| Properties | Read, Write (and/or Write Without Response, depending on the model) |

Unlike the custom firmware, the clock is a plain value: reading the characteristic returns the current time,
writing it sets the time. There are no notifications.

The same service contains other characteristics (for example `ebe0ccc1-…` for live temperature/humidity and
`ebe0ccb9-…`, `ebe0ccba-…`, `ebe0ccbc-…` for history data). They are not used by this app.

### 6-byte format (MJWSD05MMC, LYWSD02MMC)

| Offset | Size | Type | Content |
|---|---|---|---|
| 0 | 4 | uint32 LE | Unix time in seconds (UTC) |
| 4 | 1 | uint8 | Time zone in whole hours; negative offsets are stored as `offset + 24` |
| 5 | 1 | uint8 | Always `0` (labelled “local time step 15 m” in the Telink Flasher) |

Encoding the time zone byte, as done by the Telink Flasher:

```js
let tz = Math.round(-new Date().getTimezoneOffset() / 60); // e.g. +1 for CET, -5 for EST
if (tz < 0) tz += 24;                                      // -5 -> 19
```

Decoding: values above 12 are interpreted as negative (`tz - 24`).

Written with a normal write (with response), like the Telink Flasher does.

### 5-byte format (older LYWSD02)

| Offset | Size | Type | Content |
|---|---|---|---|
| 0 | 4 | uint32 LE | Unix time in seconds (UTC) |
| 4 | 1 | int8 | Time zone in whole hours (two's complement, e.g. `-5` = `0xFB`) |

Written with **Write Without Response** when the characteristic supports it, as described by bluetooth-clocks.

### Detecting the format

The length of the value returned by a read decides the format:

| Read length | Format | Write type |
|---|---|---|
| 5 bytes | 5-byte format | Write Without Response (if supported), else normal write |
| 6 bytes or more | 6-byte format | Normal write |
| less than 5 bytes | not supported | error “Unexpected response from device” |

If the user presses **Sync time** without having read the time before, the app first reads the characteristic
once to learn the length. The detected length is kept until the device disconnects.

### Examples

Sync at 2026-11-09 12:00:00 CET (UTC+1), Unix time `1794222000` = `0x6AF1A7B0`:

```
6-byte format  -> b0 a7 f1 6a 01 00
5-byte format  -> b0 a7 f1 6a 01
```

The same moment with a UTC−5 time zone:

```
6-byte format  -> b0 a7 f1 6a 13 00     (0x13 = 19 = -5 + 24)
5-byte format  -> b0 a7 f1 6a fb        (0xFB = -5 as int8)
```

### Mi login

The stock firmware also exposes the Xiaomi authentication service `0xFE95`. Some firmware versions only accept
certain writes after a Mi login (registration with Mi Home and a token/bind key), for example LYWSD03MMC
firmware 2.1.1_0159 and MJWSD06MMC firmware 2.1.1_0009. If the clock write is rejected, the app reports
“Sync failed – stock firmware may require a Mi login.” This app does not implement the Mi login.

---

## 6. Sync procedure in the app

`ClockDevice.syncTime()` performs these steps:

1. **Check the connection.** Throws “Not connected” otherwise.
2. **Stock firmware only:** if the payload length is not known yet, read `ebe0ccb7-…` once.
3. **Align to the next full second.** The app waits `1000 - (Date.now() % 1000)` ms. Both firmwares only
   accept whole seconds; without this step the device would be up to one second behind. With it, the error is
   limited to the BLE transfer time (typically a few tens of milliseconds).
4. **Build the payload** from the current time:
   - custom firmware: `[0x23, local_seconds (uint32 LE)]`
   - stock firmware: 6-byte or 5-byte format (see [section 5](#5-stock-xiaomi-firmware))
5. **Write** it to the characteristic.

After a successful write, the UI waits 300 ms and reads the time again (`readTime()`) to show the remaining
offset, then adds the device to the “Recently synced” list (stored in `localStorage`).

`ClockDevice.readTime()`:

- custom firmware: writes `[0x23]` and waits for the `0x23` notification,
- stock firmware: reads `ebe0ccb7-…` and converts UTC + time zone to local seconds.

It returns the device time as local seconds, the host time as local seconds, and the difference.

---

## 7. Offset calculation and display

Both clocks are compared as local seconds:

```
host_local   = floor(Date.now() / 1000) - getTimezoneOffset() * 60
device_local = custom: value from the 0x23 reply
               stock:  unix_seconds + tz_hours * 3600
offset       = device_local - host_local          (positive = device is ahead)
```

Badge colors in the UI:

| Offset | Color |
|---|---|
| ≤ 2 s | green |
| ≤ 60 s | yellow |
| > 60 s | red |

The device clock shown in the UI is not polled. After a read, the app stores the value together with
`performance.now()` and advances it locally once per second. Reading again resynchronizes the display.

Because the device values are local wall-clock times, they are formatted with `timeZone: 'UTC'` to avoid
applying the browser's time zone a second time.

---

## 8. Web Bluetooth specifics

- **Secure context:** Web Bluetooth only works on `https://` pages or `http://localhost`.
- **Browsers:** Chrome and Edge on desktop and Android. Not supported by Firefox, Safari or Samsung Internet.
  On iOS the third-party browser Bluefy works.
- **User gesture:** `requestDevice()` must be triggered by a click; the device chooser is shown by the browser.
- **One GATT operation at a time:** Android Chrome fails if several reads/writes overlap. The app runs all GATT
  operations sequentially with `await`.
- **Connection retries:** `gatt.connect()` is retried up to three times with 500 ms pauses, because the first
  attempt often fails on Android.
- **Write types:** `writeValue()` is used for normal writes; `writeValueWithoutResponse()` is used for the 5-byte
  stock format when the characteristic reports the `writeWithoutResponse` property.

---

## 9. Errors and limitations

| Message | Cause |
|---|---|
| No clock function found on this device. | Neither `0x1F10/0x1F1F` nor `ebe0ccb0/ebe0ccb7` found. |
| No response from device (timeout) | Custom firmware did not answer the `0x23` read within 4 s. |
| Unexpected response from device | Stock firmware returned fewer than 5 bytes. |
| Sync failed – stock firmware may require a Mi login. | The clock write was rejected by the stock firmware. |
| Not connected | An action was started after the connection dropped. |

Limitations:

- Only whole-hour time zones are supported by the stock firmware.
- Daylight saving time changes require a new sync.
- Clock drift is not corrected (see `0x24` in [section 4](#clock-drift-correction-not-used-by-this-app)).
- The Mi login of the stock firmware is not implemented.

---

## 10. Quick reference

```
pvvx custom firmware        service 0x1F10 / char 0x1F1F (notify on)
  set   W  23 tt tt tt tt               tt = local seconds, uint32 LE
  read  W  23
        N  23 cc cc cc cc [ss ss ss ss] cc = current, ss = last set (local seconds)

stock firmware              service ebe0ccb0-… / char ebe0ccb7-…
  6 B   R/W  uu uu uu uu zz 00          uu = UTC seconds, zz = tz hours (neg. + 24)
  5 B   R/W  uu uu uu uu zz             zz = tz hours, int8; write without response
```
