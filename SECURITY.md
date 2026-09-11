# 安全政策（Security Policy）

本项目将安全放在首位。感谢你帮助我们发现并修复漏洞。

## 支持的版本（Supported Versions）

| 版本 | 支持情况 |
|---|---|
| 4.3.x（当前） | ✅ 修复与安全更新 |
| < 4.3 | ⚠️ 仅高危漏洞修复，不保证及时 |

## 报告漏洞（Reporting a Vulnerability）

**请勿在公开 Issue 中披露可利用的漏洞细节。**

请将敏感漏洞通过以下渠道报告（任选其一）：

- GitHub Security Advisory：仓库页面 → **Security → Report a vulnerability**
- 或向维护者邮箱发送邮件（`GitHub 账号 xhxczggrhz-creator` 的公开邮箱）

### 我们的承诺
- **48 小时内**回复确认收到报告。
- 评估并修复后，在公开披露前 **90 天**窗口内与你同步进度。
- 未经你同意，不公开你的身份（可署名 up-to-you）。

## 已知安全边界（生产环境的如实说明）

| 项 | 说明 |
|---|---|
| DNS 复查链 | `chrome.dns` 是 Chrome **Dev/Beta** 渠道专属 API，稳定版整条 DNS 复查链不生效；真正兜底是 URL 字面 IP 拦截 + 浏览器自带 DNS/Secure DNS。 |
| 使用范围 | 本项目是浏览器扩展，权限运行在用户本地，纯 HTTP 直连，**无 P2P / BT / 磁力链接，不出网上报任何数据**。 |

## 防御原则
- 所有代理请求均做 SSRF 防护（协议白名单 + IP 字面私有段拦截 + 条件性 DNS 复查）。
- 消息总线做来源校验，拒绝外部页面/进程驱动后台代理。
- 敏感载荷（带防盗链签名的 URL、Cookie、DRM 相关凭据）仅存 `chrome.storage.session`，会话级、读取即清除，绝不落盘。
- 所有下载页与敏感中转有 frame-busting、扩展白名单与 URL 参数消毒。