# App Engine

<p style="color: red;"><strong>Warning:</strong> Run App Engine apps at your own discretion. Running untrusted code carries security risks.</p>

An Obsidian plugin that gives embedded apps local-first persistent storage over notes in your vault.
Manipulate your data however you want, call external APIs, and work offline.

You can easily build apps with your AI agents by pointing them to this plugin and prompting. It also pairs extremely well with vault backup methods like git - take your apps anywhere, version control them, zero hosting hassle.

See the examples folder for ideas.

## What it does

It exposes a small API for apps embedded by App Engine to read and write files inside a folder in your vault.

It renders `app-engine` code blocks into managed iframes and resolves relative `src` paths into Obsidian vault resource URLs, so embeds like `./apps/griddlers/index.html` keep working when your vault moves.

The plugin only supports single-page html files with inline CSS and JS. complex projects that use frameworks like react are out of scope, though you can probably compile them to such a single page html.


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
8. Build your apps! i recommend a harness like codex or claude code, set to the root vault folder. example prompt:

```
Using the plugin at .obsidian/plugins/obsidian-app-engine, build a single-page html app, with inline CSS and javascript, that runs inside Obsidian and uses a single "Apps/todolist/state.json" file to save its state. Use obsidian's background color #1e1e1e and a dark theme. The app itself should allow the user to add recurring tasks, that have a name, recurrence interval and a list of user-defined tags. The tasks will be sorted by their due date, and there should be a button next to each one that sets the last completed time to today. Clicking the button multiple times should be idempotent, i.e. set the date to <today> + <interval>.
```

## App embeds

Use an `app-engine` code block to embed an app with per-embed parameters:

````md
```app-engine
src: ./apps/griddlers/index.html
allowed-root-folder: Apps/Griddlers
pretty-print-json: true
height: 720px
```
````

Supported App Engine parameters:

- `src`: required vault-local app entry file. External URLs are not supported, as a security measure.
- `allowed-root-folder`: optional vault folder the embed can read/write. Defaults to `Apps`.
- `pretty-print-json`: optional boolean. Defaults to `false`, so JSON writes are compact.

Other parameters are passed to the app in an initial `obsidian-app-engine:context` message.

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

Nested iframes inside an app are not registered with App Engine. They cannot use the bridge unless the app intentionally forwards messages for them.

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
- `fetchDataUrl`

## Notes

- This is convenience-first, not a hardened security boundary.
- The plugin intentionally limits each embed to one allowed root folder.
- Only iframes created from `app-engine` blocks can use the storage bridge.
