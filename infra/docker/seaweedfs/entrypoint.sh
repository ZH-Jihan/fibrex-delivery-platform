#!/bin/sh
# Starts SeaweedFS as a single-node S3-compatible store for local development.
#
# MinIO no longer publishes free container images (see docs/DECISIONS.md), so SeaweedFS
# stands in locally. The API only uses the S3 protocol through its storage adapter, so any
# S3-compatible service works in staging and production.
#
# The S3 credentials come from the environment and are written to a config file at start,
# so no key is stored in the repository.
set -eu

: "${S3_ACCESS_KEY:?S3_ACCESS_KEY is required}"
: "${S3_SECRET_KEY:?S3_SECRET_KEY is required}"

cat > /tmp/s3.json <<EOF
{
  "identities": [
    {
      "name": "fibrex-dev",
      "credentials": [{ "accessKey": "${S3_ACCESS_KEY}", "secretKey": "${S3_SECRET_KEY}" }],
      "actions": ["Admin", "Read", "List", "Tagging", "Write"]
    }
  ]
}
EOF

exec weed server -dir=/data -s3 -s3.port=8333 -s3.config=/tmp/s3.json \
  -master.volumeSizeLimitMB=1024 -volume.max=0
