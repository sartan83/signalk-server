import { expect } from 'chai'
import { ALARM_METHOD, ALARM_STATE } from '@signalk/server-api'
import type { Delta, Path, Plugin, ServerAPI } from '@signalk/server-api'
import {
  computeStats,
  isAnomaly
} from '../packages/engine-health-plugin/src/stats'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pluginModule = require('../packages/engine-health-plugin/src/index')

const TEMPERATURE_PATH = 'propulsion.mainEngine.temperature'

interface NotificationValue {
  state: string
  method: string[]
  message: string
  id: string
}

function notification(delta: Delta): {
  path: string
  value: NotificationValue
} {
  return (
    delta.updates[0] as {
      values: Array<{ path: string; value: NotificationValue }>
    }
  ).values[0]
}

interface MockApp {
  app: ServerAPI
  deltas: Delta[]
  send: (path: string, value: unknown) => void
  unsubscribeCount: () => number
}

function mockApp(): MockApp {
  const deltas: Delta[] = []
  let callback: ((delta: Delta) => void) | undefined
  let unsubscribeCount = 0

  const app = {
    handleMessage: (_id: string, delta: Delta) => {
      deltas.push(delta)
    },
    subscriptionmanager: {
      subscribe: (
        _command: unknown,
        unsubscribes: Array<() => void>,
        _errorCallback: (err: unknown) => void,
        cb: (delta: Delta) => void
      ) => {
        callback = cb
        unsubscribes.push(() => {
          unsubscribeCount++
        })
      },
      unsubscribe: () => {}
    },
    debug: () => {},
    setPluginStatus: () => {},
    setPluginError: () => {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as ServerAPI

  return {
    app,
    deltas,
    send: (path: string, value: unknown) => {
      callback!({
        updates: [{ values: [{ path: path as Path, value }] }]
      } as Delta)
    },
    unsubscribeCount: () => unsubscribeCount
  }
}

function startPlugin(
  settings: object = {}
): { plugin: Plugin } & Omit<MockApp, 'app'> {
  const mock = mockApp()
  const plugin = pluginModule(mock.app) as Plugin
  plugin.start(
    {
      paths: [TEMPERATURE_PATH],
      windowSize: 10,
      stdDevMultiplier: 3,
      consecutiveReadings: 3,
      severity: ALARM_STATE.alert,
      ...settings
    },
    () => {}
  )
  return {
    plugin,
    deltas: mock.deltas,
    send: mock.send,
    unsubscribeCount: mock.unsubscribeCount
  }
}

function fillWindow(send: (path: string, value: unknown) => void, count = 10) {
  for (let i = 0; i < count; i++) {
    send(TEMPERATURE_PATH, 350 + (i % 2))
  }
}

describe('engine-health plugin', () => {
  describe('computeStats', () => {
    it('returns the mean and population standard deviation', () => {
      const { mean, stdDev } = computeStats([2, 4, 4, 4, 5, 5, 7, 9])
      expect(mean).to.equal(5)
      expect(stdDev).to.equal(2)
    })

    it('returns zero deviation for constant readings', () => {
      const { mean, stdDev } = computeStats([350, 350, 350])
      expect(mean).to.equal(350)
      expect(stdDev).to.equal(0)
    })
  })

  describe('isAnomaly', () => {
    const stats = { mean: 350, stdDev: 2 }

    it('flags values above and below the dynamic threshold', () => {
      expect(isAnomaly(357, stats, 3)).to.be.true
      expect(isAnomaly(343, stats, 3)).to.be.true
    })

    it('accepts values within the dynamic threshold', () => {
      expect(isAnomaly(355, stats, 3)).to.be.false
      expect(isAnomaly(350, stats, 3)).to.be.false
    })
  })

  describe('anomaly detection', () => {
    it('publishes a notification after consecutive anomalous readings', () => {
      const { deltas, send } = startPlugin()
      fillWindow(send)

      send(TEMPERATURE_PATH, 450)
      send(TEMPERATURE_PATH, 450)
      expect(deltas).to.be.empty

      send(TEMPERATURE_PATH, 450)
      expect(deltas).to.have.lengthOf(1)

      const { path, value } = notification(deltas[0])
      expect(path).to.equal(`notifications.${TEMPERATURE_PATH}`)
      expect(value.state).to.equal(ALARM_STATE.alert)
      expect(value.method).to.deep.equal([
        ALARM_METHOD.visual,
        ALARM_METHOD.sound
      ])
      expect(value.message).to.be.a('string').and.not.empty
      expect(value.id).to.equal(`engine-health.${TEMPERATURE_PATH}`)
    })

    it('uses the configured severity', () => {
      const { deltas, send } = startPlugin({ severity: ALARM_STATE.alarm })
      fillWindow(send)

      for (let i = 0; i < 3; i++) {
        send(TEMPERATURE_PATH, 450)
      }
      expect(notification(deltas[0]).value.state).to.equal(ALARM_STATE.alarm)
    })

    it('does not notify on normal readings', () => {
      const { deltas, send } = startPlugin()
      fillWindow(send)
      for (let i = 0; i < 20; i++) {
        send(TEMPERATURE_PATH, 350 + (i % 3))
      }
      expect(deltas).to.be.empty
    })

    it('does not notify on an isolated spike', () => {
      const { deltas, send } = startPlugin()
      fillWindow(send)

      send(TEMPERATURE_PATH, 450)
      send(TEMPERATURE_PATH, 350)
      send(TEMPERATURE_PATH, 450)
      send(TEMPERATURE_PATH, 351)
      expect(deltas).to.be.empty
    })

    it('does not notify before the window is full', () => {
      const { deltas, send } = startPlugin({ windowSize: 100 })
      for (let i = 0; i < 20; i++) {
        send(TEMPERATURE_PATH, i % 2 === 0 ? 350 : 900)
      }
      expect(deltas).to.be.empty
    })

    it('ignores non numeric values and unmonitored paths', () => {
      const { deltas, send } = startPlugin()
      fillWindow(send)
      for (let i = 0; i < 3; i++) {
        send(TEMPERATURE_PATH, null)
        send('propulsion.mainEngine.oilPressure', 450)
      }
      expect(deltas).to.be.empty
    })

    it('publishes a normal notification when the value returns in range', () => {
      const { deltas, send } = startPlugin()
      fillWindow(send)
      for (let i = 0; i < 3; i++) {
        send(TEMPERATURE_PATH, 450)
      }
      send(TEMPERATURE_PATH, 350)

      expect(deltas).to.have.lengthOf(2)
      const { path, value } = notification(deltas[1])
      expect(path).to.equal(`notifications.${TEMPERATURE_PATH}`)
      expect(value.state).to.equal(ALARM_STATE.normal)
    })

    it('notifies once while the anomaly persists', () => {
      const { deltas, send } = startPlugin()
      fillWindow(send)
      for (let i = 0; i < 10; i++) {
        send(TEMPERATURE_PATH, 450)
      }
      expect(deltas).to.have.lengthOf(1)
    })
  })

  it('unsubscribes on stop', () => {
    const { plugin, send, deltas, unsubscribeCount } = startPlugin()
    fillWindow(send)
    plugin.stop()
    expect(unsubscribeCount()).to.equal(1)
    expect(deltas).to.be.empty
  })
})
