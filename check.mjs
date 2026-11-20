/**
 * Runnable self-check: node check.mjs
 *
 * Registers the Host half against a stubbed `@deepseek-ai/dsh-tools` and a fake context, points it at
 * two mock Grafana instances (one server, two path prefixes) and drives every tool plus the settings
 * route. Then loads the Client half against a stub React and renders the card. Writes into a temp
 * directory and removes it afterwards.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = await mkdtemp(join(tmpdir(), 'grafana-hosts-check-'))

// ---------------------------------------------------------------- mock Grafana
const dashboard = {
  title: 'Payment API',
  tags: ['prod'],
  time: { from: 'now-6h', to: 'now' },
  templating: { list: [{ name: 'env', current: { text: 'prod', value: 'prod' } }] },
  panels: [
    {
      id: 1,
      title: 'Latency p99',
      type: 'timeseries',
      datasource: { type: 'prometheus', uid: 'prom' },
      targets: [{
        refId: 'A',
        expr: 'histogram_quantile(0.99, rate(http_duration_bucket{env="$env"}[5m]))',
        datasource: { type: 'prometheus', uid: 'prom' },
      }],
    },
    {
      id: 2,
      title: 'Requests',
      type: 'stat',
      datasource: { type: 'prometheus', uid: 'prom' },
      targets: [{ refId: 'A', expr: 'sum(rate(http_requests_total{env="$missing"}[5m]))' }],
    },
  ],
}

const seen = { tokens: new Set(), queries: [] }
const tokens = { '/g1': 'tok-one', '/g2': 'tok-two' }

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://local')
  const prefix = url.pathname.startsWith('/g2') ? '/g2' : '/g1'
  const path = url.pathname.slice(prefix.length)
  const auth = req.headers.authorization ?? ''
  seen.tokens.add(auth)
  const reply = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (auth !== `Bearer ${tokens[prefix]}`) return reply(401, { message: 'bad token' })
  if (path === '/api/health') return reply(200, { version: prefix === '/g1' ? '11.2.0' : '10.4.1', database: 'ok' })
  if (path === '/api/search') {
    const query = url.searchParams.get('query') ?? ''
    const hits = query && !'payment api'.includes(query.toLowerCase())
      ? []
      : [{ title: `Payment API ${prefix.slice(1)}`, uid: prefix === '/g1' ? 'pay' : 'pay2', tags: ['prod'], folderTitle: 'Services' }]
    return reply(200, hits)
  }
  if (path === `/api/dashboards/uid/${prefix === '/g1' ? 'pay' : 'pay2'}`) {
    return reply(200, { dashboard, meta: { folderTitle: 'Services' } })
  }
  if (path === '/api/datasources') {
    return reply(200, [
      { uid: 'prom', name: 'Prometheus', type: 'prometheus', isDefault: true },
      { uid: 'loki', name: 'Loki', type: 'loki', isDefault: false },
      { uid: 'sqldb', name: 'Warehouse', type: 'mysql', isDefault: false },
    ])
  }
  if (path === '/api/ds/query' && req.method === 'POST') {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      const body = JSON.parse(raw || '{}')
      seen.queries.push(body)
      const refIds = Object.fromEntries((body.queries ?? []).map(query => [query.refId, query]))
      const results = {}
      for (const refId of Object.keys(refIds)) {
        results[refId] = {
          status: 200,
          frames: [{
            schema: {
              name: 'p99',
              fields: [
                { name: 'Time', type: 'time' },
                { name: 'Value', type: 'number', labels: { env: 'prod' } },
              ],
            },
            data: { values: [[1, 2, 3], [0.1, 0.2, 0.35]] },
          }],
        }
      }
      reply(200, { results })
    })
    return
  }
  if (path === '/api/alertmanager/grafana/api/v2/alerts') {
    return reply(200, [{
      labels: { alertname: 'HighLatency', severity: 'critical' },
      annotations: { summary: 'p99 above 1s' },
      status: { state: 'active' },
      startsAt: '2026-11-20T01:00:00Z',
    }])
  }
  reply(404, { message: `no mock route for ${path}` })
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

try {
  // ------------------------------------------------------------- host half
  const stub = join(dir, 'node_modules/@deepseek-ai/dsh-tools')
  await mkdir(stub, { recursive: true })
  await writeFile(join(stub, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.0.0', type: 'module', exports: './index.js' }))
  await writeFile(join(stub, 'index.js'), 'export const defineTool = definition => definition\n')
  await copyFile(new URL('./index.js', import.meta.url), join(dir, 'index.js'))

  process.env.DSH_HOME = join(dir, 'home')
  const { apply } = await import(join(dir, 'index.js'))

  const secrets = new Map()
  const credentials = {
    resolve: async ref => (secrets.has(ref) ? { value: secrets.get(ref), source: 'stored' } : undefined),
    describe: async ref => ({ configured: secrets.has(ref), writable: true }),
    set: async (ref, value) => secrets.set(ref, value),
    unset: async ref => secrets.delete(ref),
  }

  const tools = new Map()
  let route
  let section
  apply({
    tools: { register: definition => (tools.set(definition.name, definition), () => {}) },
    effect: factory => (factory(), () => {}),
    webServer: { register: registered => ((route = registered), () => {}) },
    get: name => {
      if (name === 'credentials') return credentials
      if (name === 'systemPrompt') return { section: definition => ((section = definition), () => {}) }
      return undefined
    },
  }, {})

  const names = ['grafana_hosts', 'grafana_search', 'grafana_dashboard', 'grafana_query', 'grafana_metric', 'grafana_alerts']
  for (const name of names) assert.ok(tools.get(name), `${name} is registered`)
  assert.equal(tools.size, names.length, 'no write tool exists')
  assert.equal(section?.name, 'grafana-hosts')
  assert.match(section.text, /grafana_hosts/)

  const call = (name, args) => tools.get(name).execute(args, {})
  const all = []

  // Nothing configured yet: a list says how to start, and a tool refuses with the same advice.
  assert.match(await call('grafana_hosts', { action: 'list' }), /No Grafana hosts configured/)
  await assert.rejects(() => call('grafana_search', {}), /No Grafana host is configured/)

  // Two hosts, two tokens, one server with a path prefix each.
  all.push(await call('grafana_hosts', { action: 'add', name: 'prod', url: `${base}/g1/`, token: 'tok-one' }))
  all.push(await call('grafana_hosts', { action: 'add', name: 'staging', url: `${base}/g2`, token: 'tok-two' }))
  const listed = await call('grafana_hosts', { action: 'list' })
  all.push(listed)
  assert.match(listed, /prod \(default\)/)
  assert.match(listed, /token=configured/)
  assert.match(listed, /staging/)

  // Adding the same name twice is refused, and an unknown host names the configured ones.
  await assert.rejects(() => call('grafana_hosts', { action: 'add', name: 'prod', url: base, token: 'x' }), /already exists/)
  await assert.rejects(() => call('grafana_search', { host: 'nope' }), /Configured hosts: prod, staging/)

  all.push(await call('grafana_hosts', { action: 'test' }))
  assert.match(all.at(-1), /prod: ok, Grafana 11\.2\.0/)
  assert.match(all.at(-1), /staging: ok, Grafana 10\.4\.1/)

  // Search without a host asks both and groups by host.
  const searched = await call('grafana_search', { query: 'payment' })
  all.push(searched)
  assert.match(searched, /prod \([^)]+\): \n {2}- Payment API g1 — uid=pay/)
  assert.match(searched, /staging \([^)]+\): \n {2}- Payment API g2 — uid=pay2/)
  assert.match(await call('grafana_search', { query: 'zzz' }), /no dashboards matched/)

  // A uid alone finds its instance, and the summary lists panels and saved variables.
  const summary = await call('grafana_dashboard', { uid: 'pay2' })
  all.push(summary)
  assert.match(summary, /Payment API — uid=pay2 host=staging/)
  assert.match(summary, /env=prod/)
  assert.match(summary, /id=1 Latency p99/)
  assert.match(await call('grafana_dashboard', { uid: 'pay', mode: 'json' }), /"title": "Payment API"/)

  // Panel data: variables interpolate, the unresolved panel is skipped with its reason.
  const panels = await call('grafana_query', { uid: 'pay' })
  all.push(panels)
  assert.match(panels, /Latency p99 \(id=1\)/)
  assert.match(panels, /A p99: last=0\.350 min=0\.100 max=0\.350 avg=0\.217/)
  assert.match(panels, /Requests \(id=2\) — skipped: A: unresolved variable \$missing/)
  assert.equal(seen.queries[0].queries[0].expr.includes('env="prod"'), true, 'variable was interpolated')

  // One panel only, by id.
  const single = await call('grafana_query', { uid: 'pay', panelId: 1 })
  assert.match(single, /Latency p99/)
  assert.doesNotMatch(single, /Requests/)

  // Metric: default datasource, then a named one, then the type refusal.
  const metric = await call('grafana_metric', { query: 'up', host: 'prod' })
  all.push(metric)
  assert.match(metric, /datasource=Prometheus \(prometheus\) mode=instant/)
  assert.match(metric, /last=0\.350/)
  assert.match(await call('grafana_metric', { query: 'sum(rate(x[5m]))', datasource: 'loki', mode: 'range' }), /datasource=Loki/)
  await assert.rejects(() => call('grafana_metric', { query: 'select 1', datasource: 'Warehouse' }), /takes no free-form query text/)
  await assert.rejects(() => call('grafana_metric', { query: 'up', datasource: 'nope' }), /No matching datasource/)

  const alerts = await call('grafana_alerts', { host: 'prod' })
  all.push(alerts)
  assert.match(alerts, /\[active\] HighLatency severity=critical/)
  assert.match(await call('grafana_alerts', { filter: 'zzz' }), /no alerts matched/)

  // No token ever leaves the plugin, and every host got its own token.
  for (const text of all) {
    assert.doesNotMatch(text, /tok-one|tok-two/, 'tokens stay out of tool output')
  }
  assert.deepEqual([...seen.tokens].sort(), ['Bearer tok-one', 'Bearer tok-two'])

  // A host without a token says how to set one instead of sending an empty header.
  await credentials.unset('GRAFANA_TOKEN_STAGING')
  assert.match(await call('grafana_search', { host: 'staging' }), /staging: failed — Host "staging" has no token/)
  await credentials.set('GRAFANA_TOKEN_STAGING', 'tok-two')

  // ------------------------------------------------------------ settings route
  const hit = async ({ method = 'GET', headers = {}, body } = {}) => {
    const req = { method, url: '/grafana-hosts/api', headers }
    req[Symbol.asyncIterator] = async function* () {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    }
    const res = { statusCode: 0, payload: '' }
    res.writeHead = code => { res.statusCode = code }
    res.end = text => { res.payload = text ?? '' }
    await route.handler(req, res)
    return { status: res.statusCode, json: res.payload ? JSON.parse(res.payload) : null }
  }

  const initial = await hit()
  assert.equal(initial.status, 200)
  assert.equal(initial.json.hosts.length, 2)
  assert.equal(initial.json.defaultHost, 'prod')
  assert.equal(initial.json.hosts[0].token, 'configured')

  const sameOrigin = { host: 'local', origin: 'http://local', 'content-type': 'application/json' }
  const added = await hit({ method: 'POST', headers: sameOrigin, body: { op: 'add', name: 'dev', url: `${base}/g1`, token: 'tok-one' } })
  assert.equal(added.status, 200)
  assert.equal(added.json.hosts.length, 3)

  const promoted = await hit({ method: 'POST', headers: sameOrigin, body: { op: 'default', name: 'dev' } })
  assert.equal(promoted.json.defaultHost, 'dev')

  const tested = await hit({ method: 'POST', headers: sameOrigin, body: { op: 'test', name: 'prod' } })
  assert.equal(tested.json.version, '11.2.0')

  const rotated = await hit({ method: 'POST', headers: sameOrigin, body: { op: 'token', name: 'dev', token: 'tok-one' } })
  assert.equal(rotated.status, 200)

  const removed = await hit({ method: 'POST', headers: sameOrigin, body: { op: 'remove', name: 'dev' } })
  assert.equal(removed.json.hosts.length, 2)
  assert.equal(removed.json.defaultHost, 'prod', 'the default falls back to a remaining host')

  const foreign = await hit({ method: 'POST', headers: { host: 'local', origin: 'https://evil.example' }, body: { op: 'remove', name: 'prod' } })
  assert.equal(foreign.status, 403)
  assert.equal((await hit({ method: 'PUT' })).status, 405)
  assert.match((await hit({ method: 'POST', headers: sameOrigin, body: { op: 'nope' } })).json.error, /unknown op/)

  // ------------------------------------------------------------- client half
  await copyFile(new URL('./client.js', import.meta.url), join(dir, 'client.js'))
  let factory
  globalThis.window = { __ModuleLoader__: { load: entry => { factory = entry.factory } } }
  await import(join(dir, 'client.js'))
  assert.ok(factory, 'client module registers a factory')

  const element = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() })
  const react = {
    createElement: element,
    useState: value => [value, () => {}],
    useEffect: () => {},
    useCallback: fn => fn,
  }
  const client = factory(name => {
    assert.equal(name, 'react')
    return react
  })

  const registrations = []
  let dictionary
  client.apply({
    effect: (run) => (run(), () => {}),
    locale: { register: (ns, dict) => ((dictionary = { ns, dict }), () => {}) },
    slots: {
      inject: (name, register) => (register(), () => {}),
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  })

  assert.equal(dictionary.ns, 'grafana-hosts')
  assert.ok(dictionary.dict.en.intro, 'English dictionary is registered')
  assert.equal(registrations.length, 1)
  const [registration] = registrations
  assert.equal(registration.options.name, 'plugins.bundle.config')
  assert.equal(registration.options.key, 'dsh-grafana-hosts')

  // Render the summary and the full card; a throw here blanks the slot in the real page.
  const render = node => {
    if (node === null || node === undefined || node === false) return ''
    if (Array.isArray(node)) return node.map(render).join('')
    if (typeof node !== 'object') return String(node)
    if (typeof node.type === 'function') return render(node.type({ ...node.props, children: node.children }))
    return (node.children ?? []).map(render).join('')
  }
  const t = key => dictionary.dict.en[key] ?? key
  assert.match(render(registration.component({ t, view: 'summary' })), /Grafana hosts/)
  const card = render(registration.component({ t, view: 'page' }))
  assert.match(card, /Add a host/)
  assert.match(card, /service-account token/i)

  console.log('grafana-hosts checks passed')
} finally {
  server.close()
  await rm(dir, { recursive: true, force: true })
}
