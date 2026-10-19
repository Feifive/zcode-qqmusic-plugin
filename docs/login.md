# QQ 音乐扫码登录

点击歌词条右侧的 ♪，在「QQ 音乐账号」选择 QQ 或微信扫码，用对应手机应用扫描并确认。登录后显示 QQ 音乐昵称、圆形头像，以及能确认的会员标识；退出登录会删除本机保存的凭据。二维码过期可刷新，QQ 被风控拦截时可改用微信。

关闭设置、滚动离开歌词条或离开页面时会取消当前扫码。取消、切换方式、刷新、退出后的迟到响应不会恢复账号。微信采用最长 25 秒的长轮询，QQ 每次检查至少间隔 1.5 秒。

## 存储与边界

主进程使用 Electron `safeStorage` 加密完整会话，原子保存到 `~/Library/Application Support/ZCode Music/qq-session.enc`，文件权限为 `0600`。macOS 的加密密钥由 Keychain 管理。系统加密不可用时仅在内存保留，并在面板明确提示；不降级为明文。升级保留此文件。退出登录删除文件，不会退出手机或 QQ 音乐桌面客户端。

渲染进程只接收二维码图片、随机会话 ID、状态与账号摘要，不接收 qrsig、OAuth code、cookie 或 musickey。复用既有 `configure({account:{action,...}})` IPC，继续校验官方渲染页面与主 frame，固定加载器 v1 无需变更。

QQ 路径：`ptqrshow` → `ptqrlogin` → 限定 QQ 域名的重定向 → `graph.qq.com/oauth2.0/authorize` → `QQConnectLogin.LoginServer.QQLogin`。微信路径：`qrconnect` → 长轮询 → `music.login.LoginServer.Login`。凭据兑换依次使用 `u.y / szu.y / shu.y` 网关。QQ 网页的 `p_skey` 不视为音乐登录成功；必须取得音乐 key 和账号 ID。响应中的超长整数在解析前保留为字符串。

会话恢复不通过资料接口判定登录是否有效，因此「已登录」表示本机持有登录凭据，不保证服务端会话仍有效。0.3.15 起已接入红心收藏，使用方法及会话失效处理见 [收藏说明](favorites.md)；其它歌单操作尚未接入。歌词和播放控制继续使用现有实现。

## 昵称、头像与会员

0.3.10 起，打开设置或扫码成功后，会在后台读取 QQ 音乐个人主页 `fcg_get_profile_homepage.fcg` 的账号资料，优先于登录响应中的 QQ / 微信昵称。已有加密会话可以直接补全，无需为更新资料重新扫码。头像只从 QQ 图片域名读取，限制图片大小与格式，以内联图片传给界面；下载图片不携带登录 cookie，缺失或加载失败时显示昵称首字。

0.3.13 起，会员资料优先从 QQ / 微信登录兑换响应的 `data.identity` 解析，并与会话一起加密保存。只保存会员字段白名单，不保留整个登录响应；界面接收的是归一化权益与主标识，不接收原始登录数据。旧会话缺少身份快照时，才使用 `VipLogin.VipLoginInter.vip_login_base` 补查；已有快照时，更新昵称和头像不会额外调用会员接口。失败不覆盖已知权益，也不退出账号。

会员权益是并行字段：`vip`、`HugeVip` 按非零为真，`eight`、`twelve` 按等于 1 为真。按 2026-10-19 修订的客户端分析，当前产品矩阵为：`vip=1, HugeVip=0` 是豪华绿钻；`vip=1, HugeVip=1` 是超级会员。历史字段名 `HugeVip` 不能按字面翻译成豪华绿钻。界面优先显示“超级会员 SVIP3”，其次“豪华绿钻 VIP3”，不再使用“绿钻会员”文案。

保留原始等级、下一等级、年费与各类权益的起止时间；悬停可查看并行的年费、8 元 / 12 元付费包。归一化权益中的 `luxuryVip` 对应 `identity.vip`，`superVip` 对应 `identity.HugeVip`；`greenVip` 保留为前者的兼容别名。旧 `svip` 标志与 `send` 到期时间仅保留为遗留权益，不独立判断超级会员。只有模糊标志或付费包时显示“音乐会员”。

已知日期按中国时区或显式时间戳在本地判定到期，只移除相应权益，不修改原始快照。无法解析的到期时间保持未知，不推断为过期。普通资料的六小时缓存到期不会抹掉登录快照。当前不实现 WNS 增量更新，购买、续费或等级变化可通过重新扫码取得新快照；音质可播放能力不作为会员产品类型的判断依据。

0.3.11 修正会员字段映射后，会自动废弃旧规则缓存的标识，立即重新读取资料，保留登录、昵称和头像。

0.3.14 按修订后的当前产品矩阵纠正映射，已有身份快照按新规则直接重新计算，无需再次查询会员接口或重新扫码。

昵称、头像等完整资料缓存 6 小时，不完整或失败的读取至少间隔 5 分钟。昵称、头像和会员快照随原会话加密保存；退出账号或切换登录后的迟到资料不会恢复旧账号。旧版本只保存主标识、没有原始身份字段的会话会自动补查，保留登录与头像。更新资料复用受信任的账号 IPC，不向界面开放任意 URL 请求或 cookie 读取。

## 验证

`npm test` 包含 QQ / 微信兑换、资料解析、会员判断、头像大小与域名边界、资料缓存与竞态、加密文件和 IPC 信任边界回归。`preview.html?login=waiting|success|expired|error|slow` 提供扫码模拟；`?login=account&member=luxury|svip|member|none` 预览已登录资料，`?login=avatar-error` 预览头像失败。均使用模拟资料，二维码不能用于实际登录。

2026-10-18 实测 QQ 和微信官方接口均可获取有效二维码并返回等待扫码。完整的手机确认、真实凭据兑换与重启恢复需要实际账号扫码验证。

协议实现参考 [kendu76/dsh-music-player/lib/qq.js](https://github.com/kendu76/dsh-music-player/blob/main/lib/qq.js)；MIT 许可声明随 `plugin/lib/qq-gateway.js` 一同分发。

个人主页协议参照 [qq-music-api 的 getUserDetail](https://github.com/sansenjian/qq-music-api/blob/main/src/services/apis/user/getUserDetail.ts)，会员字段参照 [QQMusicAPI 的用户模型](https://github.com/l-1124/qqmusicapi/blob/main/qqmusic_api/models/user.py)。本实现独立编写解析与缓存逻辑。
