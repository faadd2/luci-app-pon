'use strict';
'require dom';
'require fs';
'require poll';
'require uci';
'require view';

/*
 * 光链路质量页（增强版新增）
 * 数据源：ponctl status --json（光功率/计数器）+ debugfs PCS/FEC 计数
 * 重点服务于 10G EPON "EPON MAC error interrupt: 0x0800" 误码诊断
 */

var HISTORY_MAX = 120;   /* 3s × 120 = 6 分钟窗口 */
var POLL_INTERVAL = 3;

var rxPowerHistory = [];
var uncorrectedHistory = [];
var lastSample = null;

function parseDebugfs(text) {
	var out = {};
	if (text == null)
		return out;
	String(text).split('\n').forEach(function(line) {
		var m = line.match(/^([a-zA-Z0-9_]+):\s*(.+)$/);
		if (m)
			out[m[1]] = m[2].trim();
	});
	return out;
}

function num(value) {
	var n = Number(value);
	return isNaN(n) ? null : n;
}

function fmtInt(value) {
	var n = num(value);
	return n == null ? '-' : n.toLocaleString('en-US');
}

function fmtRate(perSec) {
	if (perSec == null)
		return '-';
	if (perSec >= 1000000)
		return (perSec / 1000000).toFixed(2) + ' M/s';
	if (perSec >= 1000)
		return (perSec / 1000).toFixed(2) + ' K/s';
	return perSec.toFixed(1) + ' /s';
}

/* 接收光功率评级 */
function rxPowerGrade(p) {
	if (p == null)  return { label: '未知',      cls: 'label-warning' };
	if (p >= -20)   return { label: '优秀',    cls: 'label-success' };
	if (p >= -24)   return { label: '良好',         cls: 'label-primary' };
	if (p >= -27)   return { label: '偏弱',         cls: 'label-warning' };
	return             { label: '危险',     cls: 'label-danger'  };
}

/* FEC 误码评级 */
function fecGrade(uncorrectedPerSec, ratio) {
	if (uncorrectedPerSec == null)
		return { label: '采集中…', cls: 'label-warning' };
	if (uncorrectedPerSec > 1000 || (ratio != null && ratio > 0.01))
		return { label: '误码严重', cls: 'label-danger' };
	if (uncorrectedPerSec > 0 || (ratio != null && ratio > 0.0001))
		return { label: '存在误码', cls: 'label-warning' };
	return { label: '链路干净', cls: 'label-success' };
}

function badge(grade) {
	return E('span', { 'class': 'label %s'.format(grade.cls) }, grade.label);
}

function row(label, value) {
	return E('tr', { 'class': 'tr' }, [
		E('td', { 'class': 'td left', 'style': 'width: 45%' }, label),
		E('td', { 'class': 'td left' }, value == null || value === '' ? '-' : String(value))
	]);
}

function section(title, rows) {
	return E('div', { 'class': 'cbi-section' }, [
		E('h3', {}, title),
		E('table', { 'class': 'table' }, rows)
	]);
}

/* 轻量 sparkline：polyline + 末值标注 */
function sparkline(canvas, data, color, unit) {
	var dpr = window.devicePixelRatio || 1;
	var w = canvas.clientWidth || 600, h = 60;
	canvas.width = w * dpr; canvas.height = h * dpr;
	var ctx = canvas.getContext('2d');
	ctx.scale(dpr, dpr);
	ctx.clearRect(0, 0, w, h);
	if (!data.length)
		return;
	var min = Math.min.apply(null, data), max = Math.max.apply(null, data);
	var span = (max - min) || 1;
	ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath();
	data.forEach(function(v, i) {
		var x = (i / (HISTORY_MAX - 1)) * (w - 40) + 2;
		var y = h - 6 - ((v - min) / span) * (h - 14);
		i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
	});
	ctx.stroke();
	ctx.fillStyle = '#666'; ctx.font = '10px sans-serif';
	ctx.fillText(max.toFixed(2) + ' ' + unit, w - 38, 10);
	ctx.fillText(min.toFixed(2) + ' ' + unit, w - 38, h - 2);
	ctx.fillStyle = color;
	ctx.fillText(data[data.length - 1].toFixed(2) + ' ' + unit, 4, 10);
}

function firstLine() {
	var lines = uci.sections('pon', 'xpon');
	return (lines[0] && lines[0].device) || 'pon0';
}

