import axios from 'axios'
import { ToastContainer, toast } from 'react-toastify'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import 'react-toastify/dist/ReactToastify.css'
import './App.css'

type ConnectionState = 'connecting' | 'open' | 'closed' | 'error'

type ServerStats = {
  cpuUsage?: number
  memoryTotal?: number
  memoryUsed?: number
  diskTotal?: number
  diskUsed?: number
  uptime?: string
  pm2Procs?: number
  pm2Mem?: number
  pm2BadCount?: number
  pm2BadNames?: string[]
  supervisorTotal?: number
  supervisorRunning?: number
  error?: string | null
}

type ServerEntry = {
  id: string
  name: string
  host: string
  enabled: boolean
  tags: string[]
  stats?: ServerStats
  lastUpdate?: number
}

type StatusKey = 'ok' | 'warn' | 'down' | 'idle' | 'stale' | 'disabled'

type StatusInfo = {
  key: StatusKey
  label: string
}

type IncomingServerListItem = {
  server_id: string
  server_name?: string
  host?: string
  enabled: boolean
  tags: string[]
}

type IncomingServerUpdate = {
  server_id: string
  error?: string | null
  cpuUsage?: number
  memoryTotal?: number
  memoryUsed?: number
  diskTotal?: number
  diskUsed?: number
  uptime?: string
  pm2Procs?: number
  pm2Mem?: number
  pm2BadCount?: number
  pm2BadNames?: string[]
  supervisorTotal?: number
  supervisorRunning?: number
}

type IncomingServerError = {
  server_id: string
  error?: string
}

const getEnv = (key: string) =>
  (import.meta.env as Record<string, string | undefined>)[key]

const parseEnvNumber = (key: string, fallback: number) => {
  const raw = getEnv(key)
  const value = raw ? Number(raw) : Number.NaN
  return Number.isFinite(value) ? value : fallback
}

const RAW_API_URL = getEnv('VITE_API_URL') ?? ''
const API_URL = RAW_API_URL.replace(/\/+$/, '')
const RAW_WS_URL = getEnv('VITE_WS_URL')
const WS_DETAIL = (getEnv('VITE_WS_DETAIL') ?? 'full').toLowerCase() === 'full' ? 'full' : 'summary'
const WS_INTERVAL_MS = parseEnvNumber('VITE_WS_INTERVAL_MS', 5000)

