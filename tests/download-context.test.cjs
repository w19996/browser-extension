const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const vm = require("node:vm")
const ts = require("typescript")

function event() {
  const listeners = new Set()
  return {
    addListener(fn, ...options) {
      listeners.add(fn)
      this.options = options
    },
    removeListener(fn) {
      listeners.delete(fn)
    },
    fire(...args) {
      return [...listeners].map((fn) => fn(...args))
    }
  }
}

function load(file, globals, imports = {}) {
  const module = { exports: {} }
  const source = ts.transpileModule(
    fs.readFileSync(path.join(__dirname, "..", file), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true
      }
    }
  ).outputText
  vm.runInNewContext(
    source,
    {
      module,
      exports: module.exports,
      require(name) {
        if (name in imports) return imports[name]
        throw new Error(`Unexpected import: ${name}`)
      },
      URL,
      URLSearchParams,
      Uint8Array,
      TextEncoder,
      TextDecoder,
      btoa,
      setTimeout,
      clearTimeout,
      ...globals
    },
    { filename: file }
  )
  return module.exports
}

function fixture() {
  const queries = []
  const stores = [
    { id: "normal", tabIds: [7, 8] },
    { id: "private", tabIds: [9] }
  ]
  const cookies = [{ name: "session", value: "fresh" }]
  let now = Date.now()
  const chrome = {
    cookies: {
      async getAll(query) {
        queries.push(query)
        return cookies
      },
      async getAllCookieStores() {
        return stores
      }
    },
    tabs: {
      async get(id) {
        return { id, incognito: id === 9 }
      }
    }
  }
  const api = load("background/download-context.ts", {
    chrome,
    navigator: { userAgent: "Browser UA" },
    Date: { now: () => now }
  })
  const request = (changes = {}) => ({
    requestId: "r1",
    url: "https://files.example.test/download",
    method: "GET",
    tabId: 7,
    type: "main_frame",
    ...changes
  })
  return {
    api,
    chrome,
    cookies,
    queries,
    request,
    advance(ms) {
      now += ms
    }
  }
}

test("reads current URL-scoped cookies even when no webRequest was observed", async () => {
  const f = fixture()
  const result = await f.api.createCapturedRequest({ url: f.request().url })
  assert.equal(result.extra.header.cookie, "session=fresh")
  assert.equal(result.extra.header["user-agent"], "Browser UA")
  assert.equal(result.extra.header["accept-encoding"], "identity")
  assert.deepEqual(JSON.parse(JSON.stringify(f.queries)), [
    { url: f.request().url }
  ])
})

test("keeps exact-request authentication and removes browser transport/cache headers", async () => {
  const f = fixture()
  f.api.captureRequest(f.request({ type: "xmlhttprequest" }))
  f.api.captureHeaders(
    f.request({
      requestHeaders: [
        { name: "Authorization", value: "Bearer exact" },
        { name: "Cookie", value: "session=stale" },
        { name: "Range", value: "bytes=0-3" },
        { name: "If-None-Match", value: "old" },
        { name: "Host", value: "wrong.test" },
        { name: "Content-Length", value: "12" },
        { name: "Sec-Fetch-Site", value: "same-origin" },
        { name: "X-File-Token", value: "file-only" }
      ]
    })
  )
  const { extra } = await f.api.createCapturedRequest({
    url: f.request().url,
    tabId: 7
  })
  assert.equal(extra.header.authorization, "Bearer exact")
  assert.equal(extra.header["x-file-token"], "file-only")
  assert.equal(extra.header.cookie, "session=fresh")
  for (const name of [
    "range",
    "if-none-match",
    "host",
    "content-length",
    "sec-fetch-site"
  ]) {
    assert.equal(extra.header[name], undefined)
  }
})

test("never borrows authentication from another path or query on the same origin", async () => {
  const f = fixture()
  f.api.captureHeaders(
    f.request({
      requestHeaders: [{ name: "Authorization", value: "Bearer secret" }]
    })
  )
  for (const url of [
    "https://files.example.test/another",
    f.request().url + "?other=1",
    "https://elsewhere.test/download"
  ]) {
    const result = await f.api.createCapturedRequest({ url })
    assert.equal(result.extra.header.authorization, undefined)
  }
})

