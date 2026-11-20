# Grafana hosts

Read-only Grafana for [DSH] across several named instances. Six agent tools plus one settings card:
add each Grafana once, then address it by name from any tool.

## Why this instead of one Grafana connection

- **Named hosts.** `prod`, `staging`, `eu-cluster` — each with its own URL, path prefix and token.
  Every tool takes an optional `host` and falls back to the default one.
- **Search once, find it anywhere.** `grafana_search` with no `host` asks every configured instance
  and groups the hits per host, so "which Grafana has the payment dashboard" is one call.
- **Tokens stay out of everything.** They live in the DSH credential store
  (`GRAFANA_TOKEN_<ID>`), are write-only from the settings card, and never appear in tool output.
- **Read-only by construction.** No write tool is registered, so there is nothing to disable.

## Install

From the workspace directory:

```bash
dsh plugin --profile <profile> add link:/absolute/path/to/grafana-hosts
```

or install a local directory from **Plugins** > **Add plugin**. Restart the profile afterwards.

## Add a host

Two ways, same store:

1. **Chat:** `grafana_hosts action=add name=prod url=https://grafana.example.com token=<token>`
2. **Settings > Plugins > Grafana hosts:** fill in name, URL and token, then **Add host**.

Create the token in Grafana under **Administration > Users and access > Service accounts**
(role **Viewer** is enough for every tool here).

## Tools

| Tool | What it does |
| --- | --- |
| `grafana_hosts` | `list`, `add`, `remove`, `set-default`, `test` |
| `grafana_search` | Dashboards by title and tag; every host when `host` is omitted |
| `grafana_dashboard` | Compact summary (panels, variables, time range) or `mode=json` |
| `grafana_query` | Runs the queries behind a dashboard's panels from a dashboard or panel-view URL |
| `grafana_metric` | One PromQL/LogQL expression, `mode=instant` (default) or `mode=range` |
| `grafana_alerts` | Alertmanager alerts: firing by default, `state=all` for silenced and inhibited |

A uid alone usually finds its instance: `grafana_dashboard` tries the default host first, then the
rest, and reports which host answered.

## Limits

- Read-only: no dashboard writes, no alert-rule changes.
- `grafana_query` uses the dashboard's **saved** template-variable values. A panel whose variables
  have no saved value is skipped with the variable named, not guessed.
- `grafana_metric` accepts bare query text, which only Prometheus-compatible and Loki datasources
  take. Other types answer through `grafana_query` on a saved panel.
- Plain HTTP hosts are allowed; use HTTPS outside a private network.

## Development

```bash
node check.mjs   # mock Grafana, every tool, the settings route and the card
```
