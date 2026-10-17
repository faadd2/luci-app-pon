'use strict';
'require dom';
'require form';
'require fs';
'require ui';
'require uci';
'require view';

var HELPER = '/usr/libexec/airoha-pon-debug';
var BUNDLE = '/tmp/pon-debug.tar.gz';
var PATCH_INFO = '/etc/pon-fix-version';

function downloadBundle() {
	return fs.read_direct(BUNDLE, 'blob').then(function(blob) {
		var url = window.URL.createObjectURL(blob);
		var link = document.createElement('a');
		var now = new Date();
		link.style.display = 'none';
		link.href = url;
		link.download = 'pon-debug-' + now.toISOString().replace(/[:.]/g, '-') + '.tar.gz';
		document.body.appendChild(link);
		link.click();
		link.remove();
		window.URL.revokeObjectURL(url);
	});
}

return view.extend({
	handleDownload: function() {
		var button = document.getElementById('pon-debug-download');
		button.disabled = true;
		button.classList.add('spinning');
		return fs.exec_direct(HELPER, ['collect']).then(downloadBundle).catch(function(error) {
			ui.addNotification(null, E('p', {}, '无法创建诊断包：%s'.format(error.message)));
		}).finally(function() {
			button.disabled = false;
			button.classList.remove('spinning');
		});
	},

	handleRestart: function() {
		var button = document.getElementById('pon-debug-restart');
		if (!window.confirm('PON 线路及 OMCI/OAM 接口将停止并重启，继续吗？'))
			return;
		button.disabled = true;
		button.classList.add('spinning');
		return fs.exec_direct(HELPER, ['restart']).then(function(output) {
			var result = JSON.parse(output);
			if (!result.ok)
				throw new Error('PON 重启失败。');
			ui.addNotification(null, E('p', {}, 'PON 重启完成。'));
		}).catch(function(error) {
			ui.addNotification(null, E('p', {}, '无法重启 PON：%s'.format(error.message)));
		}).finally(function() {
			button.disabled = false;
			button.classList.remove('spinning');
		});
	},

	load: function() {
		return L.resolveDefault(fs.read_direct(PATCH_INFO, 'text'), null);
	},

	render: function(patchInfo) {
		var m, s, o;
		m = new form.Map('airoha-pon-debug', 'PON 诊断',
			'调试模式会在内存中持续保留最近的原始 PON、OMCI 和 OAM 报文，重启后仍然有效。');
		m.chain('pon');
		m.readonly = !L.hasViewPermission();

		s = m.section(form.NamedSection, 'capture', 'capture', 'PON 线路');
		o = s.option(form.DummyValue, '_devices', 'PON 接口');
		o.cfgvalue = function() {
			return uci.sections('pon', 'xpon').map(function(line) {
				return line.device || line['.name'];
			}).join(', ') || '-';
		};
		o = s.option(form.Flag, 'enabled', '调试模式');
		o.default = o.disabled;
		o.rmempty = false;
		o.description = '启用会先开始抓包再完整重启 PON；停用则停止抓包。';

		var patchSection = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, 'PON 补丁信息'),
			E('p', { 'class': 'cbi-value-description' },
				'显示设备是否安装了兼容补丁版 airoha-pond（北京联通 10G-EPON 注册必需）。'),
			E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left', 'style': 'width: 45%' }, '补丁状态'),
					E('td', { 'class': 'td left' }, patchInfo != null
						? [ E('span', { 'class': 'label label-success', 'style': 'margin-right:6px' }, '已打补丁'), ' ', E('code', {}, patchInfo.trim()) ]
						: [ E('span', { 'class': 'label label-warning', 'style': 'margin-right:6px' }, '未打补丁'), ' ',
						    E('code', {}, '/usr/sbin/airoha-pond (stock binary)') ])
				])
			])
		]);

		var opsSection = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, '诊断操作'),
			E('p', {}, '诊断包包含原始报文抓包、PON 状态、系统日志和网络配置。'),
			E('div', { 'class': 'cbi-page-actions' }, [
				E('button', {
					'class': 'cbi-button cbi-button-action',
					'id': 'pon-debug-download',
					'disabled': m.readonly || null,
					'click': ui.createHandlerFn(this, 'handleDownload')
				}, '下载诊断包'),
				E('button', {
					'class': 'cbi-button cbi-button-negative',
					'id': 'pon-debug-restart',
					'disabled': m.readonly || null,
					'click': ui.createHandlerFn(this, 'handleRestart')
				}, '重启 PON 线路')
			])
		]);

		return m.render().then(function(map) {
			return E('div', { 'class': 'cbi-map' }, [
				map,
				patchSection,
				opsSection
			]);
		});
	},

	handleSaveApply: null
});