test("retains redirect entry and its headers, rather than CDN credentials", async () => {
  const f = fixture()
  const entry = f.request().url
  const finalUrl = "https://cdn.test/signed?token=example"
  f.api.captureHeaders(
    f.request({
      requestHeaders: [{ name: "Authorization", value: "Bearer entry" }]
    })
  )
  f.api.captureRequest(f.request({ url: finalUrl }))
  f.api.captureHeaders(
    f.request({
      url: finalUrl,
      requestHeaders: [{ name: "X-CDN", value: "cdn-only" }]
    })
  )
  const result = await f.api.createCapturedRequest({ url: finalUrl, tabId: 7 })
  assert.equal(result.url, entry)
  assert.equal(result.extra.header.authorization, "Bearer entry")
  assert.equal(result.extra.header["x-cdn"], undefined)
  assert.equal(f.queries[0].url, entry)
})

test("does not save an HTML landing page under the download's filename", async () => {
  const f = fixture()
  f.api.captureHeaders(
    f.request({
      requestHeaders: [{ name: "Authorization", value: "Bearer page" }]
    })
  )
  f.api.captureResponse(
    f.request({
      responseHeaders: [
        { name: "Content-Type", value: "text/html; charset=utf-8" }
      ]
    })
  )
  const finalUrl = "https://cdn.test/file.zip"
  const result = await f.api.createCapturedRequest({
    url: f.request().url,
    finalUrl,
    tabId: 7
  })
  assert.equal(result.url, finalUrl)
  assert.equal(result.extra.header.authorization, undefined)
})

test("repeat downloads reread cookies and retain the exact request's auth", async () => {
  const f = fixture()
  f.api.captureHeaders(
    f.request({
      requestHeaders: [{ name: "Authorization", value: "Bearer same" }]
    })
  )
  await f.api.createCapturedRequest({ url: f.request().url, tabId: 7 })
  f.cookies[0].value = "renewed"
  const result = await f.api.createCapturedRequest({
    url: f.request().url,
    tabId: 7
  })
  assert.equal(result.extra.header.cookie, "session=renewed")
  assert.equal(result.extra.header.authorization, "Bearer same")
  assert.equal(f.queries.length, 2)
})

test("replays UTF-8 POST bodies and repeated form fields", async () => {
  for (const kind of ["raw", "form"]) {
    const f = fixture()
    const expected =
      kind === "raw"
        ? '{"name":"测试文件"}'
        : "item=a&item=b&name=%E6%B5%8B%E8%AF%95"
    const requestBody =
      kind === "raw"
        ? { raw: [{ bytes: new TextEncoder().encode(expected).buffer }] }
        : { formData: { item: ["a", "b"], name: ["测试"] } }
    f.api.captureRequest(f.request({ method: "POST", requestBody }))
    f.api.captureHeaders(
      f.request({
        method: "POST",
        requestHeaders: [
          {
            name: "Content-Type",
            value:
              kind === "raw"
                ? "application/json"
                : "application/x-www-form-urlencoded"
          }
        ]
      })
    )
    const result = await f.api.createCapturedRequest({
      url: f.request().url,
      tabId: 7
    })
    assert.equal(result.extra.method, "POST")
    assert.equal(result.extra.body, expected)
  }
})

test("fails explicitly on missing, binary, multipart and oversized request bodies", async () => {
  for (const requestBody of [
    { error: "unavailable" },
    { raw: [{ file: "not-readable" }] },
    { raw: [{ bytes: new Uint8Array([255]).buffer }] },
    { raw: [{ bytes: new Uint8Array(512 * 1024 + 1).buffer }] }
  ]) {
    const f = fixture()
    f.api.captureRequest(f.request({ method: "POST", requestBody }))
    await assert.rejects(
      f.api.createCapturedRequest({ url: f.request().url, tabId: 7 }),
      /cannot be replayed/
    )
  }
  const f = fixture()
  f.api.captureHeaders(
    f.request({
      method: "POST",
      requestHeaders: [
        { name: "Content-Type", value: "multipart/form-data; boundary=test" }
      ]
    })
  )
  await assert.rejects(
    f.api.createCapturedRequest({ url: f.request().url, tabId: 7 }),
    /cannot be replayed/
  )
})

