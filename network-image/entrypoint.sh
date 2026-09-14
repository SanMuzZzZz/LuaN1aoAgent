#!/bin/sh
set -eu

role="${1:-}"
shift || true

case "$role" in
  gateway)
    : "${LUANNIAO_TASK_FLOW_ROOT:?LUANNIAO_TASK_FLOW_ROOT is required}"
    mkdir -p /run/luanniao/capture /traffic/ca "$LUANNIAO_TASK_FLOW_ROOT"
    chgrp 101 /run/luanniao/capture
    chmod 2770 /run/luanniao/capture
    exec setpriv --groups=101 \
      python3 /opt/luanniao/index_server.py gateway "$@"
    ;;
  storage-init)
    [ "$#" -gt 0 ] || { echo "storage-init requires at least one path" >&2; exit 64; }
    chown -R 101:101 "$@"
    find "$@" -type d -exec chmod 2755 {} +
    ;;
  index)
    exec python3 /opt/luanniao/index_server.py index "$@"
    ;;
  connector)
    mkdir -p /run/luanniao/credentials /run/luanniao/connectors
    chmod 0700 /run/luanniao/credentials /run/luanniao/connectors
    exec sleep infinity
    ;;
  *)
    echo "usage: entrypoint.sh gateway|index|connector|storage-init" >&2
    exit 64
    ;;
esac
