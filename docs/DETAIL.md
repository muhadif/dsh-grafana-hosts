# Grafana hosts

Read-only Grafana across several named instances, addressed by host name.

## What it adds

Six tools, all read-only, and one configuration card on this bundle's page.

| Tool | Use it for |
| --- | --- |
| `grafana_hosts` | List hosts, add one, remove one, set the default, test reachability |
| `grafana_search` | Find dashboards by title or tag — across every host at once |
| `grafana_dashboard` | Read a dashboard's structure, or its raw JSON |
| `grafana_query` | The live values behind a dashboard's panels |
| `grafana_metric` | One PromQL or LogQL expression, instant or range |
| `grafana_alerts` | Firing alerts, plus silenced and inhibited on request |

Every tool except `grafana_hosts` takes an optional `host`. Omit it to use the default host.

## Configure

**Settings > Plugins > Grafana hosts** lists each host with its URL and token status, and lets you
add a host, rotate its token, test it, make it the default, or remove it.

A host is a name, a base URL and a Grafana service-account token. Create the token in Grafana under
**Administration > Users and access > Service accounts**; the **Viewer** role covers every tool here.
A URL with a path prefix (`https://example.com/grafana`) works as typed.

Tokens are stored in the DSH credential store under `GRAFANA_TOKEN_<ID>` and are write-only from the
card: the Host never returns one, and no tool output contains one.

The same actions are available in chat through `grafana_hosts`, so a host can be added from a session
without opening Settings.

## How a request is routed

1. `host` names an instance; an unknown name fails with the list of configured names.
2. Without `host`, the default host is used.
3. `grafana_search` and `grafana_dashboard` are the exceptions: with no `host` they cover every
   configured instance, so a dashboard uid alone usually finds its host.

## Limitations

- Read-only: no dashboard, alert-rule or folder writes exist in this plugin.
- Panel queries use the dashboard's saved template-variable values; a panel with an unresolved
  variable is skipped and the variable is named in the output.
- `grafana_metric` sends free-form query text, which only Prometheus-compatible and Loki datasources
  accept; other datasource types answer through `grafana_query` on a saved panel.
- Results are bounded (8 panels, 5 series per query, 40 alerts) to keep an answer readable.
