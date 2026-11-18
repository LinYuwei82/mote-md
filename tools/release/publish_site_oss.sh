#!/usr/bin/env bash
# 把 web/ 整站发布到 OSS 静态站桶（备案前的公网镜像）。
#
# 与 dl.xiaotu.online 使用的更新桶完全分开：这里只放网页，不碰安装包、
# 手册和更新清单；安装包仍由 publish_macos.sh / publish_windows.sh 发布。
#
# 注意：OSS 默认域名（*.aliyuncs.com）对 HTML 强制下载（x-oss-force-download），
# 只适合 curl 校验；给人看必须先绑定自定义域名（如 pre.xiaotu.online）。
#
# 用法：
#   tools/release/publish_site_oss.sh
#   SITE_BUCKET=xiaotu-site tools/release/publish_site_oss.sh
#
# 依赖：python3 + oss2。系统 Python 受 PEP 668 保护不能直接装，
# 推荐用专用虚拟环境：python3 -m venv ~/.venvs/xiaotu-oss &&
# ~/.venvs/xiaotu-oss/bin/pip install oss2（脚本会自动使用它）。
# 凭据：与其它发布脚本共用 ~/.config/xiaotu-updates/.env

set -euo pipefail

# oss2 装在专用虚拟环境里时自动切换，避免每次手动加 PATH
PYTHON="${PYTHON:-python3}"
if ! "$PYTHON" -c 'import oss2' >/dev/null 2>&1; then
    if [ -x "$HOME/.venvs/xiaotu-oss/bin/python3" ]; then
        PYTHON="$HOME/.venvs/xiaotu-oss/bin/python3"
    fi
fi

OSS_ENV_FILE="${OSS_ENV_FILE:-$HOME/.config/xiaotu-updates/.env}"
SITE_BUCKET="${SITE_BUCKET:-xiaotu-site}"
SITE_ENDPOINT="${SITE_ENDPOINT:-https://oss-cn-hongkong.aliyuncs.com}"
SITE_PUBLIC_URL="${SITE_PUBLIC_URL:-https://$SITE_BUCKET.oss-cn-hongkong.aliyuncs.com}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE="$REPO_ROOT/web"

[ -f "$SOURCE/index.html" ] || { echo "找不到 $SOURCE/index.html" >&2; exit 1; }
[ -f "$SOURCE/404.html" ] || { echo "找不到 $SOURCE/404.html" >&2; exit 1; }
[ -f "$OSS_ENV_FILE" ] || { echo "找不到凭据文件 $OSS_ENV_FILE" >&2; exit 1; }

# 本地不该出现的东西不发布
if grep -rl "127.0.0.1\|localhost" "$SOURCE" --include="*.html" >/dev/null 2>&1; then
    echo "站点里有 localhost 链接，先清理再发布" >&2
    exit 1
fi

echo "===== 发布 $SOURCE → oss://$SITE_BUCKET"

"$PYTHON" - "$OSS_ENV_FILE" "$SITE_BUCKET" "$SITE_ENDPOINT" "$SOURCE" <<'PY'
import os
import sys

env_file, bucket_name, endpoint, source = sys.argv[1:5]

env = {}
for line in open(env_file, encoding="utf-8"):
    line = line.strip()
    if line.startswith("export "):
        k, v = line[7:].split("=", 1)
        env[k] = v.strip().strip('"').strip("'")

try:
    import oss2
except ImportError:
    sys.exit("缺少 oss2：python3 -m venv ~/.venvs/xiaotu-oss && ~/.venvs/xiaotu-oss/bin/pip install oss2")

auth = oss2.Auth(env["OSS_ACCESS_KEY_ID"], env["OSS_ACCESS_KEY_SECRET"])
bucket = oss2.Bucket(auth, endpoint, bucket_name)

try:
    bucket.get_bucket_info()
except oss2.exceptions.NoSuchBucket:
    bucket.create_bucket(oss2.BUCKET_ACL_PUBLIC_READ)
    print("已创建桶", bucket_name)

# 新桶默认开启「阻止公共访问」，会让 public-read 的静态站返回 403，必须关掉
try:
    bucket.put_bucket_public_access_block(block_public_access=False)
