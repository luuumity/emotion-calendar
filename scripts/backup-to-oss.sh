#!/usr/bin/env bash
# emotion-calendar OSS 备份：sqlite3 在线备份 → gzip →（可选 GPG 加密）→ 上传 OSS
#
# 配置从 /etc/emotion-backup/oss.env 读取（含 AccessKey，仅存服务器，绝不入库）。
# 配置模板见同目录 oss.env.example。
# 加密开关：oss.env 中 BACKUP_ENCRYPT=1 时启用 GPG AES256 对称加密（默认 0 不加密），
# 开启加密需要 /etc/emotion-backup/gpg-passphrase 口令文件，并建议离线保存口令。
set -euo pipefail

OSS_ENV_FILE="${OSS_ENV_FILE:-/etc/emotion-backup/oss.env}"
DB_PATH="${DB_PATH:-/opt/emotion-calendar/data/emotion.db}"
OSSUTIL="${OSSUTIL:-/usr/local/bin/ossutil64}"
# shellcheck disable=SC1090
source "$OSS_ENV_FILE"

ENCRYPT="${BACKUP_ENCRYPT:-0}"
TS="$(date +%F-%H%M)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

sqlite3 "$DB_PATH" ".backup '${TMP}/emotion-${TS}.db'"
gzip -9 "${TMP}/emotion-${TS}.db"

if [ "$ENCRYPT" = "1" ]; then
  NAME="emotion-${TS}.db.gz.gpg"
  gpg --batch --yes --symmetric --cipher-algo AES256 \
    --passphrase-file /etc/emotion-backup/gpg-passphrase \
    -o "${TMP}/${NAME}" "${TMP}/emotion-${TS}.db.gz"
else
  NAME="emotion-${TS}.db.gz"
fi

"$OSSUTIL" -e "$OSS_ENDPOINT" -i "$OSS_ACCESS_KEY_ID" -k "$OSS_ACCESS_KEY_SECRET" \
  cp -f "${TMP}/${NAME}" "oss://${OSS_BUCKET}/backups/${NAME}" >/dev/null

echo "UPLOADED: backups/${NAME} ($(stat -c%s "${TMP}/${NAME}") bytes, encrypt=${ENCRYPT})"
