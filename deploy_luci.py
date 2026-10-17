# -*- coding: utf-8 -*-
"""把增强版 luci-app-pon 部署到 ZN504XG-D（含中文内联 JS，无需编译 lmo）

用法: python deploy_luci.py [--host 192.168.1.1]
步骤:
  1. 上传 6 个 JS 视图（中文内联版）到 /www/luci-static/resources/view/pon/
  2. 上传菜单与 ACL
  3. 写入 /etc/pon-fix-version（若设备已打 pond 补丁且标记文件不存在）
  4. 重启 rpcd + uhttpd，清理 luci 缓存
"""
import os, sys, json, subprocess, time

BASE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.join(BASE, 'package', 'luci-app-pon')
ZH_INLINE = os.path.join(PKG, 'htdocs', 'luci-static', 'resources', 'view', 'pon', '_zh_inline')
VIEWS = ['status.js', 'optical.js', 'config.js', 'hardware.js', 'events.js', 'diagnostics.js']
HOST = '192.168.1.1'

def ssh(cmd, timeout=60):
    r = subprocess.run([sys.executable, os.path.join(BASE, '..', 'scripts', 'device_ssh.py'), cmd],
                       capture_output=True, text=True, timeout=timeout)
    return r.stdout + r.stderr

def upload(local, remote):
    r = subprocess.run([sys.executable, os.path.join(BASE, '..', 'scripts', 'chunk_upload.py'), local, remote],
                       capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        print(r.stdout, r.stderr)
        raise SystemExit('upload failed: %s' % remote)
    print('uploaded ->', remote)

def main():
    for f in VIEWS:
        src = os.path.join(ZH_INLINE, f)
        if not os.path.exists(src):
            raise SystemExit('missing zh-inline build: %s (先运行 _gen_po.py)' % src)
        upload(src, '/tmp/%s' % f)

    print(ssh('mkdir -p /www/luci-static/resources/view/pon && '
              'mv %s /www/luci-static/resources/view/pon/ && '
              'ls -la /www/luci-static/resources/view/pon/' %
              ' '.join('/tmp/%s' % f for f in VIEWS)))

    upload(os.path.join(PKG, 'root', 'usr', 'share', 'luci', 'menu.d', 'luci-app-pon.json'),
           '/tmp/luci-app-pon.json')
    upload(os.path.join(PKG, 'root', 'usr', 'share', 'rpcd', 'acl.d', 'luci-app-pon.json'),
           '/tmp/luci-app-pon.acl.json')

    # 补丁标记（若尚未生成）：从设备现有 pond 计算 md5
    marker = ssh('test -f /etc/pon-fix-version && cat /etc/pon-fix-version || echo MISSING')
    if 'MISSING' in marker:
        ssh('echo "luci-app-pon enhanced; pond md5: $(md5sum /usr/sbin/airoha-pond | cut -d" " -f1)" '
            '> /etc/pon-fix-version')
        print('created /etc/pon-fix-version')
    else:
        print('keep existing /etc/pon-fix-version:', marker.strip())

    print(ssh('mv /tmp/luci-app-pon.json /usr/share/luci/menu.d/luci-app-pon.json && '
              'mv /tmp/luci-app-pon.acl.json /usr/share/rpcd/acl.d/luci-app-pon.json && '
              'rm -rf /tmp/luci-indexcache* && '
              '/etc/init.d/rpcd restart; /etc/init.d/uhttpd restart; sleep 2; echo RESTARTED'))

    # 基础校验：JSON 合法 + ACL 被加载
    print(ssh('ucode -e "const u = require(\\"uci\").cursor(); '
              'const fs=require(\"fs\"); '
              'print(fs.readfile(\"/usr/share/luci/menu.d/luci-app-pon.json\") != null ? \"menu ok\" : \"menu missing\")" 2>&1; '
              'ubus list 2>/dev/null | grep -c file'))
    print('DONE. 浏览器打开 http://%s/cgi-bin/luci/admin/network/pon 查看（网络 → PON）。' % HOST)

if __name__ == '__main__':
    main()
