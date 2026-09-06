# deploy

The unit files and the reverse-proxy config for the sponsor droplet
(`67.205.177.162`, served as `67-205-177-162.sslip.io`).

- `passport-balancer.service` — the balancer itself.
- `passport-balancer-watchdog.{service,timer,sh}` — the supervisor: it probes
  the whole path every minute and restarts what has stopped answering. See
  **The supervisor** below.
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

---

## The supervisor

`passport-balancer-watchdog.sh` runs from `passport-balancer-watchdog.timer`
**every minute**. It began as a restarter for one service and is now the
supervisor for the whole sponsor stack, because on 2026/09/05 the balancer was
alive and unable to submit for five hours and nothing restarted it.

### What it checks, every tick

| Probe | Healthy is |
| --- | --- |
| `GET http://127.0.0.1:8807/status` | `synced` true; `nodeSocket` `connected` (or the key absent); `consecutiveSocketFailures` under 3; `aliasSponsorship` and `accountFunding` `available`; `proving` `server`; `appliedBehindHeadBlocks` at most 50 where it is published |
| `GET http://127.0.0.1:6300/health` | `200` — the proof server itself |
| `docker inspect passport-proof-server` | `.State.Running` is `true` |
| `systemctl is-active caddy` | `active` |
| `GET https://67-205-177-162.sslip.io/balancer/status` | `200` — through Caddy, resolved to the loopback so the probe measures our Caddy rather than DNS |
| `GET https://67-205-177-162.sslip.io/prover/health` | `200`, unless the proof server behind it is itself down |

`/status` is read with `python3`, not `grep`: three of those terms are numbers,
and a `grep` for `"synced":true` cannot tell a missing key from a false one.
Every request has a five-second budget and the whole tick finishes well inside
thirty seconds.

The three older legs are unchanged and still asked first, each on its own
signature: the DUST wedge, a spend job that has gone silent while holding a
lane, and a dead submission socket. They are named faults with known repairs;
the supervisor is the general case behind them.

### What it restarts

| Reading | Action |
| --- | --- |
| `/status` unhealthy for 3 consecutive ticks | `systemctl restart passport-balancer` |
| Caddy `active` but the public path fails while the local probes pass | `systemctl reload caddy` |
| Caddy not `active` | `systemctl restart caddy` |
| Container not running, or `/health` failing, for 3 ticks | `docker restart passport-proof-server` |

At most one restart per tick, front door first. Two rules bound all of them:

- **Nothing is restarted while a spend is in flight.** `busy` or
  `jobsRunning > 0` holds every restart until the unhealthy streak reaches ten
  ticks, at which point the job is not in flight, it is stuck.
- **Every unit carries its own exponential backoff** — 10 min, 20, 40, capped
  at 2 h — so a dependency that is genuinely down cannot be turned into a
  restart loop. Half an hour of health forgets the ladder.

A unit is also given a two-minute grace after any restart, during which nothing
strikes it: a service that is still starting has not failed.

Caddy is **reloaded** rather than restarted wherever a reload can do the job,
and that is deliberate: `ExecStart` carries `--environ`, so restarting Caddy
writes its whole environment — the 1AM gateway key with it — into the journal.

### Escalation

Three restarts of the balancer inside two hours that have not fixed it, and
restarting is not the repair. The supervisor writes
`/var/lib/passport-balancer/supervisor-escalated`, stops restarting **anything**
— every leg of this script, not only the supervisor's own — and logs why on
every tick until somebody looks. The marker is removed automatically the moment
`/status` reads healthy again.

Setting `WATCHDOG_REBOOT=1` in the environment file adds one droplet reboot per
six hours while escalated. It is **off by default**, and it stays off unless
somebody has decided that a reboot is better than a sponsor an operator can
still log into.

### Reading the markers

Everything the supervisor remembers is a file under
`/var/lib/passport-balancer`, because it has to survive the restart it bounds:

```sh
# What it is doing and why, one line per tick.
journalctl -u passport-balancer-watchdog -f | grep supervisor

# Every restart it has ever asked for, from any leg.
journalctl -t passport-ops --since '2 days ago'

# The state it keeps.
ls -l /var/lib/passport-balancer/supervisor-*
```

| File | Holds |
| --- | --- |
| `supervisor-strikes-{balancer,proof,caddy}` | consecutive unhealthy ticks |
| `supervisor-last-restart-<unit>` | epoch seconds of the last restart |
| `supervisor-restarts-<unit>` | position on the backoff ladder |
| `supervisor-healthy-since-<unit>` | when it last started reading healthy |
| `supervisor-restart-log-balancer` | the last ten balancer restarts, for the escalation window |
| `supervisor-escalated` | present means **restarts are off**; the file says when and why |
| `supervisor-last-reboot`, `supervisor-last-heartbeat` | the two daily-ish clocks |

`cat supervisor-escalated` first whenever the sponsor is down and nothing
appears to be trying to fix it. `rm` it to allow restarts again.

### Setting the webhook

`WATCHDOG_ALERT_WEBHOOK` receives a plain `{"text": "..."}` POST on every
action and on entering or leaving escalation, plus a heartbeat at most once a
day so a webhook that has quietly stopped delivering is noticed on a quiet day
rather than during an outage. Unset, nothing is posted and nothing is logged
about it.

It is read from `/etc/passport-balancer-watchdog.env`, which the unit takes
through `EnvironmentFile=-` — the leading `-` makes the file optional:

```sh
cat > /etc/passport-balancer-watchdog.env <<'ENV'
WATCHDOG_ALERT_WEBHOOK=https://hooks.slack.com/services/…
# WATCHDOG_REBOOT=1
ENV
chmod 600 /etc/passport-balancer-watchdog.env
systemctl daemon-reload
```

The URL is a secret and is treated as one: it is never written to the journal,
never passed on a command line that is logged, and `curl` is called with `-s`
rather than `-sS` so that an error from it cannot carry the URL into the
output.

### Installing

```sh
install -m 755 deploy/passport-balancer-watchdog.sh /usr/local/lib/passport-balancer-watchdog.sh
install -m 644 deploy/passport-balancer-watchdog.service /etc/systemd/system/
install -m 644 deploy/passport-balancer-watchdog.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now passport-balancer-watchdog.timer
```

`bash test/watchdog.test.sh` drives every rule above against stub probes, a
canned journal, and recorders in place of `systemctl`, `docker`, and `logger`.
Run it before installing a change; nothing in it touches a real unit.