const deriveWsUrl = (apiUrl: string) => {
  try {
    const url = new URL(apiUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = '/ws'
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return 'ws://localhost:8000/ws'
  }
}

const WS_URL = RAW_WS_URL ?? (API_URL ? deriveWsUrl(API_URL) : '')
const ROTATE_MS = 9000
const MIN_CARD_WIDTH = 240
const MIN_CARD_HEIGHT = 180
const GRID_GAP = 16
const STATS_REFRESH_MS = parseEnvNumber('VITE_STATS_REFRESH_MS', 60_000)
const STATS_TIMEOUT_MS = parseEnvNumber('VITE_STATS_TIMEOUT_MS', 20_000)
const PM2_TOAST_AUTO_CLOSE_MS = parseEnvNumber('VITE_PM2_TOAST_AUTO_CLOSE_MS', 60_000)
const PM2_TOAST_REPEAT_MS = parseEnvNumber('VITE_PM2_TOAST_REPEAT_MS', 600_000)

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const ALERT_CPU = parseEnvNumber('VITE_ALERT_CPU', 90)
const ALERT_MEMORY = parseEnvNumber('VITE_ALERT_MEMORY', 92)
const ALERT_DISK = parseEnvNumber('VITE_ALERT_DISK', 95)
const ALERT_STALE_MS = parseEnvNumber('VITE_ALERT_STALE_MS', 90_000)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const toString = (value: unknown) => (typeof value === 'string' ? value : undefined)
const toNumber = (value: unknown) => (typeof value === 'number' ? value : undefined)
const toBoolean = (value: unknown) => (typeof value === 'boolean' ? value : undefined)
const toStringArray = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

const percent = (part?: number, total?: number) => {
  if (part == null || total == null || total === 0) return undefined
  return clamp((part / total) * 100, 0, 100)
}

const formatPercent = (value?: number) => {
  if (value == null || Number.isNaN(value)) return '--'
  return `${Math.round(value)}%`
}

const formatBytes = (value?: number) => {
  if (value == null || Number.isNaN(value)) return '--'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let unitIndex = 0
  let nextValue = value
  while (nextValue >= 1024 && unitIndex < units.length - 1) {
    nextValue /= 1024
    unitIndex += 1
  }
  const precision = nextValue >= 100 ? 0 : nextValue >= 10 ? 1 : 2
  return `${nextValue.toFixed(precision)} ${units[unitIndex]}`
}

const formatAge = (ms?: number) => {
  if (ms == null || Number.isNaN(ms)) return '--'
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

const getStatus = (server: ServerEntry, now: number): StatusInfo => {
  if (!server.enabled) return { key: 'disabled', label: 'Disabled' }
  const stats = server.stats
  if (!stats) return { key: 'idle', label: 'Waiting' }
  if (stats.error) return { key: 'down', label: 'Error' }
  const age = server.lastUpdate ? now - server.lastUpdate : Number.POSITIVE_INFINITY
  if (age > 60_000) return { key: 'stale', label: 'Stale' }

  const memPercent = percent(stats.memoryUsed, stats.memoryTotal) ?? 0
  const diskPercent = percent(stats.diskUsed, stats.diskTotal) ?? 0
  const cpu = stats.cpuUsage ?? 0

  if (cpu > 85 || memPercent > 90 || diskPercent > 92) return { key: 'warn', label: 'Hot' }
  return { key: 'ok', label: 'Nominal' }
}

const shouldAlert = (server: ServerEntry, now: number) => {
  if (!server.enabled) return false
  const stats = server.stats
  if (!stats) return false
  if (stats.error) return true
  const age = server.lastUpdate ? now - server.lastUpdate : Number.POSITIVE_INFINITY
  if (age > ALERT_STALE_MS) return true

  const memPercent = percent(stats.memoryUsed, stats.memoryTotal) ?? 0
  const diskPercent = percent(stats.diskUsed, stats.diskTotal) ?? 0
  const cpu = stats.cpuUsage ?? 0

  const pm2Bad = (stats.pm2BadCount ?? 0) > 0

  return cpu >= ALERT_CPU || memPercent >= ALERT_MEMORY || diskPercent >= ALERT_DISK || pm2Bad
}

const playAlertTone = () => {
  try {
    if (!window.userInteracted) return
    const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextClass) return
    const context = new AudioContextClass()
    if (context.state === 'suspended') {
      context.resume().catch(() => {})
      return
    }
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.value = 840
    gain.gain.value = 0.0001
    oscillator.connect(gain)
    gain.connect(context.destination)
    const now = context.currentTime
    oscillator.start()
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.03)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45)
    oscillator.stop(now + 0.5)
    oscillator.onended = () => {
      void context.close()
    }
  } catch {
    // Ignore autoplay/audio context errors.
  }
}

// Track user interaction for audio
if (typeof window !== 'undefined') {
  const enableAudio = () => {
    window.userInteracted = true
    document.removeEventListener('click', enableAudio)
    document.removeEventListener('keydown', enableAudio)
  }
  document.addEventListener('click', enableAudio)
  document.addEventListener('keydown', enableAudio)
}

const chunk = <T,>(items: T[], size: number) => {
  if (size <= 0) return [items]
  const pages: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    pages.push(items.slice(i, i + size))
  }
  return pages.length ? pages : [[]]
}

const connectionLabels: Record<ConnectionState, string> = {
  connecting: 'Connecting',
  open: 'Live',
  closed: 'Offline',
  error: 'Error',
}

const formatMaybe = (value?: number | null, suffix = '') => {
  if (value == null || Number.isNaN(value)) return '--'
  return `${Math.round(value)}${suffix}`
}

const parseServerList = (value: unknown): IncomingServerListItem[] => {
  if (!Array.isArray(value)) return []

  const results: IncomingServerListItem[] = []
  value.forEach((entry) => {
    if (!isRecord(entry)) return
    const serverId = toString(entry.server_id)
    if (!serverId) return
    results.push({
      server_id: serverId,
      server_name: toString(entry.server_name),
      host: toString(entry.host),
      enabled: toBoolean(entry.enabled) ?? true,
      tags: toStringArray(entry.tags),
    })
  })

  return results
}

