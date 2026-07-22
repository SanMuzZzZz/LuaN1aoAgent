# traffic-proxy

An explicit HTTP/HTTPS forward proxy with SQLite and content-addressed body audit storage. Ordinary HTTP is forwarded directly. HTTPS `CONNECT` is intercepted by default so its HTTP exchanges use the same capture schema; an explicitly configured passthrough mode records tunnel metadata only.

## Run and trust the runtime CA

```sh
go run . -listen 127.0.0.1:8080 -data-dir ./data -runtime-ref runtime-1
curl --proxy http://127.0.0.1:8080 --cacert ./data/ca/runtime-1/ca.crt https://example.com/
```

Each `runtime_ref` owns a persistent CA under `ca/<runtime_ref>/`. The CA identifies itself as **LuaN1ao Traffic Proxy**, is valid for five years, and survives process restarts. Its key is mode `0600` inside mode `0700` directories; startup rejects an existing group/world-accessible key. Generated DNS/IP leaf certificates have the proper SAN, are valid for at most 30 days, and are cached in memory. Only `ca.crt` should be distributed. The private key is never returned by the proxy/control APIs or logged.

Flags:

- `-listen` (default `127.0.0.1:8080`).
- `-data-dir` stores `traffic.sqlite`, `blobs/`, and per-runtime `ca/`, with mode `0700`.
- `-control-socket` defaults to `<data-dir>/control.sock`.
- `-connect-mode` is `mitm` (default) or `passthrough`.
- `-capture-bytes` is the independent request/response retained-body limit (default 1 MiB; `0` stores no body). Forwarding continues after truncation.
- `-header-bytes` is the persisted header name/value budget for each side (default 64 KiB; `0` stores no headers).
- `-exchange-cap` limits retained exchanges (default 100000; `0` disables it).
- `-quota-bytes` is an approximate data-directory quota (default 1 GiB; `0` disables it).
- `-runtime-ref` fixes process/runtime identity; an unpredictable value is generated when omitted.

Targets must be valid absolute HTTP(S) URLs or `CONNECT` `host:port` authorities. Proxy self-targets, malformed targets, and control characters are rejected. Upstream HTTPS always uses normal Go root/hostname verification with TLS 1.2 or newer; there is no insecure verification option. Private/RFC1918 targets remain allowed.

## Capture schema and retention

Startup transactionally migrates through `PRAGMA user_version`; schema version 4 adds replay linkage/error metadata and is restart-idempotent. Legacy v1 data is copied once and retained for compatibility.

Every row in `exchanges` has method, URL, host, scheme, incoming HTTP protocol, mode (`forward`, `mitm`, `connect_mitm`, `connect_passthrough`, or `replay`), status/error and stable `error_code`, timing, observed/captured byte counts, body refs, capture/truncation states, context refs, replay source, CONNECT ref/authority/host/port, and quota results. Each replay is a new row whose `replay_of` points to its immutable source row. MITM child exchanges and their CONNECT metadata row share an opaque `connect_ref`. Passthrough rows use `metadata_only`, retain directional byte counts and never receive body refs. `exchange_headers` retains side, stable ordinal, original name/value, and duplicate values.

Bodies are SHA-256-addressed files under `blobs/<first-two-hex>/<hash>`, created with private permissions. Capture/header limits truncate best effort without shortening forwarding. Rotation evicts oldest non-current exchanges and unreferenced blobs. A current exchange that alone exceeds quota remains with `quota_pressure=1`; `evicted_exchanges` reports older rows removed by that write.

Headers and captured bodies may contain credentials. Protect the data directory. Normal logs contain storage/network errors only, not headers, bodies, CA key material, or private-key paths/content.

## Control protocol v1

The Unix socket is mode `0600`; startup rejects unsafe/symlinked parents and refuses to overwrite non-socket files. Frames are NDJSON, request frames are limited to 64 KiB, responses to 1 MiB, and each connection has a 30-second deadline. Errors are explicit strings with `ok:false`; replay errors also carry a stable `error_code` such as `source_not_found`, `source_not_replayable`, `replay_busy`, `invalid_url`, `forbidden_header`, `host_conflict`, `self_loop`, `body_too_large`, `tls_error`, `timeout`, or `upstream_error`.

Lifecycle/context commands are `hello`, `health`, `status`, `set`, `clear`, and `shutdown`. Fields are `runtime_ref` (fixed), `task_ref`, `run_ref`, `attribution`, `route_ref`, and `session_ref`. Changing/clearing `task_ref` clears `run_ref`; context is snapshotted when each exchange starts.

History/replay commands:

- `history_list`: accepts `limit` (default 50, maximum 100), opaque `cursor`, exact-match `filter` fields `runtime_ref`, `task_ref`, `run_ref`, `route_ref`, `session_ref`, `mode`, `method`, `host`, `connect_ref`, and `error`, inclusive RFC 3339 `started_after`/`started_before` bounds, and optional numeric `status`. Results are newest-first. `next_cursor` is stable because it is based on immutable exchange IDs.
- `history_get`: accepts positive `exchange_id`; returns all exchange fields and ordered repeated request/response header entries, including truncation/quota flags.
- `history_body`: accepts positive `exchange_id`, `side` (`request` or `response`), and `byte_limit` (default/maximum 256 KiB). It validates that the ref belongs to that exchange/side and returns binary-safe base64 plus byte/truncation metadata.
- `replay`: accepts a positive source `exchange_id`, required context containing `runtime_ref`, and optional method, absolute URL, ordered headers, base64 body, `route_ref`, and `session_ref` overrides. The sidecar permits four concurrent replays per `runtime_ref`, limits request bodies and captured responses to 1 MiB each, and applies a 30-second replay timeout.

```json
{"version":1,"id":"1","command":"history_list","limit":25,"filter":{"session_ref":"s1","mode":"mitm"}}
{"version":1,"id":"2","command":"history_get","exchange_id":42}
{"version":1,"id":"3","command":"history_body","exchange_id":42,"side":"response","byte_limit":65536}
{"version":1,"id":"4","command":"replay","exchange_id":42,"context":{"runtime_ref":"runtime-1","attribution":"control-example"}}
```

## Replay boundaries

Replay accepts only absolute HTTP(S) URLs without userinfo, uses normal root/hostname verification with TLS 1.2 or newer, allows private/RFC1918 targets, and rejects configured proxy self-target loops. It rejects `CONNECT`, control characters, hop-by-hop headers (including names nominated by `Connection`), proxy authentication headers, more than 64 KiB of headers, and a `Host` header that conflicts with the URL authority. Metadata-only/passthrough, CONNECT, truncated-header/request, and missing or incomplete captured-request-body sources are not replayable.

The Web API is `POST /api/traffic/history/:id/replay`. It is session- and same-origin double-submit-CSRF-protected and requires the administrator-only `traffic:replay` capability; analysts can read sensitive history but cannot replay it. `runtimeDir` and sensitive overrides are allowlisted JSON body fields. Web body override `data` is currently limited to 16 KiB of base64 characters, independently of the 256 KiB on-demand history-body read limit. The Web server admits at most four replay requests globally. Its `ExecutionLog` requested/succeeded/failed events use server-derived attribution and stable IDs/error codes, without override URL, headers, body, or other request secrets. The Web control client uses a replay-specific 35-second wait so the sidecar can return its own 30-second timeout result; other control commands retain the 2-second default.

This component exposes no traffic export/delete API and provides no SSH or chisel tunneling.

## Verify

```sh
gofmt -w *.go
go test ./...
```
