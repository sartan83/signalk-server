import {
  ALARM_METHOD,
  ALARM_STATE,
  Context,
  Delta,
  Path,
  Plugin,
  PluginRouter,
  ServerAPI,
  SubscribeMessage,
  Unsubscribes
} from '@signalk/server-api'
import { Request, Response } from 'express'
import { computeStats, isAnomaly } from './stats'
import * as openApi from './openApi.json'

const DEFAULT_PATHS = [
  'propulsion.mainEngine.temperature',
  'propulsion.mainEngine.revolutions'
]
const DEFAULT_WINDOW_SIZE = 30
const DEFAULT_STDDEV_MULTIPLIER = 3
const DEFAULT_CONSECUTIVE_READINGS = 3
const DEFAULT_SEVERITY = ALARM_STATE.alert
const SUBSCRIPTION_MIN_PERIOD = 1000

interface EngineHealthSettings {
  paths: string[]
  windowSize: number
  stdDevMultiplier: number
  consecutiveReadings: number
  severity: ALARM_STATE.alert | ALARM_STATE.alarm
}

interface AnomalyState {
  value: number
  mean: number
  stdDev: number
  timestamp: string
  notificationState: ALARM_STATE
}

interface PathState {
  window: number[]
  writeIndex: number
  filled: boolean
  consecutiveAnomalies: number
  lastValue: number | null
  lastAnomaly: AnomalyState | null
  notificationState: ALARM_STATE
}

const CONFIG_SCHEMA = {
  type: 'object',
  properties: {
    paths: {
      type: 'array',
      title: 'Monitored paths',
      description: 'Signal K paths to monitor for anomalies.',
      default: DEFAULT_PATHS,
      items: {
        type: 'string',
        enum: [
          'propulsion.mainEngine.temperature',
          'propulsion.mainEngine.revolutions',
          'propulsion.mainEngine.oilPressure',
          'propulsion.mainEngine.coolantTemperature'
        ]
      },
      uniqueItems: true
    },
    windowSize: {
      type: 'number',
      title: 'Window size',
      description:
        'Number of readings used to calculate the moving average and standard deviation. No anomaly is reported until the window is full.',
      default: DEFAULT_WINDOW_SIZE,
      minimum: 2
    },
    stdDevMultiplier: {
      type: 'number',
      title: 'Standard deviation multiplier',
      description:
        'A reading is anomalous when it deviates from the moving average by more than this many standard deviations.',
      default: DEFAULT_STDDEV_MULTIPLIER,
      minimum: 0
    },
    consecutiveReadings: {
      type: 'number',
      title: 'Consecutive readings',
      description:
        'Number of consecutive anomalous readings required before a notification is raised.',
      default: DEFAULT_CONSECUTIVE_READINGS,
      minimum: 1
    },
    severity: {
      type: 'string',
      title: 'Notification severity',
      description: 'State of the notification raised when an anomaly is found.',
      default: DEFAULT_SEVERITY,
      enum: [ALARM_STATE.alert, ALARM_STATE.alarm]
    }
  }
}