test("selects the download tab's private cookie store and authentication", async () => {
  const f = fixture()
  f.api.captureHeaders(
    f.request({
      requestId: "normal",
      tabId: 7,
      requestHeaders: [{ name: "Authorization", value: "normal" }]
    })
  )
  f.api.captureHeaders(
    f.request({
      requestId: "private",
      tabId: 9,
      requestHeaders: [{ name: "Authorization", value: "private" }]
    })
  )
  const result = await f.api.createCapturedRequest({
    url: f.request().url,
    incognito: true
  })
  assert.equal(result.extra.header.authorization, "private")
  assert.equal(f.queries[0].storeId, "private")
  await assert.rejects(
    f.api.createCapturedRequest({
      url: "https://unseen.test/file",
      incognito: true
    }),
    /private download/
  )
})

test("rejects ambiguous tabs instead of mixing their credentials", async () => {
  const f = fixture()
  f.api.captureRequest(f.request({ requestId: "one", tabId: 7 }))
  f.api.captureRequest(f.request({ requestId: "two", tabId: 8 }))
  await assert.rejects(
    f.api.createCapturedRequest({ url: f.request().url }),
    /single browser tab/
  )
})

test("expires cached authentication, bounds cache size and never hides cookie API failures", async () => {
  const f = fixture()
  f.api.captureHeaders(
    f.request({ requestHeaders: [{ name: "Authorization", value: "expired" }] })
  )
  f.advance(120001)
  assert.equal(
    (await f.api.createCapturedRequest({ url: f.request().url })).extra.header
      .authorization,
    undefined
  )
  for (let i = 0; i <= 200; i++) {
    f.api.captureHeaders(
      f.request({
        requestId: String(i),
        url: `https://files.test/${i}`,
        requestHeaders: [{ name: "Authorization", value: "old" }]
      })
    )
  }
  assert.equal(
    (await f.api.createCapturedRequest({ url: "https://files.test/0" })).extra
      .header.authorization,
    undefined
  )
  f.chrome.cookies.getAll = async () => {
    throw new Error("Cookie permission denied")
  }
  await assert.rejects(
    f.api.createCapturedRequest({ url: "https://files.test/new" }),
    /permission denied/
  )
})

test("native payload round-trips Chinese text, emoji and control characters", () => {
  const f = fixture()
  const payload = {
    req: { url: "https://example.test/测试", extra: { body: "中文😀\n\u0000" } }
  }
  const encoded = f.api.encodeNativeRequest(payload)
  const bridgeText = Buffer.from(encoded, "base64").toString("latin1")
  assert.deepEqual(JSON.parse(bridgeText), payload)
  assert.ok([...bridgeText].every((character) => character.charCodeAt(0) < 128))
})

