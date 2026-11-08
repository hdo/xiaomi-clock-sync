(function () {
	'use strict';

	const $ = id => document.getElementById(id);
	const LOCALE = 'en-GB'; // English text, 24-hour clock, day/month/year
	const STORE = { prefixes: 'mjclock.prefixes', history: 'mjclock.history' };
	const MODE_LABEL = { custom: 'pvvx firmware', mi: 'Stock firmware' };

	const store = {
		get(key, fallback) {
			try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
			catch (e) { return fallback; }
		},
		set(key, value) {
			try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
		},
	};

	// ---------- Log & notifications ----------

	function log(msg) {
		const t = new Date().toLocaleTimeString(LOCALE);
		const el = $('log');
		el.textContent += `${t}  ${msg}\n`;
		el.scrollTop = el.scrollHeight;
	}

	let toast;
	function notify(msg, type = 'success') {
		const el = $('toast');
		el.className = `toast align-items-center border-0 text-bg-${type}`;
		$('toastBody').textContent = msg;
		toast = toast || bootstrap.Toast.getOrCreateInstance(el, { delay: 3500 });
		toast.show();
	}

	// ---------- Device ----------

	const dev = new ClockDevice(log);
	let deviceClock = null; // { seconds, at }  at = performance.now() when the time was read
	let busy = false;

	function prefixes() {
		return $('optPrefixes').value.split(',').map(s => s.trim()).filter(Boolean);
	}

	function setBusy(on, label) {
		busy = on;
		updateUi();
		if (on && label) $('connBadge').textContent = label;
	}

	function updateUi() {
		const c = dev.connected;
		$('btnConnect').classList.toggle('d-none', c);
		$('btnDisconnect').classList.toggle('d-none', !c);
		$('btnConnect').disabled = busy || !ClockDevice.supported;
		$('btnDisconnect').disabled = busy;
		$('btnSync').disabled = !c || busy;
		$('btnRead').disabled = !c || busy;

		const badge = $('connBadge');
		if (busy) {
			badge.className = 'badge rounded-pill text-bg-warning flex-shrink-0';
		} else if (c) {
			badge.className = 'badge rounded-pill text-bg-success flex-shrink-0';
			badge.textContent = 'Connected';
		} else {
			badge.className = 'badge rounded-pill text-bg-secondary flex-shrink-0';
			badge.textContent = 'Disconnected';
		}

		if (c) {
			$('devName').textContent = dev.name;
			const parts = [MODE_LABEL[dev.mode]];
			if (dev.info.fw) parts.push('FW ' + dev.info.fw);
			if (dev.info.hw) parts.push('HW ' + dev.info.hw);
			$('devInfo').textContent = parts.join(' · ');
		} else if (!busy) {
			$('devName').textContent = dev.device ? dev.name : 'Not connected';
			$('devInfo').textContent = dev.device ? 'Disconnected' : 'Connect a thermometer clock via Bluetooth';
		}
	}

	function showDelta(delta) {
		const el = $('deltaBadge');
		if (delta === null || delta === undefined) {
			el.className = 'badge rounded-pill bg-body-secondary text-body-secondary border fw-normal';
			el.textContent = 'Offset: –';
			return;
		}
		const abs = Math.abs(delta);
		const cls = abs <= 2 ? 'success' : abs <= 60 ? 'warning' : 'danger';
		el.className = `badge rounded-pill text-bg-${cls}`;
		el.textContent = 'Offset: ' + fmtDelta(delta);
	}

	function fmtDelta(d) {
		const sign = d > 0 ? '+' : d < 0 ? '−' : '±';
		let a = Math.abs(d);
		if (a < 60) return `${sign}${a} s`;
		const days = Math.floor(a / 86400); a %= 86400;
		const h = Math.floor(a / 3600); a %= 3600;
		const m = Math.floor(a / 60); const s = a % 60;
		const out = [];
		if (days) out.push(days + ' d');
		if (h) out.push(h + ' h');
		if (m) out.push(m + ' min');
		if (s && !days) out.push(s + ' s');
		return sign + out.join(' ');
	}

	async function readTime() {
		const r = await dev.readTime();
		deviceClock = { seconds: r.deviceSeconds, at: performance.now() };
		showDelta(r.delta);
		return r;
	}

	async function connect() {
		if (!ClockDevice.supported) return;
		setBusy(true, 'Connecting …');
		$('devName').textContent = 'Searching …';
		$('devInfo').textContent = 'Select the thermometer in the browser dialog';
		try {
			await dev.request(prefixes());
			setBusy(false);
			notify(`${dev.name} connected`);
		} catch (e) {
			setBusy(false);
			if (e.name === 'NotFoundError') { log('Selection cancelled'); updateUi(); return; }
			log('Error: ' + e.message);
			notify(e.message, 'danger');
		}
	}

	async function withBusy(label, fn) {
		setBusy(true, label);
		try { return await fn(); }
		finally { setBusy(false); }
	}

	async function sync() {
		try {
			const r = await withBusy('Syncing …', async () => {
				await dev.syncTime();
				await ClockUtil.sleep(300);
				return readTime().catch(() => null);
			});
			addHistory(r ? r.delta : null);
			notify(`${dev.name}: time set`);
		} catch (e) {
			log('Error: ' + e.message);
			const hint = dev.mode === 'mi' ? ' – stock firmware may require a Mi login.' : '';
			notify('Sync failed' + hint, 'danger');
		}
	}

	// ---------- History ----------

	function addHistory(delta) {
		const list = store.get(STORE.history, []).filter(h => h.name !== dev.name);
		list.unshift({ name: dev.name, mode: dev.mode, time: Date.now(), delta });
		store.set(STORE.history, list.slice(0, 15));
		renderHistory();
	}

	function renderHistory() {
		const ul = $('history');
		const list = store.get(STORE.history, []);
		ul.replaceChildren();
		if (!list.length) {
			const li = document.createElement('li');
			li.className = 'list-group-item text-body-secondary small';
			li.textContent = 'No entries yet';
			ul.append(li);
			return;
		}
		for (const h of list) {
			const li = document.createElement('li');
			li.className = 'list-group-item d-flex justify-content-between align-items-center gap-2';
			const left = document.createElement('div');
			left.className = 'min-w-0';
			const name = document.createElement('div');
			name.className = 'fw-semibold text-truncate';
			name.textContent = h.name;
			const sub = document.createElement('div');
			sub.className = 'small text-body-secondary';
			sub.textContent = new Date(h.time).toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'short' })
				+ (h.mode ? ' · ' + MODE_LABEL[h.mode] : '');
			left.append(name, sub);
			const ok = document.createElement('i');
			ok.className = 'bi bi-check-circle-fill text-success flex-shrink-0';
			li.append(left, ok);
			ul.append(li);
		}
	}

	// ---------- Clock display ----------

	const fmtTime = (d, tz) => d.toLocaleTimeString(LOCALE, tz ? { timeZone: tz } : {});
	const fmtDate = (d, tz) => d.toLocaleDateString(LOCALE, Object.assign(
		{ weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }, tz ? { timeZone: tz } : {}));

	function tick() {
		const now = new Date();
		$('hostClock').textContent = fmtTime(now);
		$('hostDate').textContent = fmtDate(now);
		if (deviceClock) {
			const d = new Date(deviceClock.seconds * 1000 + (performance.now() - deviceClock.at));
			$('devClock').textContent = fmtTime(d, 'UTC');
			$('devDate').textContent = fmtDate(d, 'UTC');
		} else {
			$('devClock').textContent = '--:--:--';
			$('devDate').innerHTML = '&nbsp;';
		}
	}

	// ---------- Init ----------

	function init() {
		if (!ClockDevice.supported) $('noBluetooth').classList.remove('d-none');

		$('optPrefixes').value = store.get(STORE.prefixes, ClockDevice.defaultPrefixes).join(', ');

		$('optPrefixes').addEventListener('change', () => store.set(STORE.prefixes, prefixes()));
		$('btnResetPrefixes').addEventListener('click', () => {
			$('optPrefixes').value = ClockDevice.defaultPrefixes.join(', ');
			store.set(STORE.prefixes, ClockDevice.defaultPrefixes);
		});

		$('btnConnect').addEventListener('click', connect);
		$('btnDisconnect').addEventListener('click', () => dev.disconnect());
		$('btnSync').addEventListener('click', sync);
		$('btnRead').addEventListener('click', () => withBusy('Reading …', readTime).catch(e => {
			log('Error: ' + e.message);
			notify(e.message, 'danger');
		}));
		$('btnClearLog').addEventListener('click', () => { $('log').textContent = ''; });
		$('btnClearHistory').addEventListener('click', () => { store.set(STORE.history, []); renderHistory(); });

		dev.addEventListener('connected', updateUi);
		dev.addEventListener('disconnected', () => {
			deviceClock = null;
			showDelta(null);
			updateUi();
		});

		renderHistory();
		updateUi();
		tick();
		setInterval(tick, 250);
	}

	init();
})();
