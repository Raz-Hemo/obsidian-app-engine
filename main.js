const { Plugin, normalizePath, TFile, requestUrl } = require("obsidian");

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
      allowedRoot: this.sanitizeAllowedRoot(params.allowedRoot || DEFAULT_EMBED_OPTIONS.allowedRoot),
      prettyPrintJson: params.prettyPrintJson === true,
      params,
    };
  }

  sanitizeAllowedRoot(inputPath) {
    const rawPath = typeof inputPath === "string" ? inputPath.trim() : String(inputPath ?? "").trim();
    if (!rawPath) {
      throw new Error("Allowed root folder must be a non-empty vault path.");
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(rawPath) || rawPath.startsWith("//")) {
      throw new Error("Allowed root folder must be a vault path, not a URL.");
    }
    if (rawPath.startsWith("/") || rawPath.startsWith("\\") || rawPath.includes("\\")) {
      throw new Error("Allowed root folder must be a relative vault path.");
    }

    const segments = rawPath.split("/").map((segment) => segment.trim());
    if (segments.some((segment) => segment === "..")) {
      throw new Error("Allowed root folder cannot contain parent directory segments.");
    }

    const normalized = normalizePath(rawPath);
    if (!normalized || normalized === "." || normalized === "/" || normalized.startsWith("../")) {
      throw new Error("Allowed root folder must resolve to a folder inside the vault.");
    }

    return normalized;
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

  async fetchDataUrl(args = {}) {
    const rawUrl = typeof args.url === "string" ? args.url.trim() : "";
    if (!/^https?:\/\//i.test(rawUrl)) {
      throw new Error("fetchDataUrl requires an http(s) URL.");
    }

    const maxBytes = Math.max(1, Math.min(Number(args.maxBytes) || 5 * 1024 * 1024, 10 * 1024 * 1024));
    const allowedMimePrefix = typeof args.allowedMimePrefix === "string" ? args.allowedMimePrefix : "";
    const response = await requestUrl({
      url: rawUrl,
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 Obsidian App Engine",
        "Accept": allowedMimePrefix === "image/" ? "image/*,*/*;q=0.8" : "*/*",
      },
    });

    const contentType = this.getHeaderValue(response.headers, "content-type").split(";")[0].trim().toLowerCase();
    if (allowedMimePrefix && !contentType.startsWith(allowedMimePrefix)) {
      throw new Error(`URL returned ${contentType || "unknown content type"}, not ${allowedMimePrefix}.`);
    }

    const bytes = Buffer.from(response.arrayBuffer);
    if (bytes.byteLength > maxBytes) {
      throw new Error(`Fetched file is too large (${bytes.byteLength} bytes).`);
    }

    return {
      url: rawUrl,
      contentType: contentType || "application/octet-stream",
      byteLength: bytes.byteLength,
      dataUrl: `data:${contentType || "application/octet-stream"};base64,${bytes.toString("base64")}`,
    };
  }

  getHeaderValue(headers, name) {
    const target = name.toLowerCase();
    for (const [key, value] of Object.entries(headers || {})) {
      if (key.toLowerCase() === target) {
        return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
      }
    }

    return "";
  }

  async handleMessageEvent(event) {
    const payload = event?.data;
    if (!this.isSupportedRequest(payload)) {
      return;
    }

    const frameContext = this.getEventFrameContext(event);
    if (!frameContext) {
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
        }, frameContext.targetOrigin);
      }
    };

    try {
      const result = await this.executeCommand(payload.command, payload.args ?? {}, frameContext.embedOptions);
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
      case "fetchDataUrl":
        return this.fetchDataUrl(args);
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

  getEventFrameContext(event) {
    if (!event?.source || !this.iframeContexts?.has(event.source)) {
      return null;
    }

    const frameContext = this.iframeContexts.get(event.source);
    if (!frameContext?.iframe?.isConnected || frameContext.iframe.contentWindow !== event.source) {
      return null;
    }
    if (event.origin !== frameContext.expectedOrigin) {
      return null;
    }

    return frameContext;
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

    let embedOptions;
    try {
      embedOptions = this.createEmbedOptions(config.params);
    } catch (error) {
      element.createEl("pre", { text: error?.message ?? "Invalid app-engine options." });
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

    const frameContext = {
      iframe,
      embedOptions,
      expectedOrigin: this.getOrigin(resolvedSrc),
      targetOrigin: this.getTargetOrigin(resolvedSrc),
    };
    iframe.addEventListener("load", () => {
      if (iframe.contentWindow) {
        this.iframeContexts.set(iframe.contentWindow, frameContext);
        iframe.contentWindow.postMessage({
          namespace: APP_NAMESPACE,
          type: `${APP_NAMESPACE}:context`,
          allowedRoot: embedOptions.allowedRoot,
          prettyPrintJson: embedOptions.prettyPrintJson,
          params: embedOptions.params,
        }, frameContext.targetOrigin);
      }
    });

    if (iframe.contentWindow) {
      this.iframeContexts.set(iframe.contentWindow, frameContext);
    }

    iframe.setAttribute("src", resolvedSrc);
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
      return null;
    }

    return this.resolveVaultResourcePath(trimmed, sourcePath);
  }

  getOrigin(src) {
    return new URL(src, window.location.href).origin;
  }

  getTargetOrigin(src) {
    const origin = this.getOrigin(src);
    return origin === "null" ? "*" : origin;
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
