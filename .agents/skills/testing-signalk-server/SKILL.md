---
name: testing-signalk-server
description: How to run and manually test the Signal K server and its Admin UI (plugins, notifications, plugin REST endpoints) locally.
---

# Testing signalk-server locally

## Node version
`.nvmrc` pins node 24, but node 22 works: `source ~/.nvm/nvm.sh && nvm use 22`. System node 20 is below `engines` and fails.

## Build
```
npm install
npm run build:workspaces && npm run build
```
`build:workspaces` may NOT produce the Admin UI static bundle. If `http://localhost:3000/admin/` returns
`Could not handle admin ui root request` (or a 500 with ENOENT on
`node_modules/@signalk/server-admin-ui/public/index.html`), build it explicitly:
```
cd packages/server-admin-ui && npm run build   # vite build -> packages/server-admin-ui/public
```
If that fails with `Cannot find native binding` / `Cannot find module '@rolldown/binding-linux-x64-gnu'`,
install the missing optional native dep (match the rolldown version in `node_modules/rolldown/package.json`):
```
npm i --no-save @rolldown/binding-linux-x64-gnu@<version>
```
Restart the server after building the Admin UI. Use ctrl+shift+R in the browser to avoid a cached admin bundle.

## Running with sample data
```
./bin/signalk-server --sample-n2k-data     # samples/aava-n2k.data, port 3000
./bin/signalk-server --sample-nmea0183-data
```
With no `~/.signalk` config there is no security enabled, so the Admin UI and all APIs are open (no login needed).

**Sample data caveat:** `samples/aava-n2k.data` has NO engine PGNs (127488/127489/127493), so
`propulsion.*` paths never appear. Do not rely on it to exercise engine/propulsion features.

## Injecting synthetic deltas (no code changes needed)
Send deltas as a normal WS client; they show up in the Data Browser and reach plugin subscriptions:
```js
// run with NODE_PATH=<repo>/node_modules so `ws` resolves
const WebSocket = require('ws')
const ws = new WebSocket('ws://localhost:3000/signalk/v1/stream?subscribe=none')
ws.on('open', () => ws.send(JSON.stringify({updates:[{$source:'test-engine',
  values:[{path:'propulsion.mainEngine.temperature', value: 350}]}]})))
```
Space values >= 1.2 s apart if the plugin subscribes with `minPeriod: 1000` (otherwise readings are throttled away).

## Admin UI navigation (routes are hash-based)
- Plugin Config: sidebar **Apps & Plugins -> Configuration** (`#/apps/configuration/-`). Deep links
  like `#/serverConfiguration/plugins` may render blank; use the sidebar.
- A plugin never configured shows "Save configuration to enable this plugin"; clicking **Save Configuration**
  both saves and enables it, after which an `Enabled` toggle plus `Status:` line appear.
- Notifications/live values: **Data -> Browser** (`#/data/browser`), type e.g. `notifications` in Search
  to filter; the Source column shows the plugin id that produced the value.
- Plugin REST endpoints registered via `registerWithRouter` are served at `/plugins/<pluginId>/<route>`
  (Chrome's JSON "Pretty-print" checkbox makes assertions readable in screenshots).

## Devin Secrets Needed
None — everything above runs locally without credentials.
