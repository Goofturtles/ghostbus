# CREDITS

Everything GhostBus uses that someone else made, and the terms it uses it under.

---

## 1. npm dependencies and their licences

### How this list was generated

Two published tools were checked first, and both exist:
`npm view license-checker version` → **25.0.1**, `npm view license-report version` →
**6.8.5**. Neither was used, because both would mean adding a dependency (or executing
a fetched package) purely to read data already sitting on disk.

Instead the list below is derived **mechanically from `node_modules` itself**: a script
walks every directory under `node_modules` including nested `node_modules` trees, reads
each `package.json`, and takes the `license` field — falling back to the legacy
`licenses` array form where a package still uses it. Duplicate `name@version` pairs are
collapsed. The exact walk is reproducible:

```bash
node -e "
const fs=require('fs'),path=require('path');
function walk(dir,out){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
  if(!e.isDirectory()||e.name==='.bin')continue;
  if(e.name.startsWith('@')){walk(path.join(dir,e.name),out);continue;}
  const pj=path.join(dir,e.name,'package.json');
  if(fs.existsSync(pj)){const j=JSON.parse(fs.readFileSync(pj,'utf8'));
    let L=j.license; if(!L&&j.licenses)L=(Array.isArray(j.licenses)?j.licenses:[j.licenses]).map(x=>x.type||x).join(' OR ');
    if(L&&typeof L==='object')L=L.type;
    if(j.name&&j.version)out.push({name:j.name,version:j.version,license:L||'UNKNOWN'});}
  const n=path.join(dir,e.name,'node_modules'); if(fs.existsSync(n))walk(n,out);
}}
const all=[];walk('node_modules',all);
const u=new Map(); for(const p of all)u.set(p.name+'@'+p.version,p);
console.log(u.size+' unique packages');
"
```

Result: **304 unique `name@version` packages installed**, and **zero of them have an
undeclared licence**. The distribution:

| Licence | Packages |
|---|---:|
| MIT | 217 |
| ISC | 38 |
| BSD-3-Clause | 19 |
| Apache-2.0 | 10 |
| BSD-2-Clause | 10 |
| BlueOak-1.0.0 | 4 |
| (MIT OR Apache-2.0) | 1 |
| Apache 2.0 *(legacy `licenses` array form — `gtfs-realtime-bindings`)* | 1 |
| Python-2.0 | 1 |
| CC-BY-4.0 | 1 |
| Unlicense | 1 |
| 0BSD | 1 |
| **Total** | **304** |

All are permissive. There is no copyleft (GPL/LGPL/AGPL) anywhere in the tree.

### Direct runtime dependencies

| Package | Range in `package.json` | Installed | Licence | What it does here |
|---|---|---|---|---|
| `fastify` | `^4.28.1` | 4.29.1 | MIT | The HTTP server |
| `@fastify/cors` | `^9.0.1` | 9.0.1 | MIT | CORS, locked to localhost dev origins |
| `@fastify/helmet` | `^11.1.1` | 11.1.1 | MIT | Security response headers |
| `@fastify/rate-limit` | `^9.1.0` | 9.1.0 | MIT | 120 req/min |
| `@fastify/static` | `^7.0.4` | 7.0.4 | MIT | Serves the built SPA in production |
| `pg` | `^8.22.0` | 8.22.0 | MIT | node-postgres — the Neon/production driver |
| `@electric-sql/pglite` | `^0.5.4` | 0.5.4 | Apache-2.0 | Embedded WASM Postgres — the zero-signup local driver |
| `gtfs-realtime-bindings` | `^1.1.1` | 1.1.1 | Apache 2.0 | Decodes the GTFS-realtime protobuf |
| `adm-zip` | `^0.6.0` | 0.6.0 | MIT | Extracts the static GTFS zip |
| `csv-parse` | `^7.0.1` | 7.0.1 | MIT | Streams the GTFS CSVs (ships its own types) |
| `maplibre-gl` | `^6.0.0` | 6.0.0 | BSD-3-Clause | The map renderer |
| `react` | `^18.3.1` | 18.3.1 | MIT | UI |
| `react-dom` | `^18.3.1` | 18.3.1 | MIT | UI |
| `zustand` | `^5.0.0` | 5.0.14 | MIT | Client state |
| `i18next` | `^23.15.1` | 23.16.8 | MIT | i18n runtime |
| `react-i18next` | `^15.0.2` | 15.7.4 | MIT | i18n React bindings |

