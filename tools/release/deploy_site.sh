#!/usr/bin/env bash
# 把 web/ 同步到 ECS 的站点目录（https://xiaotu.online 的源）。
#
# 只发布静态页面：不涉及 OSS 上的安装包、手册与更新清单（那些仍由
# tools/release/publish_*.sh 负责）。
#
# 用法：
#   tools/release/deploy_site.sh                        # 用默认地址
#   DEPLOY_HOST=deploy@1.2.3.4 tools/release/deploy_site.sh
#   SKIP_LINK_CHECK=1 tools/release/deploy_site.sh      # 跳过死链门禁
#
# 前置条件（服务器只需做一次）：
#   1. 建 deploy 用户，把发布机的公钥写进 ~deploy/.ssh/authorized_keys
#   2. sudo mkdir -p /var/www/xiaotu && sudo chown -R deploy:www-data /var/www/xiaotu
#   3. nginx 站点配置见 packaging/nginx-xiaotu.conf

set -euo pipefail

HOST="${DEPLOY_HOST:-deploy@47.107.36.33}"
TARGET="${DEPLOY_PATH:-/var/www/xiaotu}"
PORT="${DEPLOY_PORT:-22}"
SKIP_LINK_CHECK="${SKIP_LINK_CHECK:-0}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE="$REPO_ROOT/web/"

# ---- ① 本地完整性：缺任何一个都说明 web/ 被改动过，先停下 ----
required=(index.html download/index.html 404.html assets/css/site.css assets/js/site.js
    assets/img/favicon.png sitemap.xml robots.txt)
for f in "${required[@]}"; do
    [ -f "$SOURCE/$f" ] || { echo "缺少站点文件：$SOURCE$f" >&2; exit 1; }
done
file_count="$(find "$SOURCE" -type f ! -name '.DS_Store' | wc -l | tr -d ' ')"
echo "===== 站点源：${SOURCE}（${file_count} 个文件）"

# ---- ② 死链门禁：页面里指向 dl.xiaotu.online 的链接必须都是 200 ----
# 下载域名与站点域名分开，页面只做「跳过去下载」，这里先把关，避免发出死链。
if [ "$SKIP_LINK_CHECK" = "1" ]; then
    echo "===== 死链门禁：已跳过"
else
    links="$(grep -rhoE 'https://dl\.xiaotu\.online/[A-Za-z0-9._~:/?#@!$&*+=-]*' "$SOURCE" \
        --include='*.html' | sort -u)"
    count="$(printf '%s\n' "$links" | grep -c . || true)"
    bad=0
    while IFS= read -r url; do
        [ -n "$url" ] || continue
        code="$(curl -s -o /dev/null -w '%{http_code}' -I --connect-timeout 10 --max-time 20 "$url" || echo 000)"
        if [ "$code" != "200" ]; then
            echo "  ✗ $url → HTTP $code" >&2
            bad=$((bad + 1))
        fi
    done <<< "$links"
    if [ "$bad" -gt 0 ]; then
        echo "有 $bad 个下载链接不可用，先修页面再发布（可用 SKIP_LINK_CHECK=1 强制跳过）" >&2
        exit 1
    fi
    echo "===== 死链门禁：$count 个链接均返回 200"
fi

# ---- ③ SSH 预检：公钥没配好时给一句人话，而不是 rsync 的报错 ----
if ! ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$PORT" "$HOST" 'true' 2>/dev/null; then
    echo "SSH 登录失败：${HOST}（端口 ${PORT}）" >&2
    echo "  - 确认发布机公钥已在 ~deploy/.ssh/authorized_keys" >&2
    echo "  - 或临时用 DEPLOY_HOST=user@host 指定可用的账号" >&2
    exit 1
fi

# ---- ④ 同步：--delete 让远端与 web/ 完全一致（站点目录只放站点文件）----
echo "===== 同步 $SOURCE → $HOST:$TARGET"
rsync -az --delete \
    --exclude '.DS_Store' \
    -e "ssh -p $PORT" \
    "$SOURCE" "$HOST:$TARGET/"

# ---- ⑤ 远端校验：入口页、下载页、样式与脚本都要在 ----
echo "===== 校验远端文件"
ssh -p "$PORT" "$HOST" "
    for f in index.html download/index.html 404.html assets/css/site.css assets/js/site.js; do
        test -f '$TARGET/'\"\$f\" || { echo \"缺少 \$f\" >&2; exit 1; }
    done
    echo \"远端文件数：\$(( \$(find '$TARGET' -type f | wc -l) ))\"
"
echo "发布完成：$TARGET"
echo "备案通过后执行 sudo certbot --nginx -d xiaotu.online -d www.xiaotu.online 签证书；"
echo "备案期间可用 curl -H 'Host: xiaotu.online' http://47.107.36.33/ 验证。"