module.exports = (app: ServerAPI): Plugin => {
  let unsubscribes: Unsubscribes = []
  let config: EngineHealthSettings
  const state: Map<string, PathState> = new Map()

  const plugin: Plugin = {
    id: 'engine-health',
    name: 'Engine Health (built-in)',
    description:
      'Predictive maintenance for the main engine: dynamic threshold anomaly detection with notifications.',
    schema: () => CONFIG_SCHEMA,
    start: (settings: object) => {
      doStartup(settings as Partial<EngineHealthSettings>)
    },
    stop: () => {
      doShutdown()
    },
    registerWithRouter: (router: PluginRouter) => {
      initEndpoints(router)
    },
    getOpenApi: () => openApi
  }

  const applyDefaults = (
    settings: Partial<EngineHealthSettings>
  ): EngineHealthSettings => ({
    paths:
      Array.isArray(settings.paths) && settings.paths.length !== 0
        ? settings.paths
        : DEFAULT_PATHS,
    windowSize: settings.windowSize ?? DEFAULT_WINDOW_SIZE,
    stdDevMultiplier: settings.stdDevMultiplier ?? DEFAULT_STDDEV_MULTIPLIER,
    consecutiveReadings:
      settings.consecutiveReadings ?? DEFAULT_CONSECUTIVE_READINGS,
    severity: settings.severity ?? DEFAULT_SEVERITY
  })

  const doStartup = (settings: Partial<EngineHealthSettings>) => {
    config = applyDefaults(settings)
    app.debug(`${plugin.name} starting with ${JSON.stringify(config)}`)

    state.clear()
    for (const path of config.paths) {
      state.set(path, {
        window: [],
        writeIndex: 0,
        filled: false,
        consecutiveAnomalies: 0,
        lastValue: null,
        lastAnomaly: null,
        notificationState: ALARM_STATE.normal
      })
    }

    const subscription: SubscribeMessage = {
      context: 'vessels.self' as Context,
      subscribe: config.paths.map((path) => ({
        path: path as Path,
        policy: 'instant' as const,
        minPeriod: SUBSCRIPTION_MIN_PERIOD
      }))
    }

    app.subscriptionmanager.subscribe(
      subscription,
      unsubscribes,
      (err: unknown) => {
        app.setPluginError(`Subscription error: ${err}`)
      },
      onDelta
    )

    app.setPluginStatus(`Monitoring ${config.paths.join(', ')}`)
  }

  const doShutdown = () => {
    unsubscribes.forEach((f) => f())
    unsubscribes = []
    state.clear()
    app.setPluginStatus('Stopped.')
  }

  const onDelta = (delta: Delta) => {
    if (!delta.updates) {
      return
    }
    for (const update of delta.updates) {
      const values = 'values' in update ? update.values : undefined
      if (!values) {
        continue
      }
      for (const { path, value } of values) {
        if (typeof value === 'number') {
          onValue(path, value)
        }
      }
    }
  }

  const onValue = (path: string, value: number) => {
    const pathState = state.get(path)
    if (!pathState) {
      return
    }
    pathState.lastValue = value

    if (!pathState.filled) {
      pathState.window.push(value)
      if (pathState.window.length === config.windowSize) {
        pathState.filled = true
      }
      return
    }

    const stats = computeStats(pathState.window)
    if (isAnomaly(value, stats, config.stdDevMultiplier)) {
      pathState.consecutiveAnomalies++
      if (pathState.consecutiveAnomalies >= config.consecutiveReadings) {
        pathState.lastAnomaly = {
          value,
          mean: stats.mean,
          stdDev: stats.stdDev,
          timestamp: new Date().toISOString(),
          notificationState: config.severity
        }
        if (pathState.notificationState !== config.severity) {
          pathState.notificationState = config.severity
          sendNotification(
            path,
            config.severity,
            `${path} value ${value} deviates more than ${config.stdDevMultiplier} standard deviations (${stats.stdDev.toFixed(3)}) from the moving average (${stats.mean.toFixed(3)})`
          )
        }
      }
      return
    }

    pathState.consecutiveAnomalies = 0
    // a value within the dynamic threshold is representative of normal
    // operation, so it becomes part of the reference window
    pathState.window[pathState.writeIndex] = value
    pathState.writeIndex = (pathState.writeIndex + 1) % config.windowSize

    if (pathState.notificationState !== ALARM_STATE.normal) {
      pathState.notificationState = ALARM_STATE.normal
      sendNotification(path, ALARM_STATE.normal, `${path} is within range`)
    }
  }

  const sendNotification = (
    path: string,
    notificationState: ALARM_STATE,
    message: string
  ) => {
    app.handleMessage(plugin.id, {
      updates: [
        {
          values: [
            {
              path: `notifications.${path}` as Path,
              value: {
                state: notificationState,
                method: [ALARM_METHOD.visual, ALARM_METHOD.sound],
                message,
                id: `${plugin.id}.${path}`
              }
            }
          ]
        }
      ]
    })
  }

  const initEndpoints = (router: PluginRouter) => {
    router.access('readonly').get('/status', (_req: Request, res: Response) => {
      const status: Record<string, object> = {}
      for (const [path, pathState] of state) {
        const stats = pathState.filled
          ? computeStats(pathState.window)
          : undefined
        status[path] = {
          path,
          samples: pathState.window.length,
          mean: stats ? stats.mean : null,
          stdDev: stats ? stats.stdDev : null,
          value: pathState.lastValue,
          consecutiveAnomalies: pathState.consecutiveAnomalies,
          notificationState: pathState.notificationState,
          lastAnomaly: pathState.lastAnomaly
        }
      }
      res.json(status)
    })
  }

  return plugin
}
