import type { HttpMethod, Request } from "@gopeed/types"

export interface DownloadContext {
  url: string
  finalUrl?: string
  referrer?: string
  tabId?: number
  incognito?: boolean
  cookieStoreId?: string
}

interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  formData?: Record<string, string[]>
  bodyUnavailable?: boolean
  html?: boolean
}

interface RequestChain {
  tabId: number
  incognito?: boolean
  at: number
  requests: CapturedRequest[]
}

// Credentials stay in memory, on the exact request and its observed redirects.
const requestChains = new Map<string, RequestChain>()
const MAX_REQUESTS = 200
const MAX_AGE = 120000
const MAX_BODY = 512 * 1024

function pruneRequests() {
  for (const [id, chain] of requestChains) {
    if (Date.now() - chain.at > MAX_AGE) requestChains.delete(id)
  }
  while (requestChains.size > MAX_REQUESTS) {
    requestChains.delete(requestChains.keys().next().value!)
  }
}

type RequestDetails = Omit<
  chrome.webRequest.WebRequestBodyDetails,
  "requestBody"
> & {
  requestBody?: chrome.webRequest.WebRequestBodyDetails["requestBody"]
  incognito?: boolean
}

export function captureRequest(details: RequestDetails) {
  let chain = requestChains.get(details.requestId)
  if (!chain) {
    chain = {
      tabId: details.tabId,
      incognito: details.incognito,
      at: Date.now(),
      requests: []
    }
    requestChains.set(details.requestId, chain)
  }
  chain.at = Date.now()
  const request: CapturedRequest = {
    url: details.url,
    method: details.method,
    headers: {},
    ...(details.method !== "GET" && details.method !== "HEAD"
      ? { body: "" }
      : {})
  }
  const body = details.requestBody
  if (body) {
    if (body.error) {
      request.bodyUnavailable = true
    } else if (body.formData) {
      request.formData = body.formData
    } else if (body.raw) {
      const size = body.raw.reduce(
        (n, part) => n + (part.bytes?.byteLength || 0),
        0
      )
      if (
        size > MAX_BODY ||
        body.raw.some((part) => !part.bytes || part.file)
      ) {
        request.bodyUnavailable = true
      } else {
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const part of body.raw) {
          bytes.set(new Uint8Array(part.bytes!), offset)
          offset += part.bytes!.byteLength
        }
        try {
          request.body = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
        } catch {
          request.bodyUnavailable = true
        }
      }
    }
  }
  chain.requests.push(request)
  pruneRequests()
}

export function captureHeaders(
  details: chrome.webRequest.WebRequestHeadersDetails
) {
  if (!requestChains.has(details.requestId)) captureRequest(details)
  const chain = requestChains.get(details.requestId)!
  const request = chain.requests[chain.requests.length - 1]
  request.headers = Object.fromEntries(
    (details.requestHeaders || [])
      .filter((header) => header.name && header.value !== undefined)
      .map((header) => [header.name.toLowerCase(), header.value!])
  )
  chain.at = Date.now()
}

export function captureResponse(
  details: chrome.webRequest.WebResponseHeadersDetails
) {
  const chain = requestChains.get(details.requestId)
  const request = chain?.requests[chain.requests.length - 1]
  if (!request || !["main_frame", "sub_frame"].includes(details.type)) return
  request.html = (details.responseHeaders || []).some(
    (header) =>
      header.name.toLowerCase() === "content-type" &&
      /^(text\/html|application\/xhtml\+xml)\b/i.test(header.value || "")
  )
}

async function matchingChain(
  info: DownloadContext
): Promise<RequestChain | undefined> {
  pruneRequests()
  let matches = [...requestChains.values()]
    .reverse()
    .filter(
      (chain) =>
        (info.tabId === undefined || chain.tabId === info.tabId) &&
        chain.requests.some(
          (request) => request.url === info.url || request.url === info.finalUrl
        )
    )
  if (info.incognito !== undefined) {
    for (const chain of matches) {
      if (chain.incognito === undefined && chain.tabId >= 0) {
        try {
          chain.incognito = (await chrome.tabs.get(chain.tabId)).incognito
        } catch {
          /* The tab closed. */
        }
      }
    }
    matches = matches.filter((chain) => chain.incognito === info.incognito)
  }
  // A DownloadItem on Chromium has no tabId: don't borrow another tab's credentials.
  if (new Set(matches.map((chain) => chain.tabId)).size > 1) {
    throw new Error(
      "The download could not be associated with a single browser tab"
    )
  }
  return matches[0]
}

export async function createCapturedRequest(
  info: DownloadContext
): Promise<Request> {
  const chain = await matchingChain(info)
  let captured = chain?.requests[0]
  if (captured?.html) {
    captured = chain!.requests.find((request) => request.url === info.finalUrl)
  }
  const url =
    captured?.url || (chain?.requests[0].html && info.finalUrl) || info.url
  const parsed = new URL(url)
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only HTTP and HTTPS requests can be handed to Gopeed")
  }
  const headers = { ...captured?.headers }
  // The downloader supplies its own transport, range and payload length headers.
  for (const name of Object.keys(headers)) {
    if (
      /^(host|connection|keep-alive|proxy-.*|te|trailer|transfer-encoding|upgrade|content-length|accept-encoding|range|if-range|if-none-match|if-modified-since|cookie|sec-.*)$/i.test(
        name
      )
    ) {
      delete headers[name]
    }
  }
  const method = captured?.method || "GET"
  let body = captured?.body
  if (
    captured?.bodyUnavailable ||
    /multipart\/form-data/i.test(headers["content-type"] || "")
  ) {
    throw new Error("The browser request body cannot be replayed by Gopeed")
  }
  if (captured?.formData) {
    const form = new URLSearchParams()
    for (const [name, values] of Object.entries(captured.formData)) {
      for (const value of values) form.append(name, value)
    }
    body = form.toString()
    headers["content-type"] = "application/x-www-form-urlencoded"
  }
  if (body && new TextEncoder().encode(body).byteLength > MAX_BODY) {
    throw new Error("The browser request body is too large to hand to Gopeed")
  }
  if (method !== "GET" && method !== "HEAD" && body === undefined) {
    throw new Error("The browser request body was not captured")
  }
  let storeId = info.cookieStoreId
  const tabId = info.tabId ?? chain?.tabId
  if (!storeId && tabId !== undefined && tabId >= 0) {
    const stores = await chrome.cookies.getAllCookieStores()
    storeId = stores.find((store) => store.tabIds.includes(tabId))?.id
    if (!storeId)
      throw new Error("The download's browser cookie store was not found")
  }
  if (!storeId && info.incognito) {
    throw new Error(
      "The private download's cookie store could not be identified"
    )
  }
  const cookies = await chrome.cookies.getAll({
    url,
    ...(storeId ? { storeId } : {})
  })
  if (cookies.length)
    headers.cookie = cookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ")
  if (!headers["user-agent"]) headers["user-agent"] = navigator.userAgent
  if (!headers.referer && info.referrer) headers.referer = info.referrer
  headers["accept-encoding"] = "identity"
  return {
    url,
    extra: {
      method: method as HttpMethod,
      header: headers,
      ...(body !== undefined ? { body } : {})
    }
  }
}

// The native bridge decodes base64 as byte-sized characters, so keep JSON ASCII.
export function encodeNativeRequest(value: unknown): string {
  return btoa(
    JSON.stringify(value).replace(
      /[\u007f-\uffff]/g,
      (character) =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
    )
  )
}
