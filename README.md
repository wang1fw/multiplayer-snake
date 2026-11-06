# 霓虹贪吃蛇 · 多人联机版

一个开箱即用的多人联机贪吃蛇网页游戏：账号注册登录、服务器权威判定、同一张地图实时对战、排行榜与战绩存档。前端使用原生 Canvas 渲染，后端使用 Node.js + Express + Socket.IO。

## 功能

- 账号注册 / 登录，密码使用 scrypt 加盐哈希存储，登录态有效期 7 天
- 所有在线玩家共享同一张地图，实时同步蛇的位置、食物和碰撞
- 服务器权威逻辑：移动、进食、撞墙、撞身体、正面相撞、死亡与重生全部由服务端判定
- 实时排行榜、历史最高分、在线人数、小地图
- 键盘（WASD / 方向键）与触屏（方向键 / 滑动）双操作方式，适配手机横竖屏
- 死亡后倒计时自动重生，也可点击按钮提前重生
- 无需数据库，数据保存在 `data/` 目录的 JSON 文件中

## 快速开始

需要 Node.js 18 及以上版本。

```bash
npm install
npm start
```

浏览器打开 <http://localhost:3000>，注册一个账号即可开始游戏。

### 让其他人登录游玩

**同一局域网（最简单）**：启动后终端会打印局域网地址，例如：

```
本机访问：http://localhost:3000
局域网访问：http://192.168.1.23:3000
```

把 `http://192.168.1.23:3000` 发给同一 WiFi 下的朋友，对方打开后注册账号就能和你一起玩。

**公网访问**：把项目部署到云服务器，开放 3000 端口后通过 `http://服务器公网IP:3000` 访问。建议使用 Nginx 反向代理并启用 HTTPS，同时为 WebSocket 配置升级头：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

没有公网服务器时，也可以使用内网穿透工具把本地 3000 端口映射到公网。

**异地朋友（不在同一个 WiFi）：能不能用 GitHub Pages 给个网址？**

不能。GitHub Pages 只能托管静态文件（HTML/CSS/JS），**不能运行 Node.js 进程**，而这个游戏必须有后端：Express 处理注册登录、Socket.IO 长连接推送状态、每 130ms 跑一次服务端权威的碰撞判定、还会把账号写进 `data/`。把代码传到 GitHub Pages 只会得到一个打得开但永远"正在连接服务器…"的页面。

正确的做法是：**GitHub 存代码 + 支持 Node 的托管平台运行**，这样也能拿到一个真正的网址：

1. 把仓库推到 GitHub（`.gitignore` 已排除 `node_modules/`、`data/`）。
2. 打开 <https://render.com> → New + → **Web Service**（或 Blueprint，仓库根目录已带 `render.yaml`）→ 连接这个仓库。
   - Runtime 选 `Node`，Build Command 填 `npm install`，Start Command 填 `npm start`
   - 部署完成后会得到一个 `https://<名字>.onrender.com` 的固定网址，发给朋友就能玩
3. 注意免费实例的两个限制：
   - **磁盘是临时的**：重新部署 / 重启后 `data/` 里的账号和战绩会重置（想长期存档就换云服务器，或给实例挂付费磁盘并设置 `DATA_DIR`）
   - 长时间没人访问会休眠，第一位访问者需要等约 30 秒冷启动；有人在线玩游戏时会保持唤醒

其它可选平台：Fly.io、Koyeb、Railway（需付费额度）、云服务器。Vercel / Netlify / GitHub Pages 不支持常驻 WebSocket 服务端，不适用。

## 玩法

1. 进入对局后蛇会先在出生点**原地待命**，第一次按 `WASD` 或方向键才决定起步方向（四个方向都行，包括原地掉头）；手机上用屏幕方向键或在画布上滑动。
2. 吃掉绿色食物 +10 分并增长 1 节，金色食物 +30 分并增长 3 节。
3. 地图四周有醒目的红色警戒线，贴近边界时内侧危险带会变亮；镜头跟随时边界线可能在屏幕外，此时屏幕对应的一侧会出现红色贴边预警，提示"墙还有几格"。
4. 撞到地图边界、自己身体、其他玩家的身体，或与其他蛇头正面相撞都会出局。
5. 出局后 2.2 秒自动重生，重生后同样会先待命等你操作；本局分数清零，历史最高分会保存到账号。
6. 击杀其他玩家可获得击杀数加成展示，实时排行榜按本局分数排序。

## 配置

| 配置项 | 位置 | 说明 |
| --- | --- | --- |
| 端口 | 环境变量 `PORT` | 默认 `3000`，例如 `PORT=8080 npm start` |
| 移动速度 | `src/game.js` 的 `TICK_MS` | 每个网格移动间隔，默认 130ms |
| 地图大小 | `src/game.js` 的 `WORLD_WIDTH` / `WORLD_HEIGHT` | 默认 80 × 50 格 |
| 食物数量 | `src/game.js` 的 `MAX_FOOD` | 默认 70 |
| 出生点安全距离 | `src/game.js` 的 `SPAWN_CLEARANCE` | 出生点四周至少留出的空格数，默认 10 |
| 开局待命时长 | `src/game.js` 的 `SPAWN_HOLD_MS` | 等待玩家第一次操作的最长时间，默认 30000ms，超时后自动起步 |
| 重生延迟 | `src/game.js` 的 `RESPAWN_DELAY_MS` | 默认 2200ms |

## 项目结构

```
server.js              HTTP 接口、Socket.IO 实时对战、游戏循环
src/auth.js            账号、密码哈希、会话与排行榜持久化
src/game.js            服务器权威的游戏世界与碰撞逻辑
public/index.html      登录页 + 游戏界面
public/css/style.css   界面样式
public/js/app.js       登录、网络同步、Canvas 渲染、操作输入
test/e2e.test.js       游戏规则单元测试 + 双人联机端到端测试
data/                  运行时生成，保存账号、会话与战绩
```

## 测试

```bash
npm test
```

测试会自动启动一个临时服务器（端口 3100），覆盖注册登录、鉴权、双人连接、状态同步、移动、断线移除，以及撞墙、进食、自撞、正面相撞等游戏规则。

## 安全说明

- 密码不会以明文存储，使用带随机盐的 scrypt 哈希。
- 登录和注册接口带简易限流，避免暴力尝试。
- 公网部署时请务必配置 HTTPS，并定期备份 `data/` 目录。
- 当前会话 token 保存在浏览器 localStorage 中，请勿在公共设备上登录。