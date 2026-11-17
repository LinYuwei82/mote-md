#!/usr/bin/env bash
# 续期 pre.xiaotu.online 的 Let's Encrypt 证书，并更新 OSS 自定义域名的证书。
#
# 方式：HTTP-01。挑战文件直接写入 OSS 静态站桶，验证完再删掉。
# 证书到期前 30 天内运行才会真正续期，其余时间 certbot 只会检查并跳过。
#
# 依赖：~/.config/xiaotu-updates/.env 里的 OSS AK/SK；首次运行会自动创建
#       ~/.config/xiaotu-updates/venv 并安装 certbot + oss2。
#
# 手动运行：packaging/renew_site_cert.sh

set -euo pipefail

DOMAIN="${SITE_DOMAIN:-pre.xiaotu.online}"
BUCKET="${SITE_BUCKET:-xiaotu-site}"
ENV_FILE="${OSS_ENV_FILE:-$HOME/.config/xiaotu-updates/.env}"
CONF_DIR="${ACME_CONFIG_DIR:-$HOME/.config/xiaotu-updates/acme}"
CERT_DIR="${CERT_OUT_DIR:-$HOME/.config/xiaotu-updates/site-cert}"
VENV="${ACME_VENV:-$HOME/.config/xiaotu-updates/venv}"

[ -f "$ENV_FILE" ] || { echo "找不到凭据文件 $ENV_FILE" >&2; exit 1; }

if [ ! -x "$VENV/bin/certbot" ]; then
    echo "===== 初始化 venv：$VENV"
    python3 -m venv "$VENV"
    "$VENV/bin/pip" install -q --upgrade pip
    "$VENV/bin/pip" install -q oss2 certbot
fi

mkdir -p "$CONF_DIR" "$CERT_DIR"
chmod 700 "$CERT_DIR"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/auth.sh" <<'HOOK'
#!/usr/bin/env bash
set -euo pipefail
source "$OSS_ENV_FILE"
"$ACME_VENV/bin/python" - "$CERTBOT_TOKEN" "$CERTBOT_VALIDATION" <<'PY'
import os, sys, oss2
token, validation = sys.argv[1:3]
bucket = oss2.Bucket(
    oss2.Auth(os.environ["OSS_ACCESS_KEY_ID"], os.environ["OSS_ACCESS_KEY_SECRET"]),
    "https://oss-cn-hongkong.aliyuncs.com",
    os.environ["SITE_BUCKET"],
)
bucket.put_object(
    ".well-known/acme-challenge/" + token,
    validation.encode(),
    headers={"Content-Type": "text/plain", "Cache-Control": "no-cache"},
)
PY
HOOK

cat > "$WORK/cleanup.sh" <<'HOOK'
#!/usr/bin/env bash
set -euo pipefail
source "$OSS_ENV_FILE"
"$ACME_VENV/bin/python" - "$CERTBOT_TOKEN" <<'PY'
import os, sys, oss2
bucket = oss2.Bucket(
    oss2.Auth(os.environ["OSS_ACCESS_KEY_ID"], os.environ["OSS_ACCESS_KEY_SECRET"]),
    "https://oss-cn-hongkong.aliyuncs.com",
    os.environ["SITE_BUCKET"],
)
bucket.delete_object(".well-known/acme-challenge/" + sys.argv[1])
PY
HOOK

chmod +x "$WORK/auth.sh" "$WORK/cleanup.sh"

COMMON_ARGS=(
    --manual --preferred-challenges http
    --manual-auth-hook "$WORK/auth.sh"
    --manual-cleanup-hook "$WORK/cleanup.sh"
    --config-dir "$CONF_DIR" --work-dir "$CONF_DIR/work" --logs-dir "$CONF_DIR/logs"
    --non-interactive
)

export OSS_ENV_FILE="$ENV_FILE" ACME_VENV="$VENV" SITE_BUCKET="$BUCKET"

if [ -f "$CONF_DIR/live/$DOMAIN/fullchain.pem" ]; then
    echo "===== certbot renew（未到期会自动跳过）"
    "$VENV/bin/certbot" renew --cert-name "$DOMAIN" "${COMMON_ARGS[@]}"
else
    echo "===== 首次签发"
    "$VENV/bin/certbot" certonly "${COMMON_ARGS[@]}" -d "$DOMAIN" \
        --agree-tos --register-unsafely-without-email
fi

install -m 600 "$CONF_DIR/live/$DOMAIN/fullchain.pem" "$CERT_DIR/fullchain.pem"
install -m 600 "$CONF_DIR/live/$DOMAIN/privkey.pem" "$CERT_DIR/privkey.pem"

echo "===== 更新 OSS 自定义域名证书"
"$VENV/bin/python" - "$ENV_FILE" "$BUCKET" "$DOMAIN" "$CERT_DIR" <<'PY'
import sys
import oss2

env_file, bucket_name, domain, cert_dir = sys.argv[1:5]

env = {}
for line in open(env_file, encoding="utf-8"):
    line = line.strip()
    if line.startswith("export "):
        k, v = line[7:].split("=", 1)
        env[k] = v.strip().strip('"').strip("'")

cert = open(f"{cert_dir}/fullchain.pem", encoding="utf-8").read()
key = open(f"{cert_dir}/privkey.pem", encoding="utf-8").read()

bucket = oss2.Bucket(
    oss2.Auth(env["OSS_ACCESS_KEY_ID"], env["OSS_ACCESS_KEY_SECRET"]),
    "https://oss-cn-hongkong.aliyuncs.com",
    bucket_name,
)
request = oss2.models.PutBucketCnameRequest(
    domain,
    oss2.models.CertInfo(certificate=cert, private_key=key, force=True),
)
bucket.put_bucket_cname(request)
print("证书已提交，OSS 侧生效通常需要几分钟")
PY

echo "===== 校验 HTTPS"
code=$(curl -s -m 20 -o /dev/null -w "%{http_code}" "https://$DOMAIN/")
if [ "$code" != "200" ]; then
    echo "HTTPS 校验失败：$code" >&2
    exit 1
fi
echo "HTTPS 正常：https://$DOMAIN/"
