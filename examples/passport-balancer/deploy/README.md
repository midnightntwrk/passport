# deploy

The unit files and the reverse-proxy config for the sponsor droplet
(`67.205.177.162`, served as `67-205-177-162.sslip.io`).

- `passport-balancer.service` — the balancer itself.
- `passport-balancer-watchdog.{service,timer,sh}` — the watchdog that restarts
  it when it wedges.
- `Caddyfile` — the earlier proxy config, kept for reference.
- `Caddyfile.stagenet` — the live config. **This is the one installed.**

---

## The 1AM gateway API key

`Caddyfile.stagenet` forwards `/prover/*` to the 1AM stagenet proof gateway
first and falls back to our own proof server. The gateway wants an `x-api-key`
header, which the config reads as `{$ONE_AM_API_KEY}`.

The key is **not** in this repository. It lives on the droplet in
`/etc/caddy/1am.env`, mode `600`, owned by `root`, and reaches Caddy through the
systemd drop-in `/etc/systemd/system/caddy.service.d/10-1am-env.conf`:

```ini
[Service]
EnvironmentFile=-/etc/caddy/1am.env
```

To set or rotate the key:

```sh
echo 'ONE_AM_API_KEY=<key>' > /etc/caddy/1am.env
systemctl reload caddy
```

A reload is enough, and a restart is worth avoiding: `ExecStart` carries
`--environ`, so restarting Caddy writes the whole environment — the key with it
— into the journal.

The reload works because the config uses `{$ONE_AM_API_KEY}`, which the
Caddyfile adapter substitutes when it reads the file, and `ExecReload` is a
fresh `caddy reload` process that systemd has just handed the environment file.
The runtime form `{env.ONE_AM_API_KEY}` would **not** work here: the long-lived
server process resolves it against the environment it was started with, so a new
key would need a full restart.

An empty value is safe. The gateway serves anonymous callers at a lower rate
limit, and it answers an empty `x-api-key` exactly as it answers no header at
all — so the config is valid, and the proxy works, before anyone fills the file
in.

---

## Installing

```sh
install -m 644 deploy/Caddyfile.stagenet /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

`/prover-local/*` reaches our own proof server directly, bypassing the gateway.
It is the quickest way to tell which of the two answered a request: the gateway
returns `500` with a JSON body and Cloudflare headers, ours returns `400` with
`text/plain`.
