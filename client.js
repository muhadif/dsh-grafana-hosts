/**
 * Client half: the Grafana hosts card on the bundle's page in Settings > Plugins.
 *
 * It talks to the Host route /grafana-hosts/api, which owns the host list and the credential store;
 * this file never sees a token after it is typed, and the Host never returns one.
 */

window.__ModuleLoader__.load({
  id: 'dsh-grafana-hosts',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState, useCallback } = React

    const NS = 'grafana-hosts'
    const ENDPOINT = '/grafana-hosts/api'

    const T = {
      line: 'var(--dsw-alias-border-l1)',
      strong: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      faint: 'var(--dsw-alias-label-tertiary)',
      layer: 'var(--dsw-alias-bg-layer-2)',
      brand: 'var(--dsw-alias-brand-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
    }

    const input = {
      padding: '5px 9px',
      border: `1px solid ${T.line}`,
      borderRadius: 6,
      background: T.layer,
      color: T.strong,
      font: 'inherit',
      fontSize: 12,
      minWidth: 0,
    }

    const button = (label, onClick, { disabled, tone } = {}) => h('button', {
      type: 'button',
      onClick,
      disabled,
      style: {
        padding: '3px 9px',
        border: `1px solid ${tone === 'danger' ? T.error : T.line}`,
        borderRadius: 6,
        background: 'transparent',
        color: disabled ? T.faint : tone === 'danger' ? T.error : T.muted,
        font: 'inherit',
        fontSize: 12,
        cursor: disabled ? 'default' : 'pointer',
        whiteSpace: 'nowrap',
      },
    }, label)

    async function read() {
      const res = await fetch(ENDPOINT)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    }

    async function write(payload) {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      return data
    }

    function Card({ t }) {
      const tr = (key, fallback) => {
        const value = t?.(key)
        return value === undefined || value === key ? fallback : value
      }
      const [state, setState] = useState({ hosts: [], defaultHost: '' })
      const [draft, setDraft] = useState({ name: '', url: '', token: '' })
      const [tokenFor, setTokenFor] = useState('')
      const [tokenDraft, setTokenDraft] = useState('')
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')

      const refresh = useCallback(async () => {
        try {
          setState(await read())
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        }
      }, [])

      useEffect(() => {
        refresh()
      }, [refresh])

      const act = async (key, payload, done) => {
        setBusy(key)
        setError('')
        setNotice('')
        try {
          const next = await write(payload)
          if (next?.hosts) setState(next)
          if (done) setNotice(done)
          if (!next?.hosts) await refresh()
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy('')
        }
      }

      const hosts = state.hosts ?? []
      const rowStyle = {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 0',
        borderTop: `1px solid ${T.line}`,
        flexWrap: 'wrap',
      }
      const badge = (text, color) => h('span', {
        style: {
          padding: '1px 6px',
          borderRadius: 999,
          border: `1px solid ${color}`,
          color,
          fontSize: 10,
          lineHeight: '16px',
          whiteSpace: 'nowrap',
        },
      }, text)

      return h('div', { style: { display: 'grid', gap: 10, fontSize: 12, color: T.strong } },
        h('p', { style: { margin: 0, color: T.muted, lineHeight: 1.5 } },
          tr('intro', 'Each host is a Grafana instance with its own URL and service-account token. '
            + 'Every agent tool takes a host name and falls back to the default one.')),

        hosts.length
          ? h('div', { style: { display: 'grid' } }, hosts.map(host => h('div', { key: host.id, style: rowStyle },
            h('div', { style: { display: 'grid', gap: 2, minWidth: 0, flex: 1 } },
              h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
                h('span', { style: { fontWeight: 500 } }, host.name),
                host.id === state.defaultHost ? badge(tr('default', 'default'), T.brand) : null,
                badge(host.token === 'configured' ? tr('tokenSet', 'token set') : tr('tokenMissing', 'no token'),
                  host.token === 'configured' ? T.ok : T.warn),
              ),
              h('span', { style: { color: T.faint, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis' } }, host.url),
            ),
            tokenFor === host.id
              ? h('div', { style: { display: 'flex', gap: 6, flex: 1, minWidth: 220 } },
                h('input', {
                  style: { ...input, flex: 1 },
                  type: 'password',
                  placeholder: tr('tokenPlaceholder', 'Service-account token'),
                  value: tokenDraft,
                  onChange: event => setTokenDraft(event.target.value),
                  onKeyDown: event => {
                    if (event.key === 'Enter' && tokenDraft.trim()) {
                      act(`token:${host.id}`, { op: 'token', name: host.name, token: tokenDraft.trim() }, tr('tokenSaved', 'Token saved.'))
                        .then(() => { setTokenFor(''); setTokenDraft('') })
                    }
                  },
                }),
                button(tr('save', 'Save'), async () => {
                  await act(`token:${host.id}`, { op: 'token', name: host.name, token: tokenDraft.trim() }, tr('tokenSaved', 'Token saved.'))
                  setTokenFor('')
                  setTokenDraft('')
                }, { disabled: busy === `token:${host.id}` || !tokenDraft.trim() }),
              )
              : null,
            h('div', { style: { display: 'flex', gap: 6 } },
              host.id === state.defaultHost
                ? null
                : button(tr('makeDefault', 'Make default'), () => act(`default:${host.id}`, { op: 'default', name: host.name }, tr('defaultSaved', 'Default host updated.')), { disabled: Boolean(busy) }),
              button(tr('test', 'Test'), async () => {
                setBusy(`test:${host.id}`)
                setError('')
                setNotice('')
                try {
                  const answer = await write({ op: 'test', name: host.name })
                  setNotice(`${host.name}: ${tr('reachable', 'reachable')} — Grafana ${answer?.version ?? 'unknown'}`)
                } catch (cause) {
                  setError(`${host.name}: ${String(cause?.message ?? cause)}`)
                } finally {
                  setBusy('')
                }
              }, { disabled: Boolean(busy) }),
              button(tokenFor === host.id ? tr('cancel', 'Cancel') : tr('setToken', 'Set token'), () => {
                setTokenFor(tokenFor === host.id ? '' : host.id)
                setTokenDraft('')
              }, { disabled: Boolean(busy) }),
              button(tr('remove', 'Remove'), () => act(`remove:${host.id}`, { op: 'remove', name: host.name }, tr('removed', 'Host removed.')), { disabled: Boolean(busy), tone: 'danger' }),
            ),
          )))
          : h('p', { style: { margin: 0, color: T.faint } }, tr('empty', 'No hosts yet. Add your first Grafana below.')),

        h('div', { style: { display: 'grid', gap: 6, paddingTop: 10, borderTop: `1px solid ${T.line}` } },
          h('span', { style: { fontWeight: 500 } }, tr('addTitle', 'Add a host')),
          h('div', { style: { display: 'grid', gap: 6, gridTemplateColumns: 'minmax(90px, 1fr) minmax(160px, 2fr)' } },
            h('input', {
              style: input,
              placeholder: tr('namePlaceholder', 'Name, e.g. prod'),
              value: draft.name,
              onChange: event => setDraft({ ...draft, name: event.target.value }),
            }),
            h('input', {
              style: input,
              placeholder: tr('urlPlaceholder', 'https://grafana.example.com'),
              value: draft.url,
              onChange: event => setDraft({ ...draft, url: event.target.value }),
            }),
          ),
          h('input', {
            style: input,
            type: 'password',
            placeholder: tr('tokenPlaceholder', 'Service-account token'),
            value: draft.token,
            onChange: event => setDraft({ ...draft, token: event.target.value }),
          }),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            button(tr('add', 'Add host'), async () => {
              await act('add', { op: 'add', ...draft }, tr('added', 'Host added and checked.'))
              setDraft({ name: '', url: '', token: '' })
            }, { disabled: Boolean(busy) || !draft.name.trim() || !draft.url.trim() || !draft.token.trim() }),
            h('span', { style: { color: T.faint, fontSize: 11 } },
              tr('tokenHint', 'Grafana: Administration > Users and access > Service accounts. Viewer role is enough.')),
          ),
        ),

        error ? h('p', { style: { margin: 0, color: T.error, lineHeight: 1.5 } }, error) : null,
        notice ? h('p', { style: { margin: 0, color: T.ok, lineHeight: 1.5 } }, notice) : null,
      )
    }

    const DICT = {
      intro: 'Each host is a Grafana instance with its own URL and service-account token. '
        + 'Every agent tool takes a host name and falls back to the default one.',
      default: 'default',
      tokenSet: 'token set',
      tokenMissing: 'no token',
      tokenPlaceholder: 'Service-account token',
      tokenSaved: 'Token saved.',
      save: 'Save',
      makeDefault: 'Make default',
      defaultSaved: 'Default host updated.',
      test: 'Test',
      reachable: 'reachable',
      setToken: 'Set token',
      cancel: 'Cancel',
      remove: 'Remove',
      removed: 'Host removed.',
      empty: 'No hosts yet. Add your first Grafana below.',
      addTitle: 'Add a host',
      namePlaceholder: 'Name, e.g. prod',
      urlPlaceholder: 'https://grafana.example.com',
      add: 'Add host',
      added: 'Host added and checked.',
      tokenHint: 'Grafana: Administration > Users and access > Service accounts. Viewer role is enough.',
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en: DICT }), 'grafana-hosts: dictionary')
        ctx.effect(
          () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
            { name: 'plugins.bundle.config', key: 'dsh-grafana-hosts', locale: NS },
            ({ t, view }) => (view === 'summary'
              ? h('span', { style: { color: T.muted } }, 'Grafana hosts: dashboards, panel data, metrics and alerts across named instances.')
              : h(Card, { t })),
          )),
          'grafana-hosts: config card',
        )
      },
    }
  },
})
