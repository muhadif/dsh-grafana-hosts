/**
 * Host half: named Grafana hosts plus six read-only tools.
 *
 * Hosts live in a plugin-owned JSON file ($DSH_HOME/grafana-hosts/hosts.json); tokens live in the
 * DSH credential store under GRAFANA_TOKEN_<ID>, never in configuration or tool output.
 * Nothing here writes to Grafana: there is no write tool, so read-only is structural.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

const PROMPT_SECTION = `## Grafana
\`grafana_hosts\` lists, adds, tests and removes named Grafana hosts; every other Grafana tool takes an optional \`host\` and defaults to the default host. \`grafana_search\` and \`grafana_dashboard\` search every host when \`host\` is omitted, so "which Grafana has this dashboard" needs no guessing. Tokens are stored in the credential store: never ask for one twice, and never echo one back.`
const LIMIT = { hosts: 20, panels: 8, series: 5, alerts: 40, dashboards: 30 }
const TIMEOUT_MS = 25_000

export const inject = ['tools', 'credentials', 'webServer']

const storeFile = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'grafana-hosts', 'hosts.json')
const now = () => new Date().toISOString()
const clip = (value, max) => String(value ?? '').trim().slice(0, max)
const slug = name => clip(name, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'host'
const tokenRef = id => `GRAFANA_TOKEN_${id.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`

/** Trim a pasted URL: drop trailing slashes and a trailing /api, keep any path prefix. */
function normalizeUrl(raw) {
  let url
  try {
    url = new URL(clip(raw, 500))
  } catch {
    throw new Error(`"${clip(raw, 120)}" is not a URL; use something like https://grafana.example.com`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('the Grafana URL must use http or https')
  url.hash = ''
  url.search = ''
  let path = url.pathname.replace(/\/+$/, '').replace(/\/api$/, '')
  return `${url.origin}${path}`
}

const emptyStore = () => ({ version: 1, defaultHost: '', hosts: [] })

async function loadStore() {
  try {
    const parsed = JSON.parse(await readFile(storeFile(), 'utf8'))
    return {
      version: 1,
      defaultHost: typeof parsed?.defaultHost === 'string' ? parsed.defaultHost : '',
      hosts: Array.isArray(parsed?.hosts) ? parsed.hosts.filter(host => host?.id && host?.url) : [],
    }
  } catch {
    return emptyStore()
  }
}

async function saveStore(store) {
  const file = storeFile()
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`)
  await rename(temp, file)
}

/** One host by name (case-insensitive) or the default; a miss names what exists. */
function pickHost(store, name) {
  if (!store.hosts.length) {
    throw new Error('No Grafana host is configured yet. Add one with grafana_hosts action=add '
      + 'name=<name> url=<url> token=<service-account token>, or from Settings > Plugins > Grafana hosts.')
  }
  const names = store.hosts.map(host => host.name).join(', ')
  if (!name) {
    const fallback = store.hosts.find(host => host.id === store.defaultHost) ?? store.hosts[0]
    return fallback
  }
  const wanted = clip(name, 60).toLowerCase()
  const hit = store.hosts.find(host => host.name.toLowerCase() === wanted || host.id === wanted)
  if (!hit) throw new Error(`Unknown Grafana host "${clip(name, 60)}". Configured hosts: ${names}.`)
  return hit
}

/** JSON GET/POST against one host; errors stay short and never carry the token. */
async function call(ctx, host, path, { method = 'GET', body } = {}) {
  const credentials = ctx.get('credentials')
  const token = (await credentials?.resolve(tokenRef(host.id)))?.value ?? ''
  if (!token) {
    throw new Error(`Host "${host.name}" has no token. Set one with grafana_hosts action=add `
      + `name=${host.name} url=${host.url} token=<service-account token>.`)
  }
  const response = await fetch(`${host.url}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await response.text()
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403
      ? 'check the service-account token and its permissions'
      : response.status === 404 ? 'check the URL and the path prefix' : 'see the Grafana server log'
    throw new Error(`Grafana "${host.name}" answered HTTP ${response.status} for ${path} — ${hint}.`
      + (text ? ` Body: ${clip(text.replace(/\s+/g, ' '), 200)}` : ''))
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Grafana "${host.name}" returned a non-JSON body for ${path}.`)
  }
}

/** Resolve a host plus its dashboard uid from a browser URL, uid or panel URL. */
function parseDashboardRef({ url, uid }) {
  const out = { uid: clip(uid, 120), panelId: '', from: '', to: '', hostHint: '' }
  if (!url) return out
  let parsed
  try {
    parsed = new URL(clip(url, 800))
  } catch {
    throw new Error('Pass the dashboard URL as it appears in the browser, or a dashboard uid.')
  }
  out.hostHint = parsed.host
  const match = parsed.pathname.match(/\/d\/([^/]+)/)
  if (match) out.uid = decodeURIComponent(match[1])
  out.panelId = parsed.searchParams.get('viewPanel') || parsed.searchParams.get('panelId') || ''
  out.from = parsed.searchParams.get('from') ?? ''
  out.to = parsed.searchParams.get('to') ?? ''
  if (!out.uid) throw new Error('That URL has no dashboard uid; it should contain /d/<uid>/<slug>.')
  return out
}

const flattenPanels = panels => {
  const out = []
  const walk = list => {
    for (const panel of list ?? []) {
      if (panel?.type === 'row') walk(panel.panels)
      else {
        out.push(panel)
        if (Array.isArray(panel.panels)) walk(panel.panels)
      }
    }
  }
  walk(panels)
  return out.filter(panel => panel && typeof panel === 'object')
}

/** Saved template-variable values, keyed by name; multi-values keep their array shape. */
function savedVariables(dashboard) {
  const vars = {}
  for (const entry of dashboard?.templating?.list ?? []) {
    if (!entry?.name) continue
    const value = entry.current?.value ?? entry.current?.text
    if (value === undefined || value === null || value === '') continue
    vars[entry.name] = value
  }
  return vars
}

const FORMATS = {
  raw: value => String(value),
  csv: value => (Array.isArray(value) ? value.join(',') : String(value)),
  pipe: value => (Array.isArray(value) ? value.join('|') : String(value)),
  json: value => JSON.stringify(value),
  regex: value => (Array.isArray(value) ? value.map(item => String(item).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') : String(value)),
  glob: value => (Array.isArray(value) ? value.join(',') : String(value)),
  queryparam: value => (Array.isArray(value) ? value.map(item => `var-${item}`).join('&') : String(value)),
  singlequote: value => (Array.isArray(value) ? value.map(item => `'${item}'`).join(',') : `'${value}'`),
  doublequote: value => (Array.isArray(value) ? value.map(item => `"${item}"`).join(',') : `"${value}"`),
}

/** Grafana's own ${var:format} / $var / [[var]] interpolation, over saved values only. */
function interpolate(text, vars) {
  if (typeof text !== 'string') return text
  return text
    .replace(/\$\{(\w+)(?::(\w+))?\}/g, (whole, name, format) => {
      if (!(name in vars)) return whole
      return (FORMATS[format] ?? FORMATS.raw)(vars[name])
    })
    .replace(/\[\[(\w+)(?::(\w+))?\]\]/g, (whole, name, format) => {
      if (!(name in vars)) return whole
      return (FORMATS[format] ?? FORMATS.raw)(vars[name])
    })
    .replace(/\$(\w+)/g, (whole, name) => (name in vars ? FORMATS.raw(vars[name]) : whole))
}

const unresolvedVariable = text => (typeof text === 'string' ? text.match(/\$\{?\w+\}?|\[\[\w+\]\]/) : null)

/** Numeric summary of one frame: last/min/max/avg, plus the series name. */
function summarizeFrame(frame) {
  const fields = frame?.schema?.fields ?? []
  const labels = fields.find(field => field?.labels)?.labels ?? {}
  const label = Object.entries(labels).map(([key, value]) => `${key}="${value}"`).join(', ')
  const name = frame?.schema?.name || label || 'series'
  const numericIndex = fields.findIndex(field => field?.type === 'number')
  const index = numericIndex >= 0 ? numericIndex : fields.length - 1
  const raw = frame?.data?.values?.[index] ?? []
  const values = raw.map(Number).filter(Number.isFinite)
  if (!values.length) return `${name}: no numeric data`
  const last = values[values.length - 1]
  const min = Math.min(...values)
  const max = Math.max(...values)
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length
  const round = value => (Math.abs(value) >= 1000 || Number.isInteger(value) ? value.toFixed(0) : value.toFixed(3))
  return `${name}: last=${round(last)} min=${round(min)} max=${round(max)} avg=${round(avg)} (n=${values.length})`
}

/** Bound the /api/ds/query answer to a few readable lines per refId. */
function summarizeQueryResults(results, wanted) {
  const lines = []
  for (const refId of Object.keys(results ?? {})) {
    const result = results[refId]
    if (result?.error) {
      lines.push(`${refId}: error — ${clip(result.error, 200)}`)
      continue
    }
    const frames = result?.frames ?? []
    if (!frames.length) {
      lines.push(`${refId}: no data`)
      continue
    }
    const shown = frames.slice(0, LIMIT.series)
    for (const frame of shown) lines.push(`${refId} ${summarizeFrame(frame)}`)
    if (frames.length > shown.length) lines.push(`${refId}: ${frames.length - shown.length} more series not shown`)
  }
  return lines.length ? lines.join('\n') : 'No series came back.'
}

/** Datasource list with legacy string-uid and {uid,type} references normalized. */
async function listDatasources(ctx, host) {
  const data = await call(ctx, host, '/api/datasources')
  return (Array.isArray(data) ? data : []).map(entry => ({
    uid: entry.uid ?? '',
    name: entry.name ?? '',
    type: entry.type ?? '',
    isDefault: Boolean(entry.isDefault),
  }))
}

function findDatasource(datasources, wanted) {
  const text = clip(wanted, 200).toLowerCase()
  if (!text) return undefined
  return datasources.find(entry => entry.uid === wanted)
    ?? datasources.find(entry => entry.name.toLowerCase() === text)
    ?? datasources.find(entry => entry.uid.toLowerCase() === text)
}

const hostLine = host => `host=${host.name} (${host.url})`

export function apply(ctx) {
  const credentials = () => {
    const service = ctx.get('credentials')
    if (!service) throw new Error('This profile has no credential store, so Grafana tokens cannot be saved.')
    return service
  }

  const tool = spec => ctx.tools.register(defineTool({
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    ...spec,
  }))

  // ---------------------------------------------------------------- hosts --
  tool({
    name: 'grafana_hosts',
    description:
      'Manage the configured Grafana hosts: list them (names, URLs, token status, which one is the default), '
      + 'add one with a service-account token, remove one, set the default, or test reachability. '
      + 'Every other Grafana tool takes an optional host name; omitting it uses the default host.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'add', 'remove', 'set-default', 'test'],
        description: 'list (default detail), add (needs name and url), remove, set-default, test.',
      },
      name: { type: 'string', description: 'Host name, used by other tools to pick this host.' },
      url: { type: 'string', description: 'Grafana base URL for add, e.g. https://grafana.example.com.' },
      token: {
        type: 'string',
        description: 'Grafana service-account token for add. Stored in the credential store, never echoed back.',
      },
    },
    async execute(args) {
      const store = await loadStore()
      const service = ctx.get('credentials')
      const action = args.action ?? 'list'

      const describe = async host => {
        const info = await service?.describe(tokenRef(host.id)).catch(() => undefined)
        const token = info?.configured ? 'configured' : 'missing'
        return `- ${host.name}${host.id === store.defaultHost ? ' (default)' : ''} — ${host.url} — token=${token}`
      }

      if (action === 'list') {
        if (!store.hosts.length) {
          return 'No Grafana hosts configured. Add one: grafana_hosts action=add name=prod '
            + 'url=https://grafana.example.com token=<service-account token>.'
        }
        const lines = await Promise.all(store.hosts.map(describe))
        return `${store.hosts.length} Grafana host(s):\n${lines.join('\n')}`
      }

      if (action === 'add') {
        const name = clip(args.name, 60)
        const url = normalizeUrl(args.url)
        if (!name) throw new Error('add needs a name, for example name=prod.')
        if (!args.token) throw new Error('add needs a service-account token; create one in Grafana under '
          + 'Administration > Users and access > Service accounts (role Viewer is enough).')
        const id = slug(name)
        if (store.hosts.some(host => host.id === id || host.name.toLowerCase() === name.toLowerCase())) {
          throw new Error(`A host named "${name}" already exists. Remove it first, or pick another name.`)
        }
        if (store.hosts.length >= LIMIT.hosts) throw new Error(`At most ${LIMIT.hosts} hosts can be configured.`)
        await credentials().set(tokenRef(id), clip(args.token, 4000))
        store.hosts.push({ id, name, url, createdAt: now() })
        if (!store.defaultHost) store.defaultHost = id
        await saveStore(store)
        const host = { id, name, url }
        let health = ''
        try {
          const info = await call(ctx, host, '/api/health')
          health = ` Reachable: Grafana ${info?.version ?? 'unknown version'}.`
        } catch (error) {
          health = ` Saved, but the reachability check failed: ${error.message}`
        }
        return `Added host "${name}" (${url}) as id ${id}.${health}`
      }

      if (action === 'remove') {
        const host = pickHost(store, args.name)
        store.hosts = store.hosts.filter(candidate => candidate.id !== host.id)
        if (store.defaultHost === host.id) store.defaultHost = store.hosts[0]?.id ?? ''
        await saveStore(store)
        await service?.unset(tokenRef(host.id)).catch(() => {})
        return `Removed host "${host.name}". ${store.hosts.length} host(s) left.`
      }

      if (action === 'set-default') {
        const host = pickHost(store, args.name)
        store.defaultHost = host.id
        await saveStore(store)
        return `Default host is now "${host.name}".`
      }

      if (action === 'test') {
        const targets = args.name ? [pickHost(store, args.name)] : store.hosts
        if (!targets.length) return 'No Grafana hosts configured.'
        const lines = []
        for (const host of targets) {
          try {
            const info = await call(ctx, host, '/api/health')
            lines.push(`- ${host.name}: ok, Grafana ${info?.version ?? 'unknown version'} (database ${info?.database ?? 'unknown'})`)
          } catch (error) {
            lines.push(`- ${host.name}: failed — ${error.message}`)
          }
        }
        return lines.join('\n')
      }

      throw new Error(`Unknown action "${action}". Use list, add, remove, set-default or test.`)
    },
    presentCall: args => ({
      card: 'generic',
      title: `Grafana hosts: ${args?.action ?? 'list'}${args?.name ? ` ${args.name}` : ''}`,
      kind: args?.action === 'add' || args?.action === 'remove' || args?.action === 'set-default' ? 'write' : 'read',
    }),
  })

  // --------------------------------------------------------------- search --
  tool({
    name: 'grafana_search',
    description:
      'Search dashboards by title and tag. With no host it searches every configured host and groups '
      + 'the hits per host, which answers "where does this dashboard live" in one call.',
    parameters: {
      query: { type: 'string', description: 'Title text to match; omit to list recent dashboards.' },
      tag: { type: 'string', description: 'Only dashboards carrying this tag.' },
      host: { type: 'string', description: 'Host name; omit to search every configured host.' },
      limit: { type: 'number', description: `Maximum dashboards per host (default 15, max ${LIMIT.dashboards}).` },
    },
    async execute(args) {
      const store = await loadStore()
      const targets = args.host ? [pickHost(store, args.host)] : store.hosts
      if (!targets.length) pickHost(store, args.host)
      const limit = Math.min(Math.max(Number(args.limit) || 15, 1), LIMIT.dashboards)
      const params = new URLSearchParams({ type: 'dash-db', limit: String(limit) })
      if (args.query) params.set('query', clip(args.query, 200))
      if (args.tag) params.set('tag', clip(args.tag, 80))
      const sections = []
      for (const host of targets) {
        try {
          const hits = await call(ctx, host, `/api/search?${params}`)
          const rows = (Array.isArray(hits) ? hits : []).map(hit => {
            const tags = Array.isArray(hit.tags) && hit.tags.length ? ` [${hit.tags.join(', ')}]` : ''
            const folder = hit.folderTitle ? ` (folder: ${hit.folderTitle})` : ''
            return `  - ${hit.title} — uid=${hit.uid}${folder}${tags}`
          })
          sections.push(`${host.name} (${host.url}): ${rows.length ? `\n${rows.join('\n')}` : 'no dashboards matched'}`)
        } catch (error) {
          sections.push(`${host.name}: failed — ${error.message}`)
        }
      }
      return sections.join('\n')
    },
    presentCall: args => ({ card: 'generic', title: `Search Grafana: ${args?.query ?? '(all)'}`, kind: 'read' }),
  })

  // ------------------------------------------------------------ dashboard --
  tool({
    name: 'grafana_dashboard',
    description:
      'Read a dashboard by browser URL or uid. Returns a compact summary (panels, variables, time range) '
      + 'by default, or the full JSON with mode=json. With no host, tries the default host first and then '
      + 'the others, so a uid alone usually finds its instance.',
    parameters: {
      url: { type: 'string', description: 'Dashboard URL copied from the browser.' },
      uid: { type: 'string', description: 'Dashboard uid, when the URL is not at hand.' },
      host: { type: 'string', description: 'Host name; omit to try the default host, then the rest.' },
      mode: { type: 'string', enum: ['summary', 'json'], description: 'summary (default) or json for the raw dashboard.' },
    },
    async execute(args) {
      const store = await loadStore()
      const ref = parseDashboardRef(args)
      const ordered = args.host
        ? [pickHost(store, args.host)]
        : [pickHost(store, ''), ...store.hosts.filter(host => host.id !== store.defaultHost)]
      let hit
      const failures = []
      for (const host of ordered) {
        try {
          const data = await call(ctx, host, `/api/dashboards/uid/${encodeURIComponent(ref.uid)}`)
          hit = { host, data }
          break
        } catch (error) {
          failures.push(`${host.name}: ${error.message}`)
          if (args.host) break
        }
      }
      if (!hit) throw new Error(`Dashboard "${ref.uid}" was not found. ${failures.join(' | ')}`)
      const dashboard = hit.data?.dashboard ?? {}
      if (args.mode === 'json') {
        return `${hostLine(hit.host)} uid=${ref.uid}\n${JSON.stringify({ meta: hit.data?.meta, dashboard }, null, 1)}`
      }
      const panels = flattenPanels(dashboard.panels)
      const variables = (dashboard.templating?.list ?? []).map(entry => {
        const value = entry.current?.text ?? entry.current?.value
        return `${entry.name}${value === undefined ? '' : `=${Array.isArray(value) ? value.join('|') : value}`}`
      })
      const lines = [
        `${dashboard.title ?? '(untitled)'} — uid=${ref.uid} ${hostLine(hit.host)}`,
        `folder: ${hit.data?.meta?.folderTitle ?? '(general)'} · tags: ${(dashboard.tags ?? []).join(', ') || 'none'}`
          + ` · range: ${dashboard.time?.from ?? '?'} to ${dashboard.time?.to ?? '?'} · refresh: ${dashboard.refresh ?? 'off'}`,
        `panels: ${panels.length}${variables.length ? ` · variables: ${variables.join(', ')}` : ''}`,
      ]
      for (const panel of panels.slice(0, 40)) {
        const datasource = panel.datasource?.uid ?? panel.datasource ?? panel.targets?.[0]?.datasource?.uid ?? ''
        const title = panel.title || panel.type || 'panel'
        lines.push(`  - id=${panel.id ?? '?'} ${title} (${panel.type ?? 'panel'})${datasource ? ` ds=${datasource}` : ''}`)
      }
      if (panels.length > 40) lines.push(`  (${panels.length - 40} more panels not shown)`)
      return lines.join('\n')
    },
    presentCall: args => ({ card: 'generic', title: `Read dashboard ${args?.uid ?? ''}`.trim(), kind: 'read' }),
  })

  // ---------------------------------------------------------- panel query --
  tool({
    name: 'grafana_query',
    description:
      'Run the queries behind a dashboard\'s panels and summarize the live values (last/min/max/avg). '
      + 'Pass the dashboard or panel-view URL (viewPanel= limits it to that panel) or a uid plus panelId. '
      + 'Template variables use the dashboard\'s saved values.',
    parameters: {
      url: { type: 'string', description: 'Dashboard or panel-view URL.' },
      uid: { type: 'string', description: 'Dashboard uid when no URL is available.' },
      panelId: { type: 'number', description: 'Only this panel id (default: every panel with queries).' },
      host: { type: 'string', description: 'Host name; omit to use the default host.' },
      from: { type: 'string', description: 'Start of the window, e.g. now-6h or an epoch millisecond value.' },
      to: { type: 'string', description: 'End of the window, e.g. now.' },
    },
    async execute(args) {
      const store = await loadStore()
      const host = pickHost(store, args.host)
      const ref = parseDashboardRef(args)
      const data = await call(ctx, host, `/api/dashboards/uid/${encodeURIComponent(ref.uid)}`)
      const dashboard = data?.dashboard ?? {}
      const panelId = Number(args.panelId ?? ref.panelId) || 0
      let panels = flattenPanels(dashboard.panels).filter(panel => Array.isArray(panel.targets) && panel.targets.length)
      if (panelId) {
        panels = panels.filter(panel => Number(panel.id) === panelId)
        if (!panels.length) throw new Error(`Dashboard ${ref.uid} has no panel with id ${panelId}.`)
      }
      panels = panels.slice(0, LIMIT.panels)
      if (!panels.length) throw new Error(`Dashboard ${ref.uid} has no panels with queries.`)
      const datasources = await listDatasources(ctx, host)
      const vars = savedVariables(dashboard)
      const from = clip(args.from ?? ref.from ?? dashboard.time?.from ?? 'now-6h', 40)
      const to = clip(args.to ?? ref.to ?? dashboard.time?.to ?? 'now', 40)
      const sections = []
      for (const panel of panels) {
        const title = panel.title || `panel ${panel.id}`
        const queries = []
        const skipped = []
        for (const [index, target] of panel.targets.entries()) {
          if (target?.hide) continue
          const refId = target.refId || String.fromCharCode(65 + index)
          const datasourceRef = target.datasource ?? panel.datasource
          const wanted = typeof datasourceRef === 'string' ? datasourceRef : datasourceRef?.uid
          if (!wanted || wanted === '-- Mixed --') {
            skipped.push(`${refId}: no datasource`)
            continue
          }
          const datasource = findDatasource(datasources, wanted)
          if (!datasource) {
            skipped.push(`${refId}: datasource ${wanted} is not provisioned on this host`)
            continue
          }
          const query = { refId, datasource: { type: datasource.type, uid: datasource.uid } }
          const expr = interpolate(target.expr ?? target.query ?? target.rawSql ?? '', vars)
          const missing = unresolvedVariable(expr)
          if (missing) {
            skipped.push(`${refId}: unresolved variable ${missing} (no saved value)`)
            continue
          }
          if (expr) query.expr = expr
          for (const key of ['format', 'legendFormat', 'interval', 'instant', 'range', 'queryType', 'rawSql']) {
            if (target[key] !== undefined) query[key] = target[key]
          }
          queries.push(query)
        }
        if (!queries.length) {
          sections.push(`## ${title} (id=${panel.id}) — skipped: ${skipped.join('; ') || 'no runnable target'}`)
          continue
        }
        try {
          const answer = await call(ctx, host, '/api/ds/query', { method: 'POST', body: { from, to, queries } })
          const body = summarizeQueryResults(answer?.results, queries.map(query => query.refId))
          sections.push(`## ${title} (id=${panel.id})\n${body}${skipped.length ? `\nskipped: ${skipped.join('; ')}` : ''}`)
        } catch (error) {
          sections.push(`## ${title} (id=${panel.id}) — failed: ${error.message}`)
        }
      }
      return `${hostLine(host)} dashboard=${dashboard.title ?? ref.uid} window=${from}..${to}\n\n${sections.join('\n\n')}`
    },
    presentCall: args => ({ card: 'generic', title: `Query Grafana panels ${args?.uid ?? ''}`.trim(), kind: 'read' }),
  })

  // -------------------------------------------------------------- metric --
  tool({
    name: 'grafana_metric',
    description:
      'Run one PromQL (or LogQL) query against a chosen datasource, in "instant" mode for the value right now '
      + 'or "range" for a window. Use grafana_datasources output or omit datasource to be shown what exists.',
    parameters: {
      query: { type: 'string', required: true, description: 'PromQL or LogQL expression.' },
      datasource: { type: 'string', description: 'Datasource uid or name; omit to use the default datasource.' },
      host: { type: 'string', description: 'Host name; omit to use the default host.' },
      mode: { type: 'string', enum: ['instant', 'range'], description: 'instant (default) or range.' },
      from: { type: 'string', description: 'Range start, e.g. now-1h (range mode).' },
      to: { type: 'string', description: 'Range end, e.g. now (range mode).' },
      step: { type: 'string', description: 'Resolution step, e.g. 30s or 1m (range mode).' },
    },
    async execute(args) {
      const store = await loadStore()
      const host = pickHost(store, args.host)
      const datasources = await listDatasources(ctx, host)
      let datasource = findDatasource(datasources, args.datasource)
      if (!datasource && !args.datasource) {
        datasource = datasources.find(entry => entry.isDefault)
          ?? datasources.find(entry => ['prometheus', 'loki'].includes(entry.type))
      }
      if (!datasource) {
        throw new Error(`No matching datasource on "${host.name}". Available: `
          + datasources.map(entry => `${entry.name} (${entry.type}, uid=${entry.uid})`).join(', '))
      }
      if (!['prometheus', 'loki', 'grafana-prometheus-datasource', 'victoriametrics-metrics-datasource'].includes(datasource.type)) {
        throw new Error(`Datasource "${datasource.name}" is type ${datasource.type}, which takes no free-form query text. `
          + 'Use grafana_query on a dashboard panel instead.')
      }
      const mode = args.mode ?? 'instant'
      const query = {
        refId: 'A',
        datasource: { type: datasource.type, uid: datasource.uid },
        expr: clip(args.query, 4000),
        ...(mode === 'instant' ? { instant: true, range: false } : { range: true, instant: false }),
      }
      if (mode === 'range') {
        if (args.step) query.interval = clip(args.step, 20)
        query.maxDataPoints = 300
      }
      const body = {
        from: clip(args.from ?? 'now-1h', 40),
        to: clip(args.to ?? 'now', 40),
        queries: [query],
      }
      const answer = await call(ctx, host, '/api/ds/query', { method: 'POST', body })
      const summary = summarizeQueryResults(answer?.results, ['A'])
      return `${hostLine(host)} datasource=${datasource.name} (${datasource.type}) mode=${mode}\n${summary}`
    },
    presentCall: args => ({ card: 'generic', title: `Grafana metric: ${clip(args?.query, 60)}`, kind: 'read' }),
  })

  // -------------------------------------------------------------- alerts --
  tool({
    name: 'grafana_alerts',
    description:
      'List alerts from a host\'s built-in Alertmanager: firing by default, or all (firing, silenced, '
      + 'inhibited) with state=all. Filter by a case-insensitive substring over labels and annotations.',
    parameters: {
      host: { type: 'string', description: 'Host name; omit to use the default host.' },
      state: { type: 'string', enum: ['firing', 'all'], description: 'firing (default) or all.' },
      filter: { type: 'string', description: 'Substring matched against alert names, labels and summaries.' },
      limit: { type: 'number', description: `Maximum alerts to list (default 20, max ${LIMIT.alerts}).` },
    },
    async execute(args) {
      const store = await loadStore()
      const host = pickHost(store, args.host)
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), LIMIT.alerts)
      const params = new URLSearchParams({ active: 'true', silenced: 'false', inhibited: 'false' })
      if (args.state === 'all') {
        params.set('silenced', 'true')
        params.set('inhibited', 'true')
      }
      const data = await call(ctx, host, `/api/alertmanager/grafana/api/v2/alerts?${params}`)
      const alerts = (Array.isArray(data) ? data : []).filter(alert => {
        if (!args.filter) return true
        const haystack = [
          alert?.labels?.alertname,
          ...Object.entries(alert?.labels ?? {}).map(([key, value]) => `${key}=${value}`),
          alert?.annotations?.summary,
          alert?.annotations?.description,
        ].join(' ').toLowerCase()
        return haystack.includes(clip(args.filter, 120).toLowerCase())
      })
      if (!alerts.length) return `${hostLine(host)}: no alerts matched.`
      const lines = alerts.slice(0, limit).map(alert => {
        const name = alert?.labels?.alertname ?? '(unnamed alert)'
        const severity = alert?.labels?.severity ? ` severity=${alert.labels.severity}` : ''
        const state = alert?.status?.state ?? 'active'
        const since = alert?.startsAt ? ` since ${alert.startsAt}` : ''
        const summary = clip(alert?.annotations?.summary ?? alert?.annotations?.description ?? '', 160)
        return `- [${state}] ${name}${severity}${since}${summary ? ` — ${summary}` : ''}`
      })
      const extra = alerts.length > limit ? `\n(${alerts.length - limit} more alerts not shown)` : ''
      return `${hostLine(host)}: ${alerts.length} alert(s)\n${lines.join('\n')}${extra}`
    },
    presentCall: args => ({ card: 'generic', title: `Grafana alerts${args?.filter ? `: ${args.filter}` : ''}`, kind: 'read' }),
  })

  // ------------------------------------------------- settings card route --
  // The card in Settings > Plugins talks to this route: same origin only, tokens write-only.
  const state = async () => {
    const store = await loadStore()
    const service = ctx.get('credentials')
    const hosts = await Promise.all(store.hosts.map(async host => {
      const info = await service?.describe(tokenRef(host.id)).catch(() => undefined)
      return { id: host.id, name: host.name, url: host.url, token: info?.configured ? 'configured' : 'missing' }
    }))
    return { defaultHost: store.defaultHost, hosts }
  }

  const json = (res, body, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/grafana-hosts/api',
      async handler(req, res) {
        if (req.method === 'GET') return json(res, await state())
        if (req.method !== 'POST') return json(res, { error: 'method-not-allowed' }, 405)
        // Same origin only: another page in the browser must not be able to rewrite hosts or tokens.
        const origin = req.headers.origin
        if (origin) {
          let fromPage = false
          try {
            fromPage = new URL(origin).host === (req.headers.host ?? '')
          } catch {
            fromPage = false
          }
          if (!fromPage) return json(res, { error: 'forbidden' }, 403)
        }
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        let payload
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        } catch {
          return json(res, { error: 'invalid-json' }, 400)
        }
        try {
          const store = await loadStore()
          const service = credentials()
          switch (payload?.op) {
            case 'add': {
              const name = clip(payload.name, 60)
              const url = normalizeUrl(payload.url)
              if (!name) throw new Error('A host needs a name.')
              if (!payload.token) throw new Error('A host needs a service-account token.')
              const id = slug(name)
              if (store.hosts.some(host => host.id === id || host.name.toLowerCase() === name.toLowerCase())) {
                throw new Error(`A host named "${name}" already exists.`)
              }
              if (store.hosts.length >= LIMIT.hosts) throw new Error(`At most ${LIMIT.hosts} hosts.`)
              await service.set(tokenRef(id), clip(payload.token, 4000))
              store.hosts.push({ id, name, url, createdAt: now() })
              if (!store.defaultHost) store.defaultHost = id
              break
            }
            case 'token': {
              const host = pickHost(store, payload.name)
              if (!payload.token) throw new Error('A token is required.')
              await service.set(tokenRef(host.id), clip(payload.token, 4000))
              break
            }
            case 'remove': {
              const host = pickHost(store, payload.name)
              store.hosts = store.hosts.filter(candidate => candidate.id !== host.id)
              if (store.defaultHost === host.id) store.defaultHost = store.hosts[0]?.id ?? ''
              await service.unset(tokenRef(host.id)).catch(() => {})
              break
            }
            case 'default': {
              const host = pickHost(store, payload.name)
              store.defaultHost = host.id
              break
            }
            case 'test': {
              const host = pickHost(store, payload.name)
              const info = await call(ctx, host, '/api/health')
              return json(res, { ok: true, version: info?.version ?? 'unknown' })
            }
            default:
              throw new Error(`unknown op ${payload?.op}`)
          }
          await saveStore(store)
          return json(res, await state())
        } catch (error) {
          return json(res, { error: String(error?.message ?? error) }, 400)
        }
      },
    }),
    'grafana-hosts: settings route',
  )

  const prompt = ctx.get('systemPrompt')
  if (prompt) {
    ctx.effect(
      () => prompt.section({ name: 'grafana-hosts', order: 62, text: PROMPT_SECTION }),
      'grafana-hosts: prompt section',
    )
  }
}