except TypeError:
    bucket.put_bucket_public_access_block(
        oss2.models.PublicAccessBlockConfiguration(block_public_access=False)
    )
except Exception as exc:  # 权限不足时给出明确提示，而不是静默 403
    sys.exit(f"关闭「阻止公共访问」失败，请在 OSS 控制台手动关闭：{exc}")

bucket.put_bucket_acl(oss2.BUCKET_ACL_PUBLIC_READ)

# 必须打开 SupportSubDir，否则 /xiaotu/、/download/ 这类子目录都会返回根
# index.html（oss2 的 put_bucket_website 不会带这个字段，只能直接发 XML）
def put_website_config():
    import base64
    import email.utils
    import hashlib
    import hmac
    import urllib.request

    host = endpoint.split("://", 1)[-1].rstrip("/")
    url = f"https://{bucket_name}.{host}/?website"
    body = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        "<WebsiteConfiguration>"
        "<IndexDocument><Suffix>index.html</Suffix>"
        "<SupportSubDir>true</SupportSubDir><Type>0</Type></IndexDocument>"
        "<ErrorDocument><Key>404.html</Key><HttpStatus>404</HttpStatus></ErrorDocument>"
        "</WebsiteConfiguration>"
    ).encode()
    date = email.utils.formatdate(usegmt=True)
    string_to_sign = f"PUT\n\napplication/xml\n{date}\n/{bucket_name}/?website"
    signature = base64.b64encode(
        hmac.new(
            env["OSS_ACCESS_KEY_SECRET"].encode(),
            string_to_sign.encode(),
            hashlib.sha1,
        ).digest()
    ).decode()
    request = urllib.request.Request(url, data=body, method="PUT")
    request.add_header("Date", date)
    request.add_header("Content-Type", "application/xml")
    request.add_header(
        "Authorization", f"OSS {env['OSS_ACCESS_KEY_ID']}:{signature}"
    )
    urllib.request.urlopen(request, timeout=15).read()

put_website_config()

TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".pdf": "application/pdf",
}

def cache_control(key):
    if key.endswith(".html"):
        return "no-cache"
    if key.startswith("assets/"):
        return "public, max-age=604800"
    return "public, max-age=3600"

uploaded = []
for root, dirs, files in os.walk(source):
    dirs[:] = [d for d in dirs if not d.startswith(".")]
    for name in files:
        if name == ".DS_Store":
            continue
        path = os.path.join(root, name)
        key = os.path.relpath(path, source).replace(os.sep, "/")
        ext = os.path.splitext(name)[1].lower()
        headers = {
            "Content-Type": TYPES.get(ext, "application/octet-stream"),
            "Cache-Control": cache_control(key),
        }
        bucket.put_object_from_file(key, path, headers=headers)
        uploaded.append(key)

# 删掉桶里多余的对象（这个桶只放站点，安全）
keep = set(uploaded)
removed = 0
for obj in oss2.ObjectIterator(bucket):
    if obj.key not in keep:
        bucket.delete_object(obj.key)
        removed += 1

print(f"上传 {len(uploaded)} 个文件，清理 {removed} 个旧对象")
PY

echo "===== 线上校验 $SITE_PUBLIC_URL"
fail=0
for path in / /xiaotu/ /devcard/ /mote/ /download/ /docs/ /about/ /privacy/ /assets/css/site.css "/no-such-page"; do
    expected=200
    if [ "$path" = "/no-such-page" ]; then
        expected=404
    fi
    code=$(curl -s -m 10 -o /dev/null -w "%{http_code}" "$SITE_PUBLIC_URL$path")
    if [ "$code" != "$expected" ]; then
        echo "  ✗ ${path} 期望 ${expected}，实际 ${code}"
        fail=1
    else
        echo "  ✓ $path $code"
    fi
done
[ "$fail" = 0 ] || { echo "线上校验失败" >&2; exit 1; }

echo
echo "发布完成：oss://${SITE_BUCKET}（默认域名仅用于 curl 校验，浏览器会强制下载 HTML）"
echo "绑定自定义域名后可访问：https://pre.xiaotu.online/"
echo "备案通过后主站切到 https://xiaotu.online/（ECS），此桶可作为预发布镜像保留或下线。"