### Direct dev dependencies

| Package | Range | Installed | Licence |
|---|---|---|---|
| `typescript` | `^5.6.2` | 5.9.3 | Apache-2.0 |
| `tsx` | `^4.19.1` | 4.23.1 | MIT |
| `vite` | `^5.4.8` | 5.4.21 | MIT |
| `@vitejs/plugin-react` | `^4.3.2` | 4.7.0 | MIT |
| `concurrently` | `^9.0.1` | 9.2.4 | MIT |
| `@types/node` | `^20.16.10` | 20.19.43 | MIT |
| `@types/pg` | `^8.20.0` | 8.20.0 | MIT |
| `@types/adm-zip` | `^0.5.8` | 0.5.8 | MIT |
| `@types/react` | `^18.3.11` | 18.3.31 | MIT |
| `@types/react-dom` | `^18.3.0` | 18.3.7 | MIT |

Note that `tsx` is a *dev* dependency the *runtime* depends on — `npm start` is
`node --import tsx server/src/server.ts`. See `render.yaml` for why the deploy must not
prune devDependencies.

`TOOLKIT.md` records the per-package verification history (every dependency was checked
with `npm view` before being added, and the installed version recorded afterwards).

<details>
<summary><strong>Full transitive list — all 304 installed packages</strong></summary>