const parseApiServerList = (value: unknown): IncomingServerListItem[] => {
  if (!isRecord(value)) return []
  const servers = value.servers
  if (!Array.isArray(servers)) return []

  const results: IncomingServerListItem[] = []
  servers.forEach((entry) => {
    if (!isRecord(entry)) return
    const serverId = toString(entry.id) ?? toString(entry.server_id)
    if (!serverId) return
    results.push({
      server_id: serverId,
      server_name: toString(entry.name) ?? toString(entry.server_name),
      host: toString(entry.host),
      enabled: toBoolean(entry.enabled) ?? true,
      tags: toStringArray(entry.tags),
    })
  })

  return results
}

const parseServerUpdate = (value: unknown): IncomingServerUpdate | null => {
  if (!isRecord(value)) return null
  const serverId = toString(value.server_id)
  if (!serverId) return null

  const cpu = isRecord(value.cpu) ? toNumber(value.cpu.usage_percent) : undefined
  const memoryTotal = isRecord(value.memory) ? toNumber(value.memory.total_bytes) : undefined
  const memoryUsed = isRecord(value.memory) ? toNumber(value.memory.used_bytes) : undefined
  const diskTotal = isRecord(value.disk) ? toNumber(value.disk.total_bytes) : undefined
  const diskUsed = isRecord(value.disk) ? toNumber(value.disk.used_bytes) : undefined
  const uptime = isRecord(value.uptime) ? toString(value.uptime.human) : undefined
    const pm2Procs = isRecord(value.pm2) ? toNumber(value.pm2.processes) : undefined
    const pm2Mem = isRecord(value.pm2) ? toNumber(value.pm2.total_memory_bytes) : undefined
    let pm2BadCount: number | undefined
    let pm2BadNames: string[] | undefined
    if (isRecord(value.pm2) && Array.isArray(value.pm2.details)) {
      const badNames: string[] = []
      value.pm2.details.forEach((detail) => {
        if (!isRecord(detail)) return
        const status = toString(detail.status)
        if (status && status.toLowerCase() !== 'online') {
          const name = toString(detail.name) ?? toString(detail.id)
          badNames.push(name ?? 'unknown')
        }
      })
      pm2BadCount = badNames.length
      pm2BadNames = badNames.slice(0, 3)
    }
    const supervisorTotal = isRecord(value.supervisor) ? toNumber(value.supervisor.total) : undefined
    const supervisorRunning = isRecord(value.supervisor) ? toNumber(value.supervisor.running) : undefined

    return {
      server_id: serverId,
      error: toString(value.error) ?? null,
      cpuUsage: cpu,
      memoryTotal,
      memoryUsed,
      diskTotal,
      diskUsed,
      uptime,
      pm2Procs,
      pm2Mem,
      pm2BadCount,
      pm2BadNames,
      supervisorTotal,
      supervisorRunning,
    }
  }

const parseServerError = (value: unknown): IncomingServerError | null => {
  if (!isRecord(value)) return null
  const serverId = toString(value.server_id)
  if (!serverId) return null
  return {
    server_id: serverId,
    error: toString(value.error),
  }
}