function loadData() {
	var device = firstLine();
	return Promise.all([
		L.resolveDefault(fs.exec_direct('/usr/sbin/ponctl', ['--device', device, 'status', '--json']), null),
		L.resolveDefault(fs.read_direct('/sys/kernel/debug/airoha-xpon-pon0/pcs', 'text'), null),
		L.resolveDefault(fs.read_direct('/sys/kernel/debug/airoha-xpon-pon0/frontend', 'text'), null)
	]).then(function(results) {
		var status = null;
		try { status = JSON.parse(results[0]); } catch (e) {}
		return {
			status: status,
			pcs: parseDebugfs(results[1]),
			fe: parseDebugfs(results[2]),
			debugfsMissing: results[1] == null
		};
	});
}

function renderAll(data) {
	var status = data.status || {};
	var line = status.line || {};
	var reg = status.registration || {};
	var fe = status.frontend || {};
	var counters = status.counters || {};
	var pcs = data.pcs || {};
	var feD = data.fe || {};

	var rx = num(fe.rx_power_dbm != null ? fe.rx_power_dbm : feD.rx_power_dbm);
	var tx = num(fe.tx_power_dbm != null ? fe.tx_power_dbm : feD.tx_power_dbm);

	/* 采样历史（每轮渲染push一次，由 poll 驱动） */
	var uncorrected = num(pcs.uncorrected_codewords);
	var now = Date.now();
	if (lastSample && uncorrected != null && lastSample.uncorrected != null) {
		var dt = (now - lastSample.t) / 1000;
		if (dt > 0) {
			var rate = Math.max(0, (uncorrected - lastSample.uncorrected)) / dt;
			uncorrectedHistory.push(rate);
			if (uncorrectedHistory.length > HISTORY_MAX) uncorrectedHistory.shift();
		}
	}
	if (rx != null) {
		rxPowerHistory.push(rx);
		if (rxPowerHistory.length > HISTORY_MAX) rxPowerHistory.shift();
	}
	lastSample = { t: now, uncorrected: uncorrected };

	var corrected = num(pcs.corrected_codewords);
	var all = num(pcs.all_codewords);
	var fecRatio = (all && corrected != null && uncorrected != null)
		? (corrected + uncorrected) / all : null;
	var uncRate = uncorrectedHistory.length ? uncorrectedHistory[uncorrectedHistory.length - 1] : null;

	var nodes = [];

	/* 概要区 */
	nodes.push(E('div', { 'class': 'cbi-section' }, [
		E('h3', {}, '链路质量概览'),
		E('table', { 'class': 'table' }, [
			row('注册状态', reg.mpcp_state != null
				? E('span', { 'class': 'label %s'.format(reg.mpcp_state === 'registered' ? 'label-success' : 'label-warning') },
					reg.mpcp_state) : '-'),
			row('接收光功率', [
				rx != null ? rx.toFixed(2) + ' dBm' : '-', ' ', badge(rxPowerGrade(rx))
			]),
			row('发送光功率', tx != null ? tx.toFixed(2) + ' dBm' : '-'),
			row('不可纠错 FEC 码字', [
				fecGrade(uncRate, fecRatio), ' ',
				uncorrected != null ? fmtInt(uncorrected) : '不可用'
			]),
			row('FEC 码字错误率', fecRatio != null ? (fecRatio * 100).toFixed(4) + ' %' : '-')
		])
	]));

	/* 趋势图 */
	nodes.push(E('div', { 'class': 'cbi-section' }, [
		E('h3', {}, '趋势（最近 %d 分钟）'.format(HISTORY_MAX * POLL_INTERVAL / 60)),
		E('div', { 'class': 'cbi-value' }, [
			E('label', { 'class': 'cbi-value-title' }, '接收光功率（dBm）'),
			E('div', { 'class': 'cbi-value-field' },
				E('canvas', { 'id': 'pon-optical-rx-spark', 'style': 'width:100%;height:60px' }))
		]),
		E('div', { 'class': 'cbi-value' }, [
			E('label', { 'class': 'cbi-value-title' }, '每秒不可纠错 FEC 码字'),
			E('div', { 'class': 'cbi-value-field' },
				E('canvas', { 'id': 'pon-optical-unc-spark', 'style': 'width:100%;height:60px' }))
		]),
		E('p', { 'class': 'cbi-value-description' },
			'本页面打开期间每 %d 秒采样一次。建议清洁光纤端面或重新插拔接头前先打开本页，以保留前后对比数据。'.format(POLL_INTERVAL))
	]));

	/* 光模块参数 */
	nodes.push(section('光模块', [
		row('线路模式', line.active_mode || line.configured_mode),
		row('线路状态', line.lifecycle),
		row('PCS 配置档', line.pcs_profile),
		row('PCS 已同步', line.pcs_sync != null ? (line.pcs_sync ? '是' : '否') : '-'),
		row('温度', num(fe.temperature_celsius != null ? fe.temperature_celsius : feD.temperature_celsius) != null
			? Number(fe.temperature_celsius != null ? fe.temperature_celsius : feD.temperature_celsius).toFixed(1) + ' °C' : '-'),
		row('供电电压', num(fe.voltage_volts != null ? fe.voltage_volts : feD.voltage_volts) != null
			? Number(fe.voltage_volts != null ? fe.voltage_volts : feD.voltage_volts).toFixed(2) + ' V' : '-'),
		row('激光器偏置电流', num(fe.tx_bias_ma != null ? fe.tx_bias_ma : feD.tx_bias_ma) != null
			? Number(fe.tx_bias_ma != null ? fe.tx_bias_ma : feD.tx_bias_ma).toFixed(2) + ' mA' : '-'),
		row('校准数据', fe.calibration || feD.calibration),
		row('TX 门控已启用', fe.tx_gate_enabled != null
			? (fe.tx_gate_enabled ? '是' : '否') : '-')
	]));

	/* FEC / PCS 计数器 */
	var rows = [
		row('FEC 码字总数', fmtInt(pcs.all_codewords)),
		row('无错误码字', fmtInt(pcs.no_error_codewords)),
		row('已纠错码字', fmtInt(pcs.corrected_codewords)),
		row('不可纠错码字', fmtInt(pcs.uncorrected_codewords)),
		row('不可纠错码字速率', fmtRate(uncRate)),
		row('FEC 错误比特', fmtInt(pcs.error_bits)),
		row('FEC 错误字节', fmtInt(pcs.error_bytes)),
		row('FEC 误码秒', fmtInt(pcs.fec_error_seconds)),
		row('PCS 中断状态', pcs.interrupt_status ? '0x' + Number(pcs.interrupt_status).toString(16) : '-'),
		row('MAC 错误计数（0x0800 中断来源）', fmtInt(counters.mac_errors))
	];
	if (data.debugfsMissing)
		rows.unshift(row('调试接口', [
			'不可用（缺少 debugfs）。上表计数器仅来自 ponctl。',
			E('br'), E('code', {}, 'mount -t debugfs none /sys/kernel/debug')
		]));
	nodes.push(section('FEC / PCS 计数器', rows));

	/* 0x0800 提示 */
	nodes.push(E('div', { 'class': 'cbi-section' }, [
		E('h3', {}, '关于 "EPON MAC error interrupt: 0x0800"'),
		E('p', {}, '在 10G-EPON 链路上，当 FEC 块上报不可纠错码字时就会触发该中断，几乎都是光纤端面脏污/损伤、接收机性能偏弱或熔接不良所致。请用酒精棉片清洁两端端面并用放大镜/显微镜检查。健康链路的不可纠错码字速率应为零。')
	]));

	return nodes;
}

return view.extend({
	load: function() {
		return uci.load('pon').then(loadData);
	},

	render: function(data) {
		var container = E('div', { 'id': 'pon-optical' }, renderAll(data));
		var root = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, '光链路'),
			container
		]);

		poll.add(function() {
			return loadData().then(function(d) {
				dom.content(container, renderAll(d));
				var c1 = container.querySelector('#pon-optical-rx-spark');
				var c2 = container.querySelector('#pon-optical-unc-spark');
				if (c1) sparkline(c1, rxPowerHistory, '#2c7be5', 'dBm');
				if (c2) sparkline(c2, uncorrectedHistory, '#e63757', '/s');
			});
		}, POLL_INTERVAL);

		/* 首帧画图 */
		requestAnimationFrame(function() {
			var c1 = container.querySelector('#pon-optical-rx-spark');
			var c2 = container.querySelector('#pon-optical-unc-spark');
			if (c1) sparkline(c1, rxPowerHistory, '#2c7be5', 'dBm');
			if (c2) sparkline(c2, uncorrectedHistory, '#e63757', '/s');
		});

		return root;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
