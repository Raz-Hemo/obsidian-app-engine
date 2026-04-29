const { Plugin, normalizePath, TFile } = require("obsidian");

const APP_NAMESPACE = "obsidian-app-engine";
const DEFAULT_ALLOWED_ROOT = "Apps";
const DEFAULT_EMBED_OPTIONS = {
  allowedRoot: DEFAULT_ALLOWED_ROOT,
  prettyPrintJson: false,
};

module.exports = class AppEnginePlugin extends Plugin {
  async onload() {
    this.iframeContexts = new WeakMap();

    this.requestHandler = (event) => {
      void this.handleMessageEvent(event);
    };

    window.addEventListener("message", this.requestHandler);

    this.registerMarkdownCodeBlockProcessor("app-engine", (source, element, context) => {
      this.renderAppEngineBlock(source, element, context);
    });
    console.log("[App Engine] loaded");
  }

  onunload() {
    window.removeEventListener("message", this.requestHandler);
    console.log("[App Engine] unloaded");
  }

  createEmbedOptions(params = {}) {
    return {
      allowedRoot: normalizePath(params.allowedRoot || DEFAULT_EMBED_OPTIONS.allowedRoot),
      prettyPrintJson: params.prettyPrintJson === true,
      params,
    };
  }

  normalizeRequestedPath(inputPath, options = this.createEmbedOptions()) {
    if (typeof inputPath !== "string" || !inputPath.trim()) {
      throw new Error("A non-empty path is required.");
    }

    const normalized = normalizePath(inputPath.trim());
    const allowedRoot = normalizePath(options.allowedRoot || DEFAULT_ALLOWED_ROOT);

    if (normalized === allowedRoot || normalized.startsWith(`${allowedRoot}/`)) {
      return normalized;
    }

    throw new Error(`Path must stay inside ${allowedRoot}.`);
  }

  async ensureFolder(path, options = this.createEmbedOptions()) {
    const normalized = this.normalizeRequestedPath(path, options);
    const parts = normalized.split("/");
    let current = "";

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) {
        await this.app.vault.createFolder(current);
      }
    }

    return { path: normalized };
  }

  async ensureParentFolder(filePath, options = this.createEmbedOptions()) {
    const segments = filePath.split("/");
    segments.pop();
    if (segments.length > 0) {
      await this.ensureFolder(segments.join("/"), options);
    }
  }

  async readText(path, options = this.createEmbedOptions()) {
    const normalized = this.normalizeRequestedPath(path, options);
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (!(existing instanceof TFile)) {
      throw new Error(`File not found: ${normalized}`);
    }

    return {
      path: normalized,
      content: await this.app.vault.cachedRead(existing),
      mtime: existing.stat.mtime,
      size: existing.stat.size,
    };
  }

  async writeText(path, content, options = this.createEmbedOptions()) {
    const normalized = this.normalizeRequestedPath(path, options);
    await this.ensureParentFolder(normalized, options);
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    const nextContent = typeof content === "string" ? content : String(content ?? "");

    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, nextContent);
    } else {
      await this.app.vault.create(normalized, nextContent);
    }

    return this.readText(normalized, options);
  }

  async readJson(path, options = this.createEmbedOptions()) {
    const file = await this.readText(path, options);
    return {
      ...file,
      data: JSON.parse(file.content || "null"),
    };
  }

  async writeJson(path, value, options = this.createEmbedOptions()) {
    const content = options.prettyPrintJson
      ? `${JSON.stringify(value, null, 2)}\n`
      : JSON.stringify(value);

    return this.writeText(path, content, options);
  }

  async listDirectory(directory = DEFAULT_ALLOWED_ROOT, requestOptions = {}, embedOptions = this.createEmbedOptions()) {
    const normalized = this.normalizeRequestedPath(directory, embedOptions);
    const recursive = requestOptions?.recursive !== false;
    const files = this.app.vault.getFiles()
      .filter((file) => file.path === normalized || file.path.startsWith(`${normalized}/`));

    return files
      .filter((file) => recursive || file.parent?.path === normalized)
      .map((file) => ({
        path: file.path,
        name: file.name,
        parent: file.parent?.path ?? "",
        extension: file.extension,
        mtime: file.stat.mtime,
        size: file.stat.size,
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  async removePath(path, options = this.createEmbedOptions()) {
    const normalized = this.normalizeRequestedPath(path, options);
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (!existing) {
      return { path: normalized, removed: false };
    }

    await this.app.vault.trash(existing, false);
    return { path: normalized, removed: true };
  }

  async handleMessageEvent(event) {
    const payload = event?.data;
    if (!this.isSupportedRequest(payload)) {
      return;
    }

    const embedOptions = this.getEventEmbedOptions(event);
    if (!embedOptions) {
      return;
    }

    const namespace = payload.namespace;
    const respond = (response) => {
      if (event.source && typeof event.source.postMessage === "function") {
        event.source.postMessage({
          namespace,
          type: `${namespace}:response`,
          requestId: payload.requestId ?? null,
          ...response,
        }, "*");
      }
    };

    try {
      const result = await this.executeCommand(payload.command, payload.args ?? {}, embedOptions);
      respond({ ok: true, result });
    } catch (error) {
      respond({ ok: false, error: error?.message ?? "Unknown app engine error." });
    }
  }

  async executeCommand(command, args, embedOptions = this.createEmbedOptions()) {
    switch (command) {
      case "readText":
        return this.readText(args.path, embedOptions);
      case "writeText":
        return this.writeText(args.path, args.content, embedOptions);
      case "readJson":
        return this.readJson(args.path, embedOptions);
      case "writeJson":
        return this.writeJson(args.path, args.data, embedOptions);
      case "list":
        return this.listDirectory(args.path ?? embedOptions.allowedRoot, { recursive: args.recursive }, embedOptions);
      case "remove":
        return this.removePath(args.path, embedOptions);
      case "ensureFolder":
        return this.ensureFolder(args.path, embedOptions);
      case "ping":
        return {
          ok: true,
          pluginVersion: this.manifest.version,
          allowedRoot: embedOptions.allowedRoot,
          prettyPrintJson: embedOptions.prettyPrintJson,
        };
      default:
        throw new Error(`Unknown app engine command: ${command}`);
    }
  }

  isSupportedRequest(payload) {
    return payload?.namespace === APP_NAMESPACE && payload?.type === `${APP_NAMESPACE}:request`;
  }

  getEventEmbedOptions(event) {
    if (event?.source && this.iframeContexts?.has(event.source)) {
      return this.iframeContexts.get(event.source);
    }

    return null;
  }

  renderAppEngineBlock(source, element, context) {
    element.empty();

    let config;
    try {
      config = this.parseAppEngineBlock(source);
    } catch (error) {
      element.createEl("pre", { text: error?.message ?? "Could not parse app-engine block." });
      return;
    }

    const resolvedSrc = this.resolveAppSrc(config.src, context?.sourcePath);
    if (!resolvedSrc) {
      element.createEl("pre", { text: `App Engine target not found: ${config.src}` });
      return;
    }

    const iframe = element.createEl("iframe", {
      attr: {
        loading: "lazy",
      },
    });
    iframe.style.width = config.params.width ? String(config.params.width) : "100%";
    iframe.style.height = config.params.height ? String(config.params.height) : "600px";
    iframe.style.border = config.params.border ? String(config.params.border) : "0";

    const embedOptions = this.createEmbedOptions(config.params);
    iframe.addEventListener("load", () => {
      if (iframe.contentWindow) {
        this.iframeContexts.set(iframe.contentWindow, embedOptions);
        iframe.contentWindow.postMessage({
          namespace: APP_NAMESPACE,
          type: `${APP_NAMESPACE}:context`,
          allowedRoot: embedOptions.allowedRoot,
          prettyPrintJson: embedOptions.prettyPrintJson,
          params: embedOptions.params,
        }, "*");
      }
    });

    if (iframe.contentWindow) {
      this.iframeContexts.set(iframe.contentWindow, embedOptions);
    }

    iframe.setAttribute("src", this.appendAppParams(resolvedSrc, config.params));
  }

  parseAppEngineBlock(source) {
    const params = {};

    for (const line of source.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separatorIndex = trimmed.indexOf(":");
      if (separatorIndex === -1) {
        throw new Error(`Invalid app-engine line: ${line}`);
      }

      const key = this.normalizeParamKey(trimmed.slice(0, separatorIndex));
      const value = this.parseParamValue(trimmed.slice(separatorIndex + 1).trim());
      params[key] = value;
    }

    if (typeof params.src !== "string" || !params.src.trim()) {
      throw new Error("app-engine blocks require a src parameter.");
    }

    return {
      src: params.src,
      params,
    };
  }

  normalizeParamKey(key) {
    const normalized = key.trim().toLowerCase().replace(/[\s_-]+(.)/g, (_, char) => char.toUpperCase());
    if (normalized === "allowedRootFolder" || normalized === "root") {
      return "allowedRoot";
    }
    if (normalized === "prettyPrint" || normalized === "prettyJson") {
      return "prettyPrintJson";
    }

    return normalized;
  }

  parseParamValue(value) {
    const unquoted = value.replace(/^(['"])(.*)\1$/, "$2");
    if (/^(true|false)$/i.test(unquoted)) {
      return unquoted.toLowerCase() === "true";
    }
    if (/^-?\d+(\.\d+)?$/.test(unquoted)) {
      return Number(unquoted);
    }

    return unquoted;
  }

  resolveAppSrc(src, sourcePath) {
    if (typeof src !== "string" || !src.trim()) {
      return null;
    }

    const trimmed = src.trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//") || trimmed.startsWith("#")) {
      return trimmed;
    }

    return this.resolveVaultResourcePath(trimmed, sourcePath);
  }

  appendAppParams(src, params) {
    const entries = Object.entries(params)
      .filter(([key]) => key !== "src")
      .filter(([, value]) => value !== undefined && value !== null && value !== "");

    if (entries.length === 0) {
      return src;
    }

    const query = entries
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      .join("&");
    const separator = src.includes("?") ? "&" : "?";

    return `${src}${separator}${query}`;
  }

  resolveVaultResourcePath(src, sourcePath) {
    if (typeof src !== "string") {
      return null;
    }

    const trimmed = src.trim();
    if (!trimmed) {
      return null;
    }

    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//") || trimmed.startsWith("#")) {
      return null;
    }

    const normalizedSourcePath = typeof sourcePath === "string" ? normalizePath(sourcePath) : "";
    const sourceDirectory = normalizedSourcePath.includes("/")
      ? normalizedSourcePath.slice(0, normalizedSourcePath.lastIndexOf("/"))
      : "";

    const candidatePath = this.resolveVaultRelativePath(sourceDirectory, trimmed);
    const target = this.app.vault.getAbstractFileByPath(candidatePath);
    if (!(target instanceof TFile)) {
      return null;
    }

    return this.app.vault.getResourcePath(target);
  }

  resolveVaultRelativePath(baseDirectory, relativePath) {
    const segments = [];

    if (baseDirectory) {
      segments.push(...baseDirectory.split("/").filter(Boolean));
    }

    for (const segment of relativePath.split("/")) {
      const trimmedSegment = segment.trim();
      if (!trimmedSegment || trimmedSegment === ".") {
        continue;
      }

      if (trimmedSegment === "..") {
        if (segments.length > 0) {
          segments.pop();
        }
        continue;
      }

      segments.push(trimmedSegment);
    }

    return normalizePath(segments.join("/"));
  }
};
