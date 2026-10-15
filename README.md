# coding伴侣

面向家庭 NAS 的短剧网页服务与 Android TV 客户端。TV 端通过 WebView 使用 NAS 页面，并为部分电视提供系统硬件解码播放路径。

> 第三方非官方项目，仅供个人学习研究。内容与接口可用性取决于第三方服务，请遵守所在地法律、内容版权和上游项目许可，禁止商用。

## 包含内容

- `android-tv/`：Android TV 客户端源码与构建脚本
- `nas/`：FastAPI 网页服务、缓存、家庭档案、播放准备、CENC 解密衔接和网页资源
- `scripts/prepare-nas-runtime.sh`：从公开上游锁定版本组装 NAS 运行时

仓库不包含任何现有 NAS 的 IP、域名、密码、令牌、证书、数据库、观看记录、缓存、签名密钥或远程部署脚本。NAS Compose 默认只监听 `127.0.0.1`，不会直接暴露到公网。

## NAS 部署

需要 Docker、Docker Compose、Git，并自行准备合法可用的游客态设备参数。

```bash
cp nas/.env.example nas/.env
cp nas/private/config.example.json nas/private/config.json
# 编辑上述两个文件，填入你自己的配置
./scripts/prepare-nas-runtime.sh
docker compose -f nas/compose.yaml build
docker compose -f nas/compose.yaml up -d
```

默认只可从 NAS 本机访问 `http://127.0.0.1:8010/ui`。如果需要让家庭电视访问，把 `nas/.env` 的 `NAS_BIND_IP` 设置为该 NAS 自己的局域网地址，然后重启服务。客户端地址可使用 `http://` 或 `https://`；只有浏览器设备直连播放依赖 HTTPS 安全上下文，普通网页播放和 TV 访问均可使用 HTTP。不要把端口映射到公网；远程访问建议使用自建 VPN。

## Android TV 构建

需要 JDK 21、Android SDK Platform 35 与 Build Tools 35.0.0。

```bash
cd android-tv
ANDROID_SDK_ROOT=/path/to/android-sdk JAVA_HOME=/path/to/jdk21 bash build.sh
```

APK 首次启动会显示服务器地址设置。示例地址只是占位符，必须改成你自己的 NAS 地址；仓库不会连接作者的 NAS。

TV 端保存两个可编辑地址，两个地址都可以填写 `http://` 或 `https://`。

1.0.40 增加旧版 Android WebView 登录兼容和明确的登录页背景，并加入可开关的自动下一集控制。

发布包已经过 Android 35 构建、APK 签名校验和 NAS 单元测试；不同 NAS 与电视环境仍需部署者自行验证网络连通性。

## 安全边界

- `.env`、`nas/private/`、`nas/run/`、数据库、缓存、证书和 APK 构建目录均被 Git 忽略。
- Compose 默认绑定回环地址；公开仓库不提供公网反向代理配置。
- 登录密码和管理令牌只保存在部署者自己的 NAS 上。
- 请勿提交真实设备参数、Cookie、Token 或观看数据。

## 第三方依赖

核心接口、签名与解密运行时在部署时从 [`zhangbaio/hongguo`](https://github.com/zhangbaio/hongguo) 的锁定提交获取，不在本仓库重新分发。详情见 [NOTICE.md](NOTICE.md)。