const parseStatsList = (value: unknown): IncomingServerUpdate[] => {
  if (!isRecord(value)) return []
  const servers = value.servers
  if (!Array.isArray(servers)) return []

  const results: IncomingServerUpdate[] = []
  servers.forEach((entry) => {
    if (!isRecord(entry)) return
    const serverId = toString(entry.server_id) ?? toString(entry.id)
    if (!serverId) return

    const cpu = isRecord(entry.cpu) ? toNumber(entry.cpu.usage_percent) : undefined
    const memoryTotal = isRecord(entry.memory) ? toNumber(entry.memory.total_bytes) : undefined
    const memoryUsed = isRecord(entry.memory) ? toNumber(entry.memory.used_bytes) : undefined
    const diskTotal = isRecord(entry.disk) ? toNumber(entry.disk.total_bytes) : undefined
    const diskUsed = isRecord(entry.disk) ? toNumber(entry.disk.used_bytes) : undefined
    const uptime = isRecord(entry.uptime) ? toString(entry.uptime.human) : undefined
    const pm2Procs = isRecord(entry.pm2) ? toNumber(entry.pm2.processes) : undefined
    const pm2Mem = isRecord(entry.pm2) ? toNumber(entry.pm2.total_memory_bytes) : undefined
    let pm2BadCount: number | undefined
    let pm2BadNames: string[] | undefined
    if (isRecord(entry.pm2) && Array.isArray(entry.pm2.details)) {
      const badNames: string[] = []
      entry.pm2.details.forEach((detail) => {
        if (!isRecord(detail)) return
        const status = toString(detail.status)
        if (status && status.toLowerCase() !== 'online') {
          const name = toString(detail.name) ?? toString(detail.id)
          badNames.push(name ?? 'unknown')
        }
      })
      pm2BadCount = badNames.length
      pm2BadNames = badNames.slice(0, 3)
    }
    const supervisorTotal = isRecord(entry.supervisor) ? toNumber(entry.supervisor.total) : undefined
    const supervisorRunning = isRecord(entry.supervisor) ? toNumber(entry.supervisor.running) : undefined

    results.push({
      server_id: serverId,
      error: toString(entry.error) ?? null,
      cpuUsage: cpu,
      memoryTotal,
      memoryUsed,
      diskTotal,
      diskUsed,
      uptime,
      pm2Procs,
      pm2Mem,
      pm2BadCount,
      pm2BadNames,
      supervisorTotal,
      supervisorRunning,
    })
  })

  return results
}

const ServerCard = ({ server, now }: { server: ServerEntry; now: number }) => {
  const status = getStatus(server, now)
  const alert = shouldAlert(server, now)
  const stats = server.stats
  const cpu = stats?.cpuUsage
  const memPercent = percent(stats?.memoryUsed, stats?.memoryTotal)
  const diskPercent = percent(stats?.diskUsed, stats?.diskTotal)

  return (
    <article
      className="serverCard"
      data-status={status.key}
      data-alert={alert ? 'true' : 'false'}
    >
      <div className="serverHeader">
        <div>
          <div className="serverName">{server.name}</div>
          <div className="serverHost">{server.host}</div>
        </div>
        <div>
          {alert ? <div className="alertBadge">ALERT</div> : null}
          <div className={`statusBadge ${status.key}`}>{status.label}</div>
        </div>
      </div>

      <div className="serverInfo">
        <div className="infoPill">
          PM2 {formatMaybe(stats?.pm2Procs)}
          {(stats?.pm2BadCount ?? 0) > 0 ? ` · ${stats?.pm2BadCount} down` : ''}
        </div>
        <div className="infoPill">
          SUP {formatMaybe(stats?.supervisorRunning)}/{formatMaybe(stats?.supervisorTotal)}
        </div>
      </div>

      <div className="metrics">
        <div className="metric">
          <div className="metricLabel">CPU</div>
          <div className="metricValue">{formatPercent(cpu)}</div>
          <div className="metricBar">
            <div className="metricBarFill" style={{ width: `${cpu ?? 0}%` }} />
          </div>
        </div>
        <div className="metric">
          <div className="metricLabel">Memory</div>
          <div className="metricValue">{formatPercent(memPercent)}</div>
          <div className="metricBar">
            <div className="metricBarFill" style={{ width: `${memPercent ?? 0}%` }} />
          </div>
        </div>
        <div className="metric">
          <div className="metricLabel">Disk</div>
          <div className="metricValue">{formatPercent(diskPercent)}</div>
          <div className="metricBar">
            <div className="metricBarFill" style={{ width: `${diskPercent ?? 0}%` }} />
          </div>
        </div>
      </div>

      <div className="serverFooter">
        <div className="tags">
          {server.tags.length ? (
            server.tags.slice(0, 3).map((tag) => (
              <span className="tag" key={`${server.id}-${tag}`}>
                {tag}
              </span>
            ))
          ) : null}
        </div>
        <div>
          {stats?.uptime ?? '--'} · {formatBytes(stats?.memoryUsed)}
        </div>
      </div>

      {stats?.error ? <div className="infoPill" style={{ marginTop: 'auto', color: 'var(--danger)' }}>{stats.error}</div> : null}
    </article>
  )
}

