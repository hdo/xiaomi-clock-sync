/*
 * BLE access to the clock of Xiaomi MJWSD05MMC and LYWSD02(MMC) devices.
 *
 * Protocols (taken from the Telink BLE OTA Flasher by pvvx):
 *
 *  pvvx custom firmware (name "BTH_xxxxxx" / "BTE_xxxxxx" = MJWSD05MMC, "D02_xxxxxx" = LYWSD02MMC):
 *    Service 0x1F10, characteristic 0x1F1F (write + notify)
 *    Set time:  [0x23, t0, t1, t2, t3]  t = local time in seconds since 1970 (little endian)
 *    Read time: [0x23] -> notify [0x23, cur(4), lastSet(4)]
 *
 *  Stock Xiaomi firmware (name "MJWSD05MMC", "LYWSD02MMC", "LYWSD02"):
 *    Service ebe0ccb0-…, characteristic ebe0ccb7-… (read/write)
 *    6 bytes: [utc(4, LE), time zone in hours (negative + 24), 0]   (MJWSD05MMC, LYWSD02MMC)
 *    5 bytes: [utc(4, LE), time zone in hours (int8)]               (older LYWSD02, see bluetooth-clocks)
 *    The payload length is taken from a read of the characteristic.
 *    Note: newer stock firmware may require a Mi login;
 *    writing then fails.
 */