| Package | Version | Licence |
|---|---|---|
| `@babel/code-frame` | 7.29.7 | MIT |
| `@babel/compat-data` | 7.29.7 | MIT |
| `@babel/core` | 7.29.7 | MIT |
| `@babel/generator` | 7.29.7 | MIT |
| `@babel/helper-compilation-targets` | 7.29.7 | MIT |
| `@babel/helper-globals` | 7.29.7 | MIT |
| `@babel/helper-module-imports` | 7.29.7 | MIT |
| `@babel/helper-module-transforms` | 7.29.7 | MIT |
| `@babel/helper-plugin-utils` | 7.29.7 | MIT |
| `@babel/helper-string-parser` | 7.29.7 | MIT |
| `@babel/helper-validator-identifier` | 7.29.7 | MIT |
| `@babel/helper-validator-option` | 7.29.7 | MIT |
| `@babel/helpers` | 7.29.7 | MIT |
| `@babel/parser` | 7.29.7 | MIT |
| `@babel/plugin-transform-react-jsx-self` | 7.29.7 | MIT |
| `@babel/plugin-transform-react-jsx-source` | 7.29.7 | MIT |
| `@babel/runtime` | 7.29.7 | MIT |
| `@babel/template` | 7.29.7 | MIT |
| `@babel/traverse` | 7.29.7 | MIT |
| `@babel/types` | 7.29.7 | MIT |
| `@electric-sql/pglite` | 0.5.4 | Apache-2.0 |
| `@esbuild/win32-x64` | 0.21.5 | MIT |
| `@esbuild/win32-x64` | 0.28.1 | MIT |
| `@fastify/accept-negotiator` | 1.1.0 | MIT |
| `@fastify/ajv-compiler` | 3.6.0 | MIT |
| `@fastify/cors` | 9.0.1 | MIT |
| `@fastify/error` | 3.4.1 | MIT |
| `@fastify/fast-json-stringify-compiler` | 4.3.0 | MIT |
| `@fastify/helmet` | 11.1.1 | MIT |
| `@fastify/merge-json-schemas` | 0.1.1 | MIT |
| `@fastify/rate-limit` | 9.1.0 | MIT |
| `@fastify/send` | 2.1.0 | MIT |
| `@fastify/static` | 7.0.4 | MIT |
| `@isaacs/cliui` | 8.0.2 | ISC |
| `@jridgewell/gen-mapping` | 0.3.13 | MIT |
| `@jridgewell/remapping` | 2.3.5 | MIT |
| `@jridgewell/resolve-uri` | 3.1.2 | MIT |
| `@jridgewell/sourcemap-codec` | 1.5.5 | MIT |
| `@jridgewell/trace-mapping` | 0.3.31 | MIT |
| `@jsdoc/salty` | 0.2.12 | Apache-2.0 |
| `@lukeed/ms` | 2.0.2 | MIT |
| `@mapbox/jsonlint-lines-primitives` | 2.0.3 | MIT |
| `@mapbox/point-geometry` | 1.1.0 | ISC |
| `@mapbox/tiny-sdf` | 2.2.0 | BSD-2-Clause |
| `@mapbox/unitbezier` | 1.0.0 | BSD-2-Clause |
| `@mapbox/vector-tile` | 3.0.0 | BSD-3-Clause |
| `@maplibre/geojson-vt` | 6.1.1 | ISC |
| `@maplibre/maplibre-gl-style-spec` | 26.2.1 | ISC |
| `@maplibre/mlt` | 1.1.12 | (MIT OR Apache-2.0) |
| `@maplibre/vt-pbf` | 4.3.2 | MIT |
| `@pinojs/redact` | 0.4.0 | MIT |
| `@pkgjs/parseargs` | 0.11.0 | MIT |
| `@protobufjs/aspromise` | 1.1.2 | BSD-3-Clause |
| `@protobufjs/base64` | 1.1.2 | BSD-3-Clause |
| `@protobufjs/codegen` | 2.0.5 | BSD-3-Clause |
| `@protobufjs/eventemitter` | 1.1.1 | BSD-3-Clause |
| `@protobufjs/fetch` | 1.1.1 | BSD-3-Clause |
| `@protobufjs/float` | 1.0.2 | BSD-3-Clause |
| `@protobufjs/path` | 1.1.2 | BSD-3-Clause |
| `@protobufjs/pool` | 1.1.0 | BSD-3-Clause |
| `@protobufjs/utf8` | 1.1.2 | BSD-3-Clause |
| `@rolldown/pluginutils` | 1.0.0-beta.27 | MIT |
| `@rollup/rollup-win32-x64-gnu` | 4.62.2 | MIT |
| `@rollup/rollup-win32-x64-msvc` | 4.62.2 | MIT |
| `@types/adm-zip` | 0.5.8 | MIT |
| `@types/babel__core` | 7.20.5 | MIT |
| `@types/babel__generator` | 7.27.0 | MIT |
| `@types/babel__template` | 7.4.4 | MIT |
| `@types/babel__traverse` | 7.28.0 | MIT |
| `@types/estree` | 1.0.9 | MIT |
| `@types/geojson` | 7946.0.16 | MIT |
| `@types/linkify-it` | 5.0.0 | MIT |
| `@types/markdown-it` | 14.1.2 | MIT |
| `@types/mdurl` | 2.0.0 | MIT |
| `@types/node` | 20.19.43 | MIT |
| `@types/pg` | 8.20.0 | MIT |
| `@types/prop-types` | 15.7.15 | MIT |
| `@types/react` | 18.3.31 | MIT |
| `@types/react-dom` | 18.3.7 | MIT |
| `@vitejs/plugin-react` | 4.7.0 | MIT |
| `abstract-logging` | 2.0.1 | MIT |
| `acorn` | 8.17.0 | MIT |
| `acorn-jsx` | 5.3.2 | MIT |
| `adm-zip` | 0.6.0 | MIT |
| `ajv` | 8.20.0 | MIT |
| `ajv-formats` | 2.1.1 | MIT |
| `ajv-formats` | 3.0.1 | MIT |
| `ansi-regex` | 5.0.1 | MIT |
| `ansi-regex` | 6.2.2 | MIT |
| `ansi-styles` | 4.3.0 | MIT |
| `ansi-styles` | 6.2.3 | MIT |
| `argparse` | 2.0.1 | Python-2.0 |
| `atomic-sleep` | 1.0.0 | MIT |
| `avvio` | 8.4.0 | MIT |
| `balanced-match` | 1.0.2 | MIT |
| `baseline-browser-mapping` | 2.11.1 | Apache-2.0 |
| `bluebird` | 3.7.2 | MIT |
| `brace-expansion` | 2.1.2 | MIT |
| `browserslist` | 4.28.7 | MIT |
| `caniuse-lite` | 1.0.30001806 | CC-BY-4.0 |
| `catharsis` | 0.9.0 | MIT |
| `chalk` | 4.1.2 | MIT |
| `cliui` | 8.0.1 | ISC |
| `color-convert` | 2.0.1 | MIT |
| `color-name` | 1.1.4 | MIT |
| `concurrently` | 9.2.4 | MIT |
| `content-disposition` | 0.5.4 | MIT |
| `convert-source-map` | 2.0.0 | MIT |
| `cookie` | 0.7.2 | MIT |
| `cross-spawn` | 7.0.6 | MIT |
| `csstype` | 3.2.3 | MIT |
| `csv-parse` | 7.0.1 | MIT |
| `debug` | 4.4.3 | MIT |
| `deep-is` | 0.1.4 | MIT |
| `depd` | 2.0.0 | MIT |
| `earcut` | 3.2.3 | ISC |
| `eastasianwidth` | 0.2.0 | MIT |
| `electron-to-chromium` | 1.5.396 | ISC |
| `emoji-regex` | 8.0.0 | MIT |
| `emoji-regex` | 9.2.2 | MIT |
| `entities` | 4.5.0 | BSD-2-Clause |
| `esbuild` | 0.21.5 | MIT |
| `esbuild` | 0.28.1 | MIT |
| `escalade` | 3.2.0 | MIT |
| `escape-html` | 1.0.3 | MIT |
| `escape-string-regexp` | 2.0.0 | MIT |
| `escodegen` | 1.14.3 | BSD-2-Clause |
| `eslint-visitor-keys` | 3.4.3 | Apache-2.0 |
| `espree` | 9.6.1 | BSD-2-Clause |
| `esprima` | 4.0.1 | BSD-2-Clause |
| `estraverse` | 4.3.0 | BSD-2-Clause |
| `estraverse` | 5.3.0 | BSD-2-Clause |
| `esutils` | 2.0.3 | BSD-2-Clause |
| `fast-content-type-parse` | 1.1.0 | MIT |
| `fast-decode-uri-component` | 1.0.1 | MIT |
| `fast-deep-equal` | 3.1.3 | MIT |
| `fast-json-stringify` | 5.16.1 | MIT |
| `fast-levenshtein` | 2.0.6 | MIT |
| `fast-querystring` | 1.1.2 | MIT |
| `fast-uri` | 2.4.3 | MIT |
| `fast-uri` | 3.1.4 | BSD-3-Clause |
| `fastify` | 4.29.1 | MIT |
| `fastify-plugin` | 4.5.1 | MIT |
| `fastq` | 1.20.1 | ISC |
| `find-my-way` | 8.2.2 | MIT |
| `foreground-child` | 3.3.1 | ISC |
| `forwarded` | 0.2.0 | MIT |
| `fs.realpath` | 1.0.0 | ISC |
| `gensync` | 1.0.0-beta.2 | MIT |
| `get-caller-file` | 2.0.5 | ISC |
| `gl-matrix` | 3.4.4 | MIT |
| `glob` | 10.5.0 | ISC |
| `glob` | 8.1.0 | ISC |
| `graceful-fs` | 4.2.11 | ISC |
| `gtfs-realtime-bindings` | 1.1.1 | Apache 2.0 |
| `has-flag` | 4.0.0 | MIT |
| `helmet` | 7.2.0 | MIT |
| `html-parse-stringify` | 3.1.0 | MIT |
| `http-errors` | 2.0.0 | MIT |
| `i18next` | 23.16.8 | MIT |
| `inflight` | 1.0.6 | ISC |
| `inherits` | 2.0.4 | ISC |
| `ipaddr.js` | 1.9.1 | MIT |
| `is-fullwidth-code-point` | 3.0.0 | MIT |
| `isexe` | 2.0.0 | ISC |
| `jackspeak` | 3.4.3 | BlueOak-1.0.0 |
| `js-tokens` | 4.0.0 | MIT |
| `js2xmlparser` | 4.0.2 | Apache-2.0 |
| `jsdoc` | 4.0.5 | Apache-2.0 |
| `jsesc` | 3.1.0 | MIT |
| `json-schema-ref-resolver` | 1.0.1 | MIT |
| `json-schema-traverse` | 1.0.0 | MIT |
| `json-stringify-pretty-compact` | 4.0.0 | MIT |
| `json5` | 2.2.3 | MIT |
| `kdbush` | 4.1.0 | ISC |
| `klaw` | 3.0.0 | MIT |
| `levn` | 0.3.0 | MIT |
| `light-my-request` | 5.14.0 | BSD-3-Clause |
| `linkify-it` | 5.0.2 | MIT |
| `lodash` | 4.18.1 | MIT |
| `long` | 5.3.2 | Apache-2.0 |
| `loose-envify` | 1.4.0 | MIT |
| `lru-cache` | 10.4.3 | ISC |
| `lru-cache` | 5.1.1 | ISC |
| `maplibre-gl` | 6.0.0 | BSD-3-Clause |
| `markdown-it` | 14.3.0 | MIT |
| `markdown-it-anchor` | 8.6.7 | Unlicense |
| `marked` | 4.3.0 | MIT |
| `mdurl` | 2.1.0 | MIT |
| `mime` | 3.0.0 | MIT |
| `minimatch` | 5.1.9 | ISC |
| `minimatch` | 9.0.9 | ISC |
| `minimist` | 1.2.8 | MIT |
| `minipass` | 7.1.3 | BlueOak-1.0.0 |
| `mkdirp` | 1.0.4 | MIT |
| `mnemonist` | 0.39.6 | MIT |
| `ms` | 2.1.3 | MIT |
| `murmurhash-js` | 1.0.0 | MIT |
| `nanoid` | 3.3.16 | MIT |
| `node-releases` | 2.0.51 | MIT |
| `obliterator` | 2.0.5 | MIT |
| `on-exit-leak-free` | 2.1.2 | MIT |
| `once` | 1.4.0 | ISC |
| `optionator` | 0.8.3 | MIT |
| `package-json-from-dist` | 1.0.1 | BlueOak-1.0.0 |
| `path-key` | 3.1.1 | MIT |
| `path-scurry` | 1.11.1 | BlueOak-1.0.0 |
| `pbf` | 5.1.2 | BSD-3-Clause |
| `pg` | 8.22.0 | MIT |
| `pg-cloudflare` | 1.4.0 | MIT |
| `pg-connection-string` | 2.14.0 | MIT |
| `pg-int8` | 1.0.1 | ISC |
| `pg-pool` | 3.14.0 | MIT |
| `pg-protocol` | 1.15.0 | MIT |
| `pg-types` | 2.2.0 | MIT |
| `pgpass` | 1.0.5 | MIT |
| `picocolors` | 1.1.1 | ISC |
| `pino` | 9.14.0 | MIT |
| `pino-abstract-transport` | 2.0.0 | MIT |
| `pino-std-serializers` | 7.1.0 | MIT |
| `postcss` | 8.5.23 | MIT |
| `postgres-array` | 2.0.0 | MIT |
| `postgres-bytea` | 1.0.1 | MIT |
| `postgres-date` | 1.0.7 | MIT |
| `postgres-interval` | 1.2.0 | MIT |
| `potpack` | 2.1.0 | ISC |
| `prelude-ls` | 1.1.2 | MIT |
| `process-warning` | 3.0.0 | MIT |
| `process-warning` | 5.0.0 | MIT |
| `protobufjs` | 7.6.5 | BSD-3-Clause |
| `protobufjs-cli` | 1.3.3 | BSD-3-Clause |
| `protocol-buffers-schema` | 3.6.1 | MIT |
| `proxy-addr` | 2.0.7 | MIT |
| `punycode.js` | 2.3.1 | MIT |
| `quick-format-unescaped` | 4.0.4 | MIT |
| `quickselect` | 3.0.0 | ISC |
| `react` | 18.3.1 | MIT |
| `react-dom` | 18.3.1 | MIT |
| `react-i18next` | 15.7.4 | MIT |
| `react-refresh` | 0.17.0 | MIT |
| `real-require` | 0.2.0 | MIT |
| `require-directory` | 2.1.1 | MIT |
| `require-from-string` | 2.0.2 | MIT |
| `requizzle` | 0.2.4 | MIT |
| `resolve-protobuf-schema` | 2.1.0 | MIT |
| `ret` | 0.4.3 | MIT |
| `reusify` | 1.1.0 | MIT |
| `rfdc` | 1.4.1 | MIT |
| `rollup` | 4.62.2 | MIT |
| `rxjs` | 7.8.2 | Apache-2.0 |
| `safe-buffer` | 5.2.1 | MIT |
| `safe-regex2` | 3.1.0 | MIT |
| `safe-stable-stringify` | 2.5.0 | MIT |
| `scheduler` | 0.23.2 | MIT |
| `secure-json-parse` | 2.7.0 | BSD-3-Clause |
| `semver` | 6.3.1 | ISC |
| `semver` | 7.8.5 | ISC |
| `set-cookie-parser` | 2.7.2 | MIT |
| `setprototypeof` | 1.2.0 | ISC |
| `shebang-command` | 2.0.0 | MIT |
| `shebang-regex` | 3.0.0 | MIT |
| `shell-quote` | 1.9.0 | MIT |
| `signal-exit` | 4.1.0 | ISC |
| `sonic-boom` | 4.2.1 | MIT |
| `source-map` | 0.6.1 | BSD-3-Clause |
| `source-map-js` | 1.2.1 | BSD-3-Clause |
| `split2` | 4.2.0 | ISC |
| `statuses` | 2.0.1 | MIT |
| `string-width` | 4.2.3 | MIT |
| `string-width` | 5.1.2 | MIT |
| `strip-ansi` | 6.0.1 | MIT |
| `strip-ansi` | 7.2.0 | MIT |
| `strip-json-comments` | 3.1.1 | MIT |
| `supports-color` | 7.2.0 | MIT |
| `supports-color` | 8.1.1 | MIT |
| `thread-stream` | 3.2.0 | MIT |
| `tinyqueue` | 3.0.0 | ISC |
| `tmp` | 0.2.7 | MIT |
| `toad-cache` | 3.7.4 | MIT |
| `toidentifier` | 1.0.1 | MIT |
| `tree-kill` | 1.2.2 | MIT |
| `tslib` | 2.8.1 | 0BSD |
| `tsx` | 4.23.1 | MIT |
| `type-check` | 0.3.2 | MIT |
| `typescript` | 5.9.3 | Apache-2.0 |
| `uc.micro` | 2.1.0 | MIT |
| `uglify-js` | 3.19.3 | BSD-2-Clause |
| `underscore` | 1.13.8 | MIT |
| `undici-types` | 6.21.0 | MIT |
| `update-browserslist-db` | 1.2.3 | MIT |
| `vite` | 5.4.21 | MIT |
| `void-elements` | 3.1.0 | MIT |
| `which` | 2.0.2 | ISC |
| `word-wrap` | 1.2.5 | MIT |
| `wrap-ansi` | 7.0.0 | MIT |
| `wrap-ansi` | 8.1.0 | MIT |
| `wrappy` | 1.0.2 | ISC |
| `xmlcreate` | 2.0.4 | Apache-2.0 |
| `xtend` | 4.0.2 | MIT |
| `y18n` | 5.0.8 | ISC |
| `yallist` | 3.1.1 | ISC |
| `yargs` | 17.7.2 | MIT |
| `yargs-parser` | 21.1.1 | ISC |
| `zustand` | 5.0.14 | MIT |

