#!/usr/bin/env bash
# 把 web/ 同步到 ECS 的站点目录。
#
# 只发布静态页面：不涉及 OSS 上的安装包、手册与更新清单（那些仍由
# packaging/publish_*.sh 与 Windows 侧 publish_site.ps1 负责）。
#
# 用法：
#   packaging/deploy_site.sh                 # 用默认地址
#   DEPLOY_HOST=deploy@1.2.3.4 packaging/deploy_site.sh
#
# 前置条件（服务器只需做一次）：
#   1. 建 deploy 用户，把发布机的公钥写进 ~deploy/.ssh/authorized_keys
#   2. sudo mkdir -p /var/www/xiaotu && sudo chown -R deploy:www-data /var/www/xiaotu
#   3. nginx 站点配置见 packaging/nginx-xiaotu.conf

set -euo pipefail

HOST="${DEPLOY_HOST:-deploy@47.107.36.33}"
TARGET="${DEPLOY_PATH:-/var/www/xiaotu}"
PORT="${DEPLOY_PORT:-22}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$REPO_ROOT/web/"

if [ ! -f "$SOURCE/index.html" ]; then
    echo "找不到站点源文件：$SOURCE/index.html" >&2
    exit 1
fi

echo "===== 同步 $SOURCE → $HOST:$TARGET"
rsync -az --delete \
    --exclude '.DS_Store' \
    -e "ssh -p $PORT" \
    "$SOURCE" "$HOST:$TARGET/"

echo "===== 校验远端文件"
ssh -p "$PORT" "$HOST" "test -f '$TARGET/index.html' && test -f '$TARGET/download/index.html'"
echo "远端文件就位：$TARGET/index.html"

echo
echo "发布完成。备案通过后访问 https://xiaotu.online/ 复核；"
echo "备案期间可用 curl -H 'Host: xiaotu.online' http://<内网或公网地址>/ 验证（80 端口可能被拦截）。"
