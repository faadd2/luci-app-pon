# luci-app-pon 增强版

基于上游 [pbs05/openwrt-pon-userspace/luci-app-pon](https://github.com/pbs05/openwrt-pon-userspace/tree/main/luci-app-pon) 的 fork，为 ZN504XG-D（PonWrt / ImmortalWrt，北京联通 10G-EPON）增强。

## 相对上游的改动

1. **新增「光链路」页**（optical.js）
   - 注册状态 / 收发光功率 / 温度 / 电压 / 偏置电流一览
   - debugfs FEC/PCS 计数器：不可纠错码字速率、误码秒、错误比特
   - 接收光功率与误码速率 mini 趋势图（每 3 秒采样，6 分钟窗口）
   - 链路健康评级徽标 + `EPON MAC error interrupt: 0x0800` 成因说明
   - 用途：光纤端面清洁、接头插拔的前后对比记录

2. **新增「事件日志」页**（events.js）
   - airoha-pond 守护进程事件流（OAM 发现 / CTC 交互 / 注册 / 告警）
   - 内核日志（logread -e airoha）自动刷新 + 关键字筛选

3. **诊断页新增「PON 补丁信息」区块**（diagnostics.js）
   - 显示 `/etc/pon-fix-version`，一眼确认兼容补丁版 airoha-pond 是否在位

4. **完整简体中文翻译**（po/zh_Hans/pon.po，290 条）

5. ACL 扩展：debugfs 只读、logread、timeout+pondctl events

## 目录结构

```
package/luci-app-pon/
├── Makefile                       # OpenWrt/ImmortalWrt 包定义（luci.mk）
├── htdocs/luci-static/resources/view/pon/
│   ├── status.js                  # 状态总览（上游原样）
│   ├── optical.js                 # ★ 光链路（新增）
│   ├── config.js                  # 注册配置（上游原样）
│   ├── hardware.js                # 硬件标识（上游原样）
│   ├── events.js                  # ★ 事件日志（新增）
│   ├── diagnostics.js             # 诊断（新增补丁信息区块）
│   ├── _extract_msgids.py         # 维护工具：提取待翻译字符串
│   ├── _gen_po.py                 # 维护工具：生成 po + 中文内联 JS
│   └── _zh_inline/                # 生成的中文内联 JS（免 lmo 直装）
├── root/usr/share/luci/menu.d/luci-app-pon.json
├── root/usr/share/rpcd/acl.d/luci-app-pon.json
└── po/zh_Hans/pon.po
```

## 两种使用方式

### A. 直接部署到运行中的设备（免编译，中文内联）

```bash
python deploy_luci.py
```

上传 `_zh_inline/` 中文内联 JS + 菜单 + ACL，写 `/etc/pon-fix-version`，重启 rpcd/uhttpd。
浏览器打开 `http://192.168.1.1/cgi-bin/luci/admin/network/pon`。

### B. 编译进固件（正规 i18n）

把 `package/luci-app-pon/` 复制到 PonWrt 源码树（与上游 luci-app-pon 同名，会覆盖 feed 版本）：

```bash
cp -r package/luci-app-pon /path/to/ponwrt/package/
# 若 feeds 里已选上游 luci-app-pon，取消它，改选本地的
./scripts/feeds install -a -p luci   # 或直接在 menuconfig 里选
make menuconfig  # LuCI → Applications → luci-app-pon
make package/luci-app-pon/{clean,compile}
```

po 由 luci.mk 自动编译成 lmo；语言选简体中文即显示中文。

改翻译后重新生成：

```bash
cd htdocs/luci-static/resources/view/pon
python _extract_msgids.py   # 更新 _msgids.json
# 编辑 _gen_po.py 里的 ZH 翻译表
python _gen_po.py           # 重新生成 pon.po 和 _zh_inline/
```

## 与超级 ONU 套件（luci-app-onu）的关系

两者并行维护，编译固件时任选其一：

| | luci-app-pon（本项目） | luci-app-onu（超级 ONU 套件） |
|---|---|---|
| 定位 | 简洁：状态/配置/硬件 + 光链路 + 事件日志 | 全面：六核心页 + 上网/IPTV/语音业务模块 |
| 菜单 | 挂在 Network 下 | 顶级 admin/onu |
| 适用 | 只要监控 PON 链路 | 光猫 + OpenWrt 合一，要管业务 VLAN |

同时安装会菜单并存但视图目录不同（view/pon vs view/onu），互不冲突，只是没必要。

## 注意事项

- `events.js` 用 `timeout 2 pondctl events` 掐事件流，依赖 busybox `timeout`（/usr/bin/timeout）
- 内核日志用 `/sbin/logread`（ubox 版）
- debugfs 不可用时光链路页自动降级为仅 ponctl 数据，并提示挂载命令
- `poll.add` 句柄在不同 LuCI 版本返回值不同；自动刷新复选框在老版本上可能无法停止轮询（不影响其他功能）