</details>

---

## 2. Adapted third-party components

**None.** This section would be dishonest if it listed anything.

The entire interface — the Nearby view, the departure rows, the stop header, the tab
bar, the settings sheet, the skeleton loaders, the empty states, the icon set, the
voxel vehicle sprites, and both light and dark themes — was written from scratch for
this project. There is no UI kit, no component library, no copied CodePen, no
Tailwind, no shadcn, no Material, no Bootstrap. The CSS is hand-written across three
files (`tokens.css`, `global.css`, `app.css`). The icons in
`web/src/components/icons.tsx` are hand-authored inline SVG paths.

The map's vehicle sprites are **drawn procedurally onto an offscreen canvas at runtime**
(`web/src/map/sprites.ts`) rather than being image assets from anywhere — the isometric
voxel body, window band, headlight pixels and contact shadow are all code.

The two MapLibre styles in `web/src/map/mapStyle.ts` are hand-built: GhostBus does
**not** ship OpenFreeMap's default style, it paints every vector layer to its own design
tokens.

Third-party *libraries* are used as libraries — imported, versioned, and listed in §1.
None of their source has been copied into this repository or modified in place.

---

## 3. Fonts

**Zero webfonts. Nothing is downloaded.**

The entire app renders in a system font stack, defined once in
`web/src/styles/tokens.css`:

```css
--font: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text",
  "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
```

There is no `@font-face` rule, no `fonts.googleapis.com` link, no `.woff`/`.woff2` file
in the repository or the build. Every typeface named above is supplied by the reader's
own operating system under that OS's own licence; GhostBus neither redistributes nor
embeds any of them.

Numerals use OpenType `tnum`/`lnum` (tabular, lining) via a `--tabular` token so
countdown digits do not jitter — a font *feature*, still no download.

The map is the one exception worth naming, and it is not ours: MapLibre requests glyph
PBFs for map labels from OpenFreeMap's font endpoint (`Noto Sans Regular` and
`Noto Sans Bold`, both verified reachable; `Medium` 404s and is therefore unused).
Noto Sans is published by Google under the SIL Open Font License. Those glyphs are
served by OpenFreeMap and rendered inside the map canvas only — no page text uses them.

---

## 4. Map tiles and their terms

| Layer | Provider | Terms |
|---|---|---|
| Vector tiles | **OpenFreeMap** — <https://openfreemap.org> | Free public instance. Verified on its own site: *"there are no limits on the number of map views or requests. There's no registration, no user database, no API keys."* Commercial use explicitly permitted. Project licence: MIT. |
| Tile schema | **OpenMapTiles** — <https://www.openmaptiles.org/> | The vector schema the tiles are built to; credit required. |
| Underlying data | **OpenStreetMap** — <https://www.openstreetmap.org/copyright> | Data licensed under the **Open Data Commons Open Database License (ODbL)**. |