function App() {
  const [servers, setServers] = useState<ServerEntry[]>([])
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting')
  const [lastMessageAt, setLastMessageAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [demoMode, setDemoMode] = useState(true)
  const wsRef = useRef<WebSocket | null>(null)
  const gridRef = useRef<HTMLDivElement | null>(null)
  const [gridSize, setGridSize] = useState({ width: 0, height: 0 })
  const [pageIndex, setPageIndex] = useState(0)
  const [prevPage, setPrevPage] = useState<number | null>(null)
  const prevPageRef = useRef(0)

  const alertWasActiveRef = useRef(false)
  const pm2ToastRef = useRef(new Map<string, { signature: string; lastToastAt: number }>())
  const connectionStateRef = useRef(connectionState)
  const lastMessageAtRef = useRef(lastMessageAt)
  const api = useMemo(
    () =>
      axios.create({
        baseURL: API_URL,
        timeout: 8000,
      }),
    [],
  )

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useLayoutEffect(() => {
    const element = gridRef.current
    if (!element) return

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      setGridSize({ width, height })
    })

    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const sendMessage = useCallback((payload: unknown) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(payload))
  }, [])

  useEffect(() => {
    connectionStateRef.current = connectionState
  }, [connectionState])

  useEffect(() => {
    lastMessageAtRef.current = lastMessageAt
  }, [lastMessageAt])

  const applyServerList = useCallback(
    (incoming: IncomingServerListItem[]) => {
      if (!incoming.length) return
      setDemoMode(false)
      setServers((prev) => {
        const prevMap = new Map(prev.map((item) => [item.id, item]))
        return incoming.map((item) => {
          const existing = prevMap.get(item.server_id)
          return {
            id: item.server_id,
            name: item.server_name || item.host || item.server_id,
            host: item.host || '--',
            enabled: item.enabled,
            tags: item.tags,
            stats: existing?.stats,
            lastUpdate: existing?.lastUpdate,
          }
        })
      })

      incoming.forEach((item) => {
        sendMessage({
          type: 'server:subscribe',
          server_id: item.server_id,
          interval_ms: WS_INTERVAL_MS,
          detail: WS_DETAIL,
        })
      })
    },
    [sendMessage],
  )

  const applyServerUpdates = useCallback((updates: IncomingServerUpdate[]) => {
    if (!updates.length) return
    setDemoMode(false)
    const updateMap = new Map(updates.map((item) => [item.server_id, item]))
    const timestamp = Date.now()
    setServers((prev) =>
      prev.map((item) => {
        const payload = updateMap.get(item.id)
        if (!payload) return item
          return {
            ...item,
            stats: {
              error: payload.error ?? null,
              cpuUsage: payload.cpuUsage ?? item.stats?.cpuUsage,
              memoryTotal: payload.memoryTotal ?? item.stats?.memoryTotal,
              memoryUsed: payload.memoryUsed ?? item.stats?.memoryUsed,
              diskTotal: payload.diskTotal ?? item.stats?.diskTotal,
              diskUsed: payload.diskUsed ?? item.stats?.diskUsed,
              uptime: payload.uptime ?? item.stats?.uptime,
              pm2Procs: payload.pm2Procs ?? item.stats?.pm2Procs,
              pm2Mem: payload.pm2Mem ?? item.stats?.pm2Mem,
              pm2BadCount: payload.pm2BadCount ?? item.stats?.pm2BadCount,
              pm2BadNames: payload.pm2BadNames ?? item.stats?.pm2BadNames,
              supervisorTotal: payload.supervisorTotal ?? item.stats?.supervisorTotal,
              supervisorRunning: payload.supervisorRunning ?? item.stats?.supervisorRunning,
            },
          lastUpdate: timestamp,
        }
      }),
    )
  }, [])

  const applyServerUpdate = useCallback(
    (payload: IncomingServerUpdate) => {
      applyServerUpdates([payload])
    },
    [applyServerUpdates],
  )

  const applyServerError = useCallback((payload: IncomingServerError) => {
    setServers((prev) =>
      prev.map((item) =>
        item.id === payload.server_id
          ? {
              ...item,
              stats: {
                ...item.stats,
                error: payload.error || 'Server error',
              },
              lastUpdate: Date.now(),
            }
          : item,
      ),
    )
  }, [])

  const fetchServers = useCallback(async () => {
    try {
      const { data } = await api.get('/servers')
      const list = parseApiServerList(data)
      if (list.length) applyServerList(list)
    } catch {
      // Keep demo data if API is unreachable.
    }
  }, [api, applyServerList])

  const fetchStats = useCallback(async () => {
    try {
      const { data } = await api.get('/stats', {
        params: { include_disabled: false },
        timeout: STATS_TIMEOUT_MS,
      })
      const updates = parseStatsList(data)
      if (updates.length) applyServerUpdates(updates)
    } catch {
      // Ignore failures; WS should stay primary.
    }
  }, [api, applyServerUpdates])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchServers()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [fetchServers])

  useEffect(() => {
    if (connectionState === 'open') return
    const timer = window.setInterval(() => {
      void fetchServers()
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [connectionState, fetchServers])

  useEffect(() => {
    if (!API_URL) return
    const timer = window.setTimeout(() => {
      void fetchStats()
    }, 0)
    const interval = window.setInterval(() => {
      void fetchStats()
    }, STATS_REFRESH_MS)
    return () => {
      window.clearTimeout(timer)
      window.clearInterval(interval)
    }
  }, [fetchStats])

  useEffect(() => {
    if (!servers.length) return
    const timer = window.setTimeout(() => {
      void fetchStats()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [fetchStats, servers.length])

  useEffect(() => {
    const tick = () => {
      const last = lastMessageAtRef.current
      const age = last ? Date.now() - last : Number.POSITIVE_INFINITY
      const needsFallback = connectionStateRef.current !== 'open' || age > 15_000
      if (needsFallback) {
        void fetchStats()
      }
    }

    const timer = window.setTimeout(tick, 0)
    const interval = window.setInterval(tick, 30_000)
    return () => {
      window.clearTimeout(timer)
      window.clearInterval(interval)
    }
  }, [fetchStats])

  useEffect(() => {
    let reconnectTimer: number | undefined
    let listRefreshTimer: number | undefined
    let shouldReconnect = true
    let backoff = 1000

    const handleMessage = (raw: string) => {
      let payload: unknown
      try {
        payload = JSON.parse(raw)
      } catch {
        return
      }

      if (!isRecord(payload)) return
      const type = toString(payload.type)
      if (type === 'list:update') {
        const list = parseServerList(payload.servers)
        if (list.length) applyServerList(list)
      }

      if (type === 'server:update') {
        const update = parseServerUpdate(payload.server)
        if (update) applyServerUpdate(update)
      }

      if (type === 'server:error') {
        const error = parseServerError(payload)
        if (error) applyServerError(error)
      }
    }

    const connect = () => {
      if (!WS_URL) {
        setConnectionState('error')
        return
      }
      setConnectionState('connecting')
      const ws = new WebSocket(WS_URL)
      wsRef.current = ws

      ws.onopen = () => {
        setConnectionState('open')
        backoff = 1000
        sendMessage({ type: 'list:subscribe', include_disabled: false })
        if (listRefreshTimer) window.clearInterval(listRefreshTimer)
        listRefreshTimer = window.setInterval(() => {
          sendMessage({ type: 'list:subscribe', include_disabled: false })
        }, 30_000)
      }

      ws.onmessage = (event) => {
        setLastMessageAt(Date.now())
        handleMessage(event.data)
      }

      ws.onerror = (error) => {
        console.warn('WebSocket error:', error)
        setConnectionState('error')
        ws.close()
      }

      ws.onclose = (event) => {
        if (listRefreshTimer) window.clearInterval(listRefreshTimer)
        setConnectionState('closed')
        if (!shouldReconnect) return
        if (event.code === 1000) return // Normal closure
        reconnectTimer = window.setTimeout(connect, backoff)
        backoff = Math.min(backoff * 1.6, 15_000)
      }
    }

    connect()

    return () => {
      shouldReconnect = false
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
      if (listRefreshTimer) window.clearInterval(listRefreshTimer)
      wsRef.current?.close()
    }
  }, [applyServerError, applyServerList, applyServerUpdate, sendMessage])

  const gridMetrics = useMemo(() => {
    const safeWidth = Math.max(0, gridSize.width)
    const safeHeight = Math.max(0, gridSize.height)
    const minCardWidth =
      safeWidth < 560 ? 180 : safeWidth < 900 ? 210 : safeWidth < 1300 ? MIN_CARD_WIDTH : 260
    const minCardHeight =
      safeHeight < 540 ? 140 : safeHeight < 760 ? 160 : safeHeight < 900 ? MIN_CARD_HEIGHT : 200
    const columns = Math.max(1, Math.floor((safeWidth + GRID_GAP) / (minCardWidth + GRID_GAP)))
    let rows = Math.max(1, Math.floor((safeHeight + GRID_GAP) / (minCardHeight + GRID_GAP)))
    if (safeHeight < 520) {
      rows = 1
    }
    const pageSize = Math.max(1, columns * rows)
    return { columns, rows, pageSize }
  }, [gridSize.height, gridSize.width])

  const pages = useMemo(() => chunk(servers, gridMetrics.pageSize), [servers, gridMetrics.pageSize])
  const normalizedPageIndex = pages.length ? pageIndex % pages.length : 0
  const alertServers = useMemo(() => servers.filter((server) => shouldAlert(server, now)), [servers, now])
  const hasAlert = alertServers.length > 0
  const pm2Issues = useMemo(
    () =>
      servers
        .filter((server) => (server.stats?.pm2BadCount ?? 0) > 0)
        .map((server) => ({
          id: server.id,
          name: server.name,
          host: server.host,
          count: server.stats?.pm2BadCount ?? 0,
          names: server.stats?.pm2BadNames ?? [],
        })),
    [servers],
  )
  useEffect(() => {
    if (demoMode) return
    if (hasAlert && !alertWasActiveRef.current) {
      playAlertTone()
      alertWasActiveRef.current = true
      return
    }
    if (!hasAlert) {
      alertWasActiveRef.current = false
    }
  }, [demoMode, hasAlert])

  useEffect(() => {
    if (!pm2Issues.length) {
      pm2ToastRef.current.clear()
      return
    }
    const nowMs = Date.now()
    const activeIds = new Set(pm2Issues.map((issue) => issue.id))
    for (const id of pm2ToastRef.current.keys()) {
      if (!activeIds.has(id)) {
        pm2ToastRef.current.delete(id)
      }
    }

    pm2Issues.forEach((issue) => {
      const signature = `${issue.count}:${issue.names.join('|')}`
      const previous = pm2ToastRef.current.get(issue.id)
      const shouldNotify =
        !previous ||
        previous.signature !== signature ||
        nowMs - previous.lastToastAt >= PM2_TOAST_REPEAT_MS

      if (!shouldNotify) return

      toast.error(
        `${issue.name} · ${issue.count} ${issue.count === 1 ? 'process' : 'processes'} not online${
          issue.names.length ? ` · ${issue.names.join(', ')}` : ''
        }`,
        {
          autoClose: PM2_TOAST_AUTO_CLOSE_MS,
          closeOnClick: true,
          pauseOnHover: true,
        },
      )
      pm2ToastRef.current.set(issue.id, { signature, lastToastAt: nowMs })
    })
  }, [pm2Issues])

  useEffect(() => {
    if (pages.length <= 1) return
    const timer = window.setTimeout(() => {
      setPageIndex((prev) => (prev + 1) % pages.length)
    }, ROTATE_MS)
    return () => window.clearTimeout(timer)
  }, [pageIndex, pages.length])

  useEffect(() => {
    const prevIndex = prevPageRef.current
    if (prevIndex !== normalizedPageIndex) {
      setPrevPage(prevIndex)
      prevPageRef.current = normalizedPageIndex
      const timer = window.setTimeout(() => setPrevPage(null), 650)
      return () => window.clearTimeout(timer)
    }
  }, [normalizedPageIndex])

  const aggregates = useMemo(() => {
    let online = 0
    let warn = 0
    let offline = 0
    let disabled = 0
    let cpuSum = 0
    let cpuCount = 0
    let memSum = 0
    let memCount = 0
    let diskSum = 0
    let diskCount = 0
    let pm2Total = 0
    let supRunning = 0
    let supTotal = 0
    let latestUpdate = 0

    servers.forEach((server) => {
      const status = getStatus(server, now)
      if (status.key === 'ok') online += 1
      if (status.key === 'warn') warn += 1
      if (status.key === 'down' || status.key === 'stale') offline += 1
      if (status.key === 'disabled') disabled += 1

      const stats = server.stats
      if (stats?.cpuUsage != null) {
        cpuSum += stats.cpuUsage
        cpuCount += 1
      }
      const memPct = percent(stats?.memoryUsed, stats?.memoryTotal)
      if (memPct != null) {
        memSum += memPct
        memCount += 1
      }
      const diskPct = percent(stats?.diskUsed, stats?.diskTotal)
      if (diskPct != null) {
        diskSum += diskPct
        diskCount += 1
      }
      if (stats?.pm2Procs != null) pm2Total += stats.pm2Procs
      if (stats?.supervisorRunning != null) supRunning += stats.supervisorRunning
      if (stats?.supervisorTotal != null) supTotal += stats.supervisorTotal
      if (server.lastUpdate != null) latestUpdate = Math.max(latestUpdate, server.lastUpdate)
    })

    return {
      online,
      warn,
      offline,
      disabled,
      avgCpu: cpuCount ? cpuSum / cpuCount : undefined,
      avgMem: memCount ? memSum / memCount : undefined,
      avgDisk: diskCount ? diskSum / diskCount : undefined,
      pm2Total,
      supRunning,
      supTotal,
      latestUpdate,
    }
  }, [servers, now])

  const activePage = pages[normalizedPageIndex] ?? []
  const outgoingPage =
    prevPage != null ? pages[pages.length ? prevPage % pages.length : 0] ?? [] : []

  const lastUpdateAge = aggregates.latestUpdate ? now - aggregates.latestUpdate : undefined

  return (
    <div className="app">
      <header className="header">
        <div className="logo">
          <div className="logoIcon">BCD</div>
          <div className="logoText">
            <h1>Server Matrix</h1>
            <span>Better Call Dally</span>
          </div>
        </div>
        <div className="connectionStatus">
          <div className={`statusDot ${connectionState}`} />
          <div className="statusText">{connectionLabels[connectionState]}</div>
        </div>
      </header>

      <section className="statsBar">
        <div className="statCard">
          <div className="statValue">{servers.length}</div>
          <div className="statLabel">Total Servers</div>
          <div className="statDetail">{aggregates.online} healthy</div>
        </div>
        <div className="statCard">
          <div className="statValue">{formatPercent(aggregates.avgCpu)}</div>
          <div className="statLabel">Avg CPU</div>
          <div className="statDetail">{formatPercent(aggregates.avgMem)} RAM</div>
        </div>
        <div className="statCard">
          <div className="statValue">{formatMaybe(aggregates.pm2Total)}</div>
          <div className="statLabel">PM2 Processes</div>
          <div className="statDetail">{formatMaybe(aggregates.supRunning)} running</div>
        </div>
        <div className="statCard">
          <div className="statValue">{formatAge(lastUpdateAge)}</div>
          <div className="statLabel">Last Update</div>
          <div className="statDetail">{pages.length} page{pages.length !== 1 ? 's' : ''}</div>
        </div>
      </section>

      <section className="matrixContainer">
        <div className="matrixGrid" ref={gridRef}>
          {prevPage != null ? (
            <div
              className="matrixPage pageOut"
              style={{
                gridTemplateColumns: `repeat(${gridMetrics.columns}, minmax(0, 1fr))`,
                gridTemplateRows: `repeat(${gridMetrics.rows}, minmax(0, 1fr))`,
              }}
            >
              {outgoingPage.map((server) => (
                <ServerCard key={`prev-${server.id}`} server={server} now={now} />
              ))}
            </div>
          ) : null}

          <div
            className="matrixPage pageIn"
            key={`page-${normalizedPageIndex}`}
            style={{
              gridTemplateColumns: `repeat(${gridMetrics.columns}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${gridMetrics.rows}, minmax(0, 1fr))`,
            }}
          >
            {activePage.map((server) => (
              <ServerCard key={server.id} server={server} now={now} />
            ))}
          </div>
        </div>

        {pages.length > 1 ? (
          <div
            className="progressLine"
            key={`progress-${normalizedPageIndex}`}
            style={{ animationDuration: `${ROTATE_MS}ms` }}
          />
        ) : null}
      </section>

      <ToastContainer position="top-right" newestOnTop pauseOnHover theme="dark" />
    </div>
  )
}

export default App
