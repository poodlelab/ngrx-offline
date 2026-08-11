# NgRx Offline showcase

The Angular travel-journal showcase is the executable documentation for
`@poodlelab/ngrx-offline`. It demonstrates a seven-record relationship graph,
durable offline creation, explicit client-to-server ID mapping, deterministic
failures, and queue controls.

```bash
pnpm api:migrate:local
pnpm api:dev
pnpm start
```

Open `http://localhost:4200`. The app targets port `8787` on the page's current
hostname by default. A deployment can set `window.__NGRX_OFFLINE_CONFIG__.apiBaseUrl`
before the application bundle runs.

Production builds use `/ngrx-offline/` as the GitHub Pages base path and emit
an Angular service worker extended with the outbox executor:

```bash
pnpm build:showcase
```

See the in-app Learn section for the guided scenario and implementation
snippets.
