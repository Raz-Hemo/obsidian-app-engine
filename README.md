# App Engine

A tiny Obsidian plugin that gives embedded apps local-first persistent storage over notes in your vault.

## What it does

It exposes a small API for apps embedded by App Engine to read and write files inside a folder in your vault.

It renders `app-engine` code blocks into managed iframes and resolves relative `src` paths into Obsidian vault resource URLs, so embeds like `./apps/griddlers/index.html` keep working when your vault moves.

Default root folder:

- `Apps`

Example files your apps might create:

- `Apps/Griddlers/state/295279.json`
- `Apps/Griddlers/settings.json`
- `Apps/Whiteboard/session-01.json`

## Install in a vault

1. Open your vault folder.
2. Create this plugin folder if it does not exist:
   - `.obsidian/plugins/obsidian-app-engine/`
3. Copy these files into that folder:
   - `manifest.json`
   - `main.js`
   - `versions.json`
4. In Obsidian, open `Settings -> Community plugins`.
5. Turn off `Restricted mode` if needed.
6. Click `Reload plugins` or restart Obsidian.
7. Enable `App Engine`.

## App embeds

Use an `app-engine` code block to embed an app with per-embed parameters:

````md
```app-engine
src: ./apps/griddlers/index.html
allowed-root-folder: Apps/Griddlers
pretty-print-json: true
puzzleId: 295279
theme: dark
height: 720px
```
````

Supported App Engine parameters:

- `src`: required app entry file or URL.
- `allowed-root-folder`: optional vault folder the embed can read/write. Defaults to `Apps`.
- `pretty-print-json`: optional boolean. Defaults to `false`, so JSON writes are compact.

Other parameters are passed through to the app as query parameters and in an initial `obsidian-app-engine:context` message.

Context message:

```js
window.addEventListener("message", (event) => {
  const payload = event.data;
  if (payload?.namespace !== "obsidian-app-engine") return;
  if (payload?.type !== "obsidian-app-engine:context") return;

  console.log(payload.allowedRoot, payload.prettyPrintJson, payload.params);
});
```

## Iframe bridge

Apps embedded with an `app-engine` block communicate with `postMessage`. Raw `<iframe>` elements are ignored by App Engine and cannot use this bridge.

Request shape:

```js
window.parent.postMessage({
  namespace: "obsidian-app-engine",
  type: "obsidian-app-engine:request",
  requestId: "123",
  command: "writeJson",
  args: {
    path: "Apps/Griddlers/state/295279.json",
    data: { puzzleId: 295279, solved: false }
  }
}, "*");
```

Response shape:

```js
window.addEventListener("message", (event) => {
  const payload = event.data;
  if (payload?.namespace !== "obsidian-app-engine") return;
  if (payload?.type !== "obsidian-app-engine:response") return;

  console.log(payload.ok, payload.result, payload.error);
});
```

Supported commands:

- `ping`
- `readText`
- `writeText`
- `readJson`
- `writeJson`
- `list`
- `remove`
- `ensureFolder`

## Notes

- This is convenience-first, not a hardened security boundary.
- The plugin intentionally limits each embed to one allowed root folder.
- Only iframes created from `app-engine` blocks can use the storage bridge.