function extension({ fail = false, firefox = false } = {}) {
  const f = fixture()
  const calls = []
  const port = {
    onMessage: event(),
    onDisconnect: event(),
    disconnect() {
      this.onDisconnect.fire()
    },
    postMessage(message) {
      calls.push(["native", message])
      setImmediate(() =>
        this.onMessage.fire(
          message.method === "ping"
            ? { code: 0, data: true }
            : fail
            ? { code: 1, message: "rejected" }
            : { code: 0 }
        )
      )
    }
  }
  const chrome = f.chrome
  chrome.runtime = {
    connectNative: () => port,
    onStartup: event(),
    getURL: (file) => `extension://test/${file}`
  }
  chrome.contextMenus = { create() {}, update() {}, onClicked: event() }
  chrome.notifications = {
    async create() {
      calls.push(["notification"])
    },
    clear() {}
  }
  chrome.downloads = {
    onDeterminingFilename: firefox ? undefined : event(),
    onCreated: event(),
    async pause() {
      calls.push(["pause"])
    },
    async cancel() {
      calls.push(["cancel"])
    },
    async erase() {
      calls.push(["erase"])
    },
    async resume() {
      calls.push(["resume"])
    }
  }
  chrome.webRequest = {
    onBeforeRequest: event(),
    onBeforeSendHeaders: event(),
    onResponseStarted: event(),
    onHeadersReceived: event()
  }
  const settings = {
    enabled: true,
    autoWakeup: true,
    confirmBeforeDownload: false,
    notifyOnNativeSuccess: false,
    language: "en",
    remote: { enabled: false },
    ctrlDisableCapture: false,
    excludeDomains: { enabled: false },
    excludeFileTypes: { enabled: false },
    minFileSize: { enabled: false }
  }
  load(
    "background/index.ts",
    {
      chrome,
      process: { env: { PLASMO_BROWSER: firefox ? "firefox" : "chrome" } },
      console: { log() {}, warn() {}, error() {} },
      setInterval() {},
      setTimeout(fn, delay) {
        const timer = setTimeout(fn, delay)
        timer.unref()
        return timer
      }
    },
    {
      path: require("node:path"),
      "@gopeed/rest": class {},
      "content-disposition": {},
      "@plasmohq/storage": {
        Storage: class {
          async get() {
            return settings
          }
          watch() {}
        }
      },
      "./download-context": f.api,
      "~background/messages/api/select-server": {},
      "~background/messages/api/skip": { skip: false },
      "~constants": { STORAGE_SETTINGS: "settings" },
      "~i18n": { getMessage: (key) => key },
      "~options/components/RemoteSettings": {},
      "~options/types": { defaultSettings: settings },
      "~util/settings": { getMergedSettings: () => settings }
    }
  )
  return { ...f, chrome, calls }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

test("Chrome hands off original URL with cookies before cancelling; no browser fallback", async () => {
  const f = extension()
  await settle()
  let suggested = false
  const [held] = f.chrome.downloads.onDeterminingFilename.fire(
    {
      id: 1,
      url: f.request().url,
      finalUrl: "https://cdn.test/signed",
      filename: "file.docx",
      fileSize: 10,
      incognito: false
    },
    () => {
      suggested = true
    }
  )
  assert.equal(held, true)
  await settle()
  const sent = f.calls.find(
    ([kind, message]) => kind === "native" && message.method === "create"
  )
  const req = JSON.parse(
    Buffer.from(sent[1].params, "base64").toString("latin1")
  ).req
  assert.equal(req.url, f.request().url)
  assert.equal(req.extra.header.cookie, "session=fresh")
  assert.ok(
    f.calls.indexOf(sent) < f.calls.findIndex(([kind]) => kind === "cancel")
  )
  assert.equal(suggested, false)
  assert.ok(!f.calls.some(([kind]) => kind === "resume"))
  assert.ok(
    f.chrome.webRequest.onBeforeSendHeaders.options[0].types.includes(
      "xmlhttprequest"
    )
  )
})

test("host rejection cancels the captured task and reports failure without resuming", async () => {
  const f = extension({ fail: true })
  await settle()
  let suggested = false
  f.chrome.downloads.onDeterminingFilename.fire(
    { id: 2, url: f.request().url, filename: "file.docx", incognito: false },
    () => {
      suggested = true
    }
  )
  await settle()
  assert.ok(f.calls.some(([kind]) => kind === "cancel"))
  assert.ok(f.calls.some(([kind]) => kind === "notification"))
  assert.ok(!f.calls.some(([kind]) => kind === "resume"))
  assert.equal(suggested, false)
})

test("cookie permission failure does not create an incomplete task or resume browser download", async () => {
  const f = extension()
  await settle()
  f.chrome.cookies.getAll = async () => {
    throw new Error("permission denied")
  }
  f.chrome.downloads.onDeterminingFilename.fire(
    { id: 3, url: f.request().url, filename: "file.docx", incognito: false },
    () => assert.fail("must not resume browser download")
  )
  await settle()
  assert.ok(
    !f.calls.some(
      ([kind, message]) => kind === "native" && message.method === "create"
    )
  )
  assert.ok(f.calls.some(([kind]) => kind === "cancel"))
  assert.ok(f.calls.some(([kind]) => kind === "notification"))
})

test("Firefox onCreated pauses, hands off, then cancels and erases", async () => {
  const f = extension({ firefox: true })
  await settle()
  f.chrome.downloads.onCreated.fire({
    id: 4,
    url: f.request().url,
    filename: "file.docx"
  })
  await settle()
  assert.deepEqual(
    f.calls
      .filter(([kind]) => ["pause", "cancel", "erase", "resume"].includes(kind))
      .map(([kind]) => kind),
    ["pause", "cancel", "erase"]
  )
})