### Required attribution

OpenFreeMap specifies the string **"OpenFreeMap © OpenMapTiles Data from
OpenStreetMap"**, and notes that the OpenFreeMap portion itself is optional but
appreciated. The OSM Foundation's
[Attribution Guidelines](https://osmfoundation.org/wiki/Licence/Attribution_Guidelines)
accept **"© OpenStreetMap contributors"** as the credit for a browsable map, and require
that *"the attribution format should not require individuals to interact with the map
or produced work to see the attribution."*

### What GhostBus actually renders

The MapLibre `AttributionControl` is explicitly enabled, **forced expanded**, themed to
match the app, and never hidden. It renders:

> OpenFreeMap · OpenMapTiles · © OpenStreetMap

with all three as links to <https://openfreemap.org>, <https://www.openmaptiles.org/>
and <https://www.openstreetmap.org/copyright> respectively. It is visible without
interaction, satisfying the OSMF visibility requirement.

**Honest gap:** the rendered string says "© OpenStreetMap" where the OSMF guidelines'
accepted wording is "© OpenStreetMap **contributors**". The link to the copyright page
is present and correct, but the word is missing, and the guidelines' requirement to
"make clear that the data is available under the Open Database License" is met only by
that link rather than by explicit ODbL text. The string is a one-line change in
`web/src/map/mapStyle.ts`; it is recorded here rather than quietly rounded up to
"compliant".

---

## 5. Data feeds

### Static schedule — TTC Routes and Schedules (GTFS)

- **Source:** City of Toronto Open Data, dataset `ttc-routes-and-schedules`, published
  by the **Toronto Transit Commission** division, refreshed monthly, distributed as a
  GTFS ZIP.
  Portal page: <https://open.toronto.ca/dataset/ttc-routes-and-schedules/>
- **How GhostBus obtains it:** the seeder resolves the current download URL at runtime
  through the portal's CKAN API
  (`.../api/3/action/package_show?id=ttc-routes-and-schedules`) rather than hardcoding a
  file path, so a re-publish does not break the seed.
- **Licence:** **Open Government Licence – Toronto**, the portal's site-wide licence —
  <https://open.toronto.ca/open-data-licence/> (verified to resolve).
- **Required attribution**, quoted verbatim from that licence:

  > Contains information licensed under the Open Government Licence – Toronto.

  This string appears in `README.md` and is reproduced here.

  *Honest nuance:* the CKAN record's own `license_title` field for this dataset reads
  `"License not specified"`. The governing terms are the portal-wide Open Government
  Licence – Toronto linked above and shown on the dataset page footer; the empty
  metadata field is a gap in the publisher's record, not a different licence.

### Realtime — TTC GTFS-Realtime (GTFS-RT)

- **Source:** TTC GTFS-Realtime, catalogued as `ttc-gtfs-realtime-gtfs-rt` on the same
  portal (Toronto Transit Commission division, "Real-time" refresh).
  Portal page: <https://open.toronto.ca/dataset/ttc-gtfs-realtime-gtfs-rt/>
- **Endpoints polled** (unauthenticated, no key; each verified returning HTTP 200
  `application/x-google-protobuf` on 2026-07-24):
  - `https://bustime.ttc.ca/gtfsrt/vehicles`
  - `https://bustime.ttc.ca/gtfsrt/trips`
  - `https://bustime.ttc.ca/gtfsrt/alerts`
- **Licence and attribution:** same Open Government Licence – Toronto and the same
  attribution string as above.

### Format specifications

GTFS and GTFS-Realtime are open specifications maintained by MobilityData and the
community at <https://gtfs.org>. GhostBus implements against
<https://gtfs.org/documentation/realtime/reference/>. No specification text is
reproduced in this repository.

---

## 6. Downloaded assets

**None.** No stock photography, no icon pack, no illustration set, no sound, no 3D
model, no texture, no downloaded font file — nothing was fetched from an asset site and
committed to this repository.

The complete inventory of non-code files tracked by git is:

- `web/public/favicon.svg` — 5 hand-written SVG elements (a rounded rect, a bus
  silhouette path, two circles) authored for this project.
- `screenshots/phase3/*.png`, `screenshots/phase4/*.png` — 16 screenshots of GhostBus
  itself, captured from the running app.

Everything else in the repository is source code, SQL, configuration, or documentation.

The one thing that *is* fetched at runtime — map tiles — is covered in §4 and is
streamed from OpenFreeMap, not vendored.

---

## AI-use disclosure

GhostBus was built with **Claude Code** (Anthropic) through a spec-driven,
evidence-gated process: each phase began with a written specification, decisions and
deviations were recorded as they were made in `DECISIONS.md`, and measured limitations
were recorded in `BLOCKERS.md` at the moment they were discovered rather than
retrofitted afterwards. Dependencies were verified to exist with `npm view` before use
(`TOOLKIT.md`), and claims about the feed were re-measured against the live TTC
endpoints rather than assumed.

The same discipline is the product: the app does not render a prediction without the
evidence that supports it, and it says "we don't know" when it does not know. Building
it that way and documenting it that way were the same decision.

---

**Built by Arjun Sharma.**