(function (global) {
	'use strict';

	const UUID = {
		custom: '00001f10-0000-1000-8000-00805f9b34fb',
		customChar: '00001f1f-0000-1000-8000-00805f9b34fb',
		mi: 'ebe0ccb0-7a0a-4b0c-8a1a-6ff2997da3a6',
		miClock: 'ebe0ccb7-7a0a-4b0c-8a1a-6ff2997da3a6',
		devInfo: 0x180a,
		fwRev: 0x2a26,
		hwRev: 0x2a27,
	};

	const CMD_TIME = 0x23;
	const DEFAULT_PREFIXES = ['BTH_', 'BTE_', 'MJWSD05MMC', 'D02_', 'LYWSD02'];
	const LOCALE = 'en-GB';

	/** Local "wall clock" time in seconds (what the display should show). */
	function hostLocalSeconds(ms = Date.now()) {
		return Math.floor(ms / 1000) - new Date(ms).getTimezoneOffset() * 60;
	}

	function toHex(buf) {
		return Array.from(new Uint8Array(buf.buffer || buf), b => b.toString(16).padStart(2, '0')).join(' ');
	}

	class ClockDevice extends EventTarget {
		constructor(log) {
			super();
			this.log = log || (() => {});
			this.device = null;
			this.server = null;
			this.mode = null;          // 'custom' | 'mi'
			this.char = null;
			this.miLength = 0;         // stock firmware payload length (5 or 6), 0 = not read yet
			this.info = {};
			this._waiter = null;
			this._onNotify = this._onNotify.bind(this);
			this._onDisconnect = this._onDisconnect.bind(this);
		}

		static get supported() {
			return !!(navigator.bluetooth && navigator.bluetooth.requestDevice);
		}

		static get defaultPrefixes() {
			return DEFAULT_PREFIXES.slice();
		}

		get connected() {
			return !!(this.device && this.device.gatt.connected && this.char);
		}

		get name() {
			return this.device ? (this.device.name || 'Unknown') : '';
		}

		/**
		 * Web Bluetooth device ID. This is NOT the MAC address: the browser generates an opaque ID
		 * per site and browser profile. It stays the same for a device in this browser, so it can
		 * tell apart devices with the same name, but it differs between browsers/computers/phones.
		 */
		get id() {
			return this.device ? (this.device.id || '') : '';
		}

		/** The device ID for display: Chrome's base64 ID as an uppercase hex string. */
		get idHex() {
			return idToHex(this.id);
		}

		/** Open the browser's device chooser and connect. */
		async request(prefixes) {
			const list = (prefixes && prefixes.length ? prefixes : DEFAULT_PREFIXES);
			const device = await navigator.bluetooth.requestDevice({
				filters: list.map(p => ({ namePrefix: p })),
				optionalServices: [UUID.custom, UUID.mi, UUID.devInfo],
			});
			await this.connect(device);
		}

		async connect(device) {
			if (this.device && this.device !== device) this.disconnect();
			this.device = device;
			device.removeEventListener('gattserverdisconnected', this._onDisconnect);
			device.addEventListener('gattserverdisconnected', this._onDisconnect);

			this.log(`Connecting to ${this.name} (ID ${this.idHex}) …`);
			this.server = await this._retry(() => device.gatt.connect(), 3);
			this.log('GATT server connected');

			this.info = await this._readDeviceInfo();
			if (this.info.fw) this.log(`Firmware: ${this.info.fw}`);
			if (this.info.hw) this.log(`Hardware: ${this.info.hw}`);

			// 1. pvvx custom firmware
			try {
				const svc = await this.server.getPrimaryService(UUID.custom);
				this.char = await svc.getCharacteristic(UUID.customChar);
				await this.char.startNotifications();
				this.char.addEventListener('characteristicvaluechanged', this._onNotify);
				this.mode = 'custom';
				this.log('pvvx custom firmware detected (0x1F10/0x1F1F)');
			} catch (e) {
				this.char = null;
			}

			// 2. Stock firmware
			if (!this.char) {
				try {
					const svc = await this.server.getPrimaryService(UUID.mi);
					this.char = await svc.getCharacteristic(UUID.miClock);
					this.mode = 'mi';
					this.log('Stock Xiaomi firmware detected (MiClock)');
				} catch (e) {
					this.char = null;
				}
			}

			if (!this.char) {
				this.disconnect();
				throw new Error('No clock function found on this device.');
			}
			this.dispatchEvent(new Event('connected'));
		}

		disconnect() {
			if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
			else this._onDisconnect();
		}

		/**
		 * Reads the device clock.
		 * @returns {Promise<{deviceSeconds:number, hostSeconds:number, delta:number, lastSet?:number}>}
		 *          deviceSeconds = local time shown by the device (seconds, stored as if UTC)
		 */
		async readTime() {
			this._assertConnected();
			let deviceSeconds, lastSet;
			if (this.mode === 'custom') {
				const v = await this._command(new Uint8Array([CMD_TIME]), CMD_TIME);
				deviceSeconds = v.getUint32(1, true);
				if (v.byteLength >= 9) lastSet = v.getUint32(5, true);
			} else {
				const v = await this._readMiClock();
				let tz;
				if (v.byteLength === 5) {
					tz = v.getInt8(4);
				} else {
					tz = v.getUint8(4);
					if (tz > 12) tz -= 24;
				}
				deviceSeconds = v.getUint32(0, true) + tz * 3600;
			}
			const hostSeconds = hostLocalSeconds();
			const res = { deviceSeconds, hostSeconds, delta: deviceSeconds - hostSeconds, lastSet };
			this.log(`Device time: ${fmtUtc(deviceSeconds)} (offset ${res.delta >= 0 ? '+' : ''}${res.delta} s)`);
			return res;
		}

		/** Sets the device clock to the current time of this computer/phone. */
		async syncTime() {
			this._assertConnected();
			// Stock firmware: the payload length (5 or 6 bytes) depends on the model
			if (this.mode === 'mi' && !this.miLength) await this._readMiClock();
			// Wait for the start of the next second -> error < 1 s instead of up to 1 s
			await sleep(1000 - (Date.now() % 1000));
			const now = Date.now();
			let buf;
			if (this.mode === 'custom') {
				const t = hostLocalSeconds(now);
				buf = new Uint8Array([CMD_TIME, t & 0xff, (t >>> 8) & 0xff, (t >>> 16) & 0xff, (t >>> 24) & 0xff]);
			} else {
				const ut = Math.floor(now / 1000);
				const tzh = Math.round(-new Date(now).getTimezoneOffset() / 60);
				const utBytes = [ut & 0xff, (ut >>> 8) & 0xff, (ut >>> 16) & 0xff, (ut >>> 24) & 0xff];
				buf = this.miLength === 5
					? new Uint8Array([...utBytes, tzh & 0xff])
					: new Uint8Array([...utBytes, tzh < 0 ? tzh + 24 : tzh, 0]);
			}
			this.log('Sending time: ' + toHex(buf));
			const p = this.char.properties;
			if (this.mode === 'mi' && this.miLength === 5 && p.writeWithoutResponse && this.char.writeValueWithoutResponse)
				await this.char.writeValueWithoutResponse(buf);
			else
				await this.char.writeValue(buf);
			this.log('Time set: ' + new Date(now).toLocaleString(LOCALE));
		}

		// ---- internal ----

		_assertConnected() {
			if (!this.connected) throw new Error('Not connected');
		}

		async _readMiClock() {
			const v = await this.char.readValue();
			this.log('MiClock read: ' + toHex(v));
			if (v.byteLength < 5) throw new Error('Unexpected response from device');
			this.miLength = v.byteLength === 5 ? 5 : 6;
			return v;
		}

		async _command(data, expectId, timeout = 4000) {
			const p = new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					this._waiter = null;
					reject(new Error('No response from device (timeout)'));
				}, timeout);
				this._waiter = { id: expectId, resolve: v => { clearTimeout(timer); resolve(v); } };
			});
			this.log('Sending: ' + toHex(data));
			await this.char.writeValue(data);
			return p;
		}

		_onNotify(ev) {
			const v = ev.target.value;
			if (!v || v.byteLength < 1) return;
			const id = v.getUint8(0);
			if (this._waiter && this._waiter.id === id && v.byteLength >= 5) {
				this.log('Response: ' + toHex(v));
				const w = this._waiter;
				this._waiter = null;
				w.resolve(v);
			}
		}

		_onDisconnect() {
			const was = !!this.char;
			this.char = null;
			this.server = null;
			this.mode = null;
			this.miLength = 0;
			this._waiter = null;
			if (was || this.device) this.log('Disconnected');
			this.dispatchEvent(new Event('disconnected'));
		}

		async _readDeviceInfo() {
			const info = {};
			try {
				const svc = await this.server.getPrimaryService(UUID.devInfo);
				for (const [key, uuid] of [['fw', UUID.fwRev], ['hw', UUID.hwRev]]) {
					try {
						const c = await svc.getCharacteristic(uuid);
						info[key] = new TextDecoder().decode(await c.readValue()).replace(/\0+$/, '').trim();
					} catch (e) { /* optional */ }
				}
			} catch (e) { /* optional */ }
			return info;
		}

		async _retry(fn, tries) {
			let err;
			for (let i = 0; i < tries; i++) {
				try { return await fn(); } catch (e) {
					err = e;
					this.log(`Connection attempt ${i + 1} failed: ${e.message}`);
					await sleep(500);
				}
			}
			throw err;
		}
	}

	/**
	 * Converts a Web Bluetooth device ID to uppercase hex for display.
	 * Chrome returns 16 random bytes as base64 (e.g. "irtR2tluYpBik5YWEfntvg==" -> "8ABB51DA…EDBE").
	 * IDs that are not valid base64 are returned unchanged.
	 */
	function idToHex(id) {
		if (!id) return '';
		try {
			return Array.from(atob(id), c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').toUpperCase();
		} catch (e) {
			return id;
		}
	}

	function sleep(ms) {
		return new Promise(r => setTimeout(r, ms));
	}

	/** Formats "local seconds" (stored as UTC) as a date/time string. */
	function fmtUtc(sec) {
		return new Date(sec * 1000).toLocaleString(LOCALE, { timeZone: 'UTC' });
	}

	global.ClockDevice = ClockDevice;
	global.ClockUtil = { hostLocalSeconds, fmtUtc, sleep, idToHex };
})(window);
