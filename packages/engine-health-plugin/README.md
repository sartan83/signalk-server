# @signalk/engine-health

Predictive maintenance plugin for the main engine. It watches Signal K engine
paths, learns what "normal" looks like from recent readings and raises Signal K
notifications when readings drift outside a dynamic threshold.

The plugin is bundled with Signal K server and is **disabled by default** —
enable it in _Server -> Plugin Config -> Engine Health_ after choosing the paths
to monitor.

## How it works

For every monitored path the plugin keeps a sliding window of the most recent
readings (a ring buffer of `windowSize` values). Once the window is full it
calculates the moving average and standard deviation of the window and treats a
reading as anomalous when it falls outside

```
mean ± stdDevMultiplier * stdDev
```

Because the threshold is derived from the vessel's own recent data it adapts to
load, ambient temperature and engine model, instead of relying on fixed limits.

A single anomalous reading is not enough: the plugin counts consecutive
anomalies and only publishes a notification once `consecutiveReadings` in a row
have exceeded the threshold. Any reading back within the threshold resets the
counter and is fed into the window, so the reference statistics only ever
describe normal operation. When a path recovers, a notification with state
`normal` is published to clear the alarm.

## Configuration

| Option                | Default                                                                  | Description                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `paths`               | `propulsion.mainEngine.temperature`, `propulsion.mainEngine.revolutions` | Signal K paths to monitor. `propulsion.mainEngine.oilPressure` and `propulsion.mainEngine.coolantTemperature` can also be selected. |
| `windowSize`          | `30`                                                                     | Number of readings used for the moving average and standard deviation. No anomaly is reported until the window is full.             |
| `stdDevMultiplier`    | `3`                                                                      | How many standard deviations a reading must deviate from the moving average to count as an anomaly.                                 |
| `consecutiveReadings` | `3`                                                                      | Consecutive anomalous readings required before a notification is raised.                                                            |
| `severity`            | `alert`                                                                  | State of the notification raised for an anomaly, either `alert` or `alarm`.                                                         |

## Notifications

A notification is published on `notifications.<monitored path>`, for example
`notifications.propulsion.mainEngine.temperature`, with a value of the form:

```json
{
  "state": "alert",
  "method": ["visual", "sound"],
  "message": "propulsion.mainEngine.temperature value 450 deviates more than 3 standard deviations (1.200) from the moving average (350.400)",
  "id": "engine-health.propulsion.mainEngine.temperature"
}
```

## REST API

`GET /plugins/engine-health/status` returns the sliding window statistics and
the last detected anomaly for each monitored path (readable by `readonly`
users):

```json
{
  "propulsion.mainEngine.temperature": {
    "path": "propulsion.mainEngine.temperature",
    "samples": 30,
    "mean": 350.4,
    "stdDev": 1.2,
    "value": 450,
    "consecutiveAnomalies": 3,
    "notificationState": "alert",
    "lastAnomaly": {
      "value": 450,
      "mean": 350.4,
      "stdDev": 1.2,
      "timestamp": "2026-08-27T02:52:00.000Z",
      "notificationState": "alert"
    }
  }
}
```

The endpoint is documented in `src/openApi.json` and is available in the
server's OpenAPI browser.
