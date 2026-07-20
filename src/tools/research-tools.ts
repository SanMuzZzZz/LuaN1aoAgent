import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readability } from "@mozilla/readability";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { Type } from "typebox";

const DEFAULT_USER_AGENT = "LuaN1aoAgent/0.1 security-research";
const BROWSER_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";
const DEFAULT_FETCH_BYTES = 512 * 1024;
const DEFAULT_FETCH_CHARS = 12_000;
const MAX_FETCH_CHARS = 50_000;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 20_000;
const VULNERABILITY_SIGNAL_RE = /\bcve-\d{4}-\d{4,7}\b|\bexploits?\b|\bpoc\b|\bvulnerab\w*\b|\bsecurity advis(?:ory|ories)\b|\brce\b|\bauth(?:entication)? bypass\b|\bssrf\b|\bfile read\b/i;

export type ResearchFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ResearchToolDependencies = {
  fetch?: ResearchFetch;
  resolveHostname?: (hostname: string) => Promise<string[]>;
  env?: NodeJS.ProcessEnv;
};

type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
  source: string;
};

type SourceCoverage = {
  status: "ok" | "no_results" | "error" | "skipped";
  hits: number;
  backend?: string;
  error?: string;
};

type VulnerabilityRecord = {
  cveId: string;
  description: string;
  severity: string;
  cvssScore?: number;
  affectedVersions: string[];
  references: string[];
  published?: string;
  modified?: string;
  source: "NVD";
};

export function createWebFetchTool(dependencies: ResearchToolDependencies = {}) {
  return defineTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: [
      "Fetch a public HTTP(S) research reference and extract bounded readable content.",
      "Use this for advisories, documentation, writeups, and PoC pages; use bash for authorized target-side requests.",
      "Fetched public material is research intelligence, not proof that the target is vulnerable."
    ].join(" "),
    parameters: Type.Object({
      url: Type.String({ minLength: 8, maxLength: 2_048 }),
      maxChars: Type.Optional(Type.Integer({ minimum: 1_000, maximum: MAX_FETCH_CHARS }))
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params) => {
      const result = await fetchPublicReference(params.url, {
        ...dependencies,
        maxChars: params.maxChars
      });
      return toolJsonResult(result);
    }
  });
}

export function createWebSearchTool(dependencies: ResearchToolDependencies = {}) {
  return defineTool({
    name: "web_search",
    label: "Web Search",
    description: [
      "Search the public web for current documentation, advisories, writeups, and PoC references.",
      "Prefer vulnerability_search after identifying a product, framework, plugin, or version.",
      "Search hits are leads that require target-side validation."
    ].join(" "),
    parameters: Type.Object({
      query: Type.String({ minLength: 2, maxLength: 500 }),
      maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 }))
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params) => toolJsonResult(await searchPublicWeb(
      params.query,
      params.maxResults ?? 5,
      dependencies
    ))
  });
}

export function createVulnerabilitySearchTool(dependencies: ResearchToolDependencies = {}) {
  return defineTool({
    name: "vulnerability_search",
    label: "Vulnerability Search",
    description: [
      "Search layered public vulnerability intelligence for an identified product, framework, plugin, version, or CVE.",
      "Use this once a stable technology fingerprint exists and before spending substantial turns on unaided endpoint or payload enumeration.",
      "Returns source coverage, CVE records, public PoC/writeup leads, applicability hints, and weak-negative semantics.",
      "Results are hypotheses until the affected version and exploit preconditions are verified on the authorized target."
    ].join(" "),
    parameters: Type.Object({
      query: Type.String({ minLength: 2, maxLength: 500 }),
      maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 }))
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params) => toolJsonResult(await searchVulnerabilities(
      params.query,
      params.maxResults ?? 8,
      dependencies
    ))
  });
}

export async function fetchPublicReference(
  rawUrl: string,
  options: ResearchToolDependencies & { maxChars?: number; maxBytes?: number } = {}
): Promise<Record<string, unknown>> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const resolveHostname = options.resolveHostname ?? resolveHostnameAddresses;
  const maxChars = Math.min(options.maxChars ?? DEFAULT_FETCH_CHARS, MAX_FETCH_CHARS);
  const maxBytes = options.maxBytes ?? DEFAULT_FETCH_BYTES;
  let currentUrl = await validatePublicUrl(rawUrl, resolveHostname);
  let response: Response | undefined;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    response = await fetchImpl(currentUrl, {
      method: "GET",
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5"
      },
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!isRedirect(response.status)) {
      break;
    }
    const location = response.headers.get("location");
    if (!location) {
      throw new Error(`web_fetch received HTTP ${response.status} without a Location header`);
    }
    if (redirectCount === MAX_REDIRECTS) {
      throw new Error(`web_fetch exceeded ${MAX_REDIRECTS} redirects`);
    }
    currentUrl = await validatePublicUrl(new URL(location, currentUrl).toString(), resolveHostname);
  }

  if (!response) {
    throw new Error("web_fetch did not receive a response");
  }
  const body = await readBoundedBody(response, maxBytes);
  const contentType = response.headers.get("content-type") ?? "";
  const decoded = new TextDecoder(contentTypeCharset(contentType)).decode(body.bytes);
  const readable = contentType.includes("html")
    ? htmlToReadableMarkdown(decoded, currentUrl.toString())
    : { title: "", content: decoded };
  const content = readable.content.slice(0, maxChars);

  return {
    success: response.ok,
    requestedUrl: rawUrl,
    finalUrl: currentUrl.toString(),
    status: response.status,
    contentType,
    title: readable.title,
    content,
    truncated: body.truncated || readable.content.length > maxChars,
    byteLength: body.byteLength,
    sourceKind: "public_research_reference"
  };
}

export async function searchPublicWeb(
  query: string,
  maxResults: number,
  dependencies: ResearchToolDependencies = {}
): Promise<Record<string, unknown>> {
  const env = dependencies.env ?? process.env;
  const braveApiKey = env.BRAVE_SEARCH_API_KEY?.trim() || env.BRAVE_API_KEY?.trim();
  const errors: string[] = [];

  if (braveApiKey) {
    try {
      const results = await searchBrave(query, maxResults, braveApiKey, dependencies.fetch ?? globalThis.fetch);
      if (results.length > 0) {
        return { success: true, query, backend: "brave", results };
      }
      errors.push("Brave returned no results");
    } catch (error) {
      errors.push(`Brave: ${errorMessage(error)}`);
    }
  }

  try {
    const results = await searchDuckDuckGo(query, maxResults, dependencies.fetch ?? globalThis.fetch);
    if (results.length > 0) {
      return { success: true, query, backend: "duckduckgo_html", results };
    }
    errors.push("DuckDuckGo returned no results");
  } catch (error) {
    errors.push(`DuckDuckGo: ${errorMessage(error)}`);
  }

  try {
    const results = await searchBing(query, maxResults, dependencies.fetch ?? globalThis.fetch);
    if (results.length > 0) {
      return { success: true, query, backend: "bing_html", results };
    }
    errors.push("Bing returned no results");
  } catch (error) {
    errors.push(`Bing: ${errorMessage(error)}`);
  }

  return {
    success: false,
    query,
    backend: braveApiKey ? "brave+duckduckgo_html+bing_html" : "duckduckgo_html+bing_html",
    results: [],
    error: errors.join("; ") || "No public search backend returned results"
  };
}

export async function searchVulnerabilities(
  query: string,
  maxResults: number,
  dependencies: ResearchToolDependencies = {}
): Promise<Record<string, unknown>> {
  const normalizedQuery = query.trim();
  const cveId = normalizedQuery.match(/CVE-\d{4}-\d{4,7}/i)?.[0]?.toUpperCase();
  const nvd = await searchNvd(normalizedQuery, cveId, maxResults, dependencies);
  const followupQueries = buildVulnerabilityFollowupQueries(normalizedQuery, cveId);
  let webCoverage: SourceCoverage = { status: "skipped", hits: 0 };
  let publicReferences: WebSearchResult[] = [];

  for (const followupQuery of followupQueries.slice(0, 3)) {
    const search = await searchPublicWeb(followupQuery, Math.min(maxResults, 5), dependencies);
    if (search.success === true) {
      const candidates = (search.results as WebSearchResult[])
        .filter((item) => publicReferenceRelevance(normalizedQuery, cveId, item) > 0)
        .map((item) => ({ ...item, query: followupQuery }));
      publicReferences = dedupeReferences([...publicReferences, ...candidates]).slice(0, maxResults);
      webCoverage = {
        status: publicReferences.length > 0 ? "ok" : "no_results",
        hits: publicReferences.length,
        backend: String(search.backend ?? "")
      };
      if (publicReferences.length >= Math.min(maxResults, 3)) {
        break;
      }
    } else {
      webCoverage = {
        status: "error",
        hits: 0,
        backend: String(search.backend ?? ""),
        error: String(search.error ?? "web search failed")
      };
    }
  }

  const vulnerabilities = nvd.vulnerabilities;
  const resultClass = vulnerabilities.length > 0
    ? "direct_hit"
    : publicReferences.length > 0
      ? "family_hit"
      : nvd.coverage.status === "error" && webCoverage.status === "error"
        ? "source_failure"
        : "no_public_hit";
  const negativeSignalStrength = resultClass === "no_public_hit" ? "weak" : "none";

  return {
    success: resultClass !== "source_failure",
    query: normalizedQuery,
    resultClass,
    negativeSignalStrength,
    sourceCoverage: {
      nvd: nvd.coverage,
      webSearch: webCoverage
    },
    vulnerabilities,
    publicReferences,
    followupQueries,
    applicability: {
      product: extractProductPhrase(normalizedQuery),
      version: extractVersion(normalizedQuery),
      status: vulnerabilities.length > 0 || publicReferences.length > 0 ? "requires_target_validation" : "unknown"
    },
    evidenceSummary: vulnerabilityEvidenceSummary(normalizedQuery, resultClass, vulnerabilities, publicReferences),
    recommendedNextSteps: vulnerabilityNextSteps(resultClass, vulnerabilities, publicReferences)
  };
}

async function searchNvd(
  query: string,
  cveId: string | undefined,
  maxResults: number,
  dependencies: ResearchToolDependencies
): Promise<{ coverage: SourceCoverage; vulnerabilities: VulnerabilityRecord[] }> {
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const params = new URLSearchParams(cveId
    ? { cveId }
    : { keywordSearch: query, resultsPerPage: String(Math.min(maxResults, 20)) });
  const headers: Record<string, string> = {
    "User-Agent": DEFAULT_USER_AGENT,
    Accept: "application/json"
  };
  const nvdApiKey = (dependencies.env ?? process.env).NVD_API_KEY?.trim();
  if (nvdApiKey) {
    headers.apiKey = nvdApiKey;
  }
  try {
    const response = await fetchImpl(`https://services.nvd.nist.gov/rest/json/cves/2.0?${params}`, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) {
      return {
        coverage: { status: "error", hits: 0, error: `NVD returned HTTP ${response.status}` },
        vulnerabilities: []
      };
    }
    const payload = await response.json() as { vulnerabilities?: Array<{ cve?: Record<string, unknown> }> };
    const vulnerabilities = (payload.vulnerabilities ?? [])
      .slice(0, maxResults)
      .map((item) => normalizeNvdRecord(item.cve ?? {}));
    return {
      coverage: { status: vulnerabilities.length > 0 ? "ok" : "no_results", hits: vulnerabilities.length },
      vulnerabilities
    };
  } catch (error) {
    return {
      coverage: { status: "error", hits: 0, error: errorMessage(error) },
      vulnerabilities: []
    };
  }
}

async function searchBrave(
  query: string,
  maxResults: number,
  apiKey: string,
  fetchImpl: ResearchFetch
): Promise<WebSearchResult[]> {
  const params = new URLSearchParams({ q: query, count: String(Math.min(maxResults, 10)) });
  const response = await fetchImpl(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const payload = await response.json() as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  return (payload.web?.results ?? []).slice(0, maxResults).map((item) => ({
    title: item.title ?? "",
    url: item.url ?? "",
    snippet: item.description ?? "",
    source: "Brave Search"
  }));
}

async function searchDuckDuckGo(
  query: string,
  maxResults: number,
  fetchImpl: ResearchFetch
): Promise<WebSearchResult[]> {
  const response = await fetchImpl("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "User-Agent": BROWSER_USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html"
    },
    body: new URLSearchParams({ q: query }).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const html = await response.text();
  const document = new JSDOM(html, { url: "https://html.duckduckgo.com/html/" }).window.document;
  const results: WebSearchResult[] = [];
  for (const element of [...document.querySelectorAll(".result")]) {
    const anchor = element.querySelector<HTMLAnchorElement>(".result__a");
    if (!anchor?.href) {
      continue;
    }
    results.push({
      title: anchor.textContent?.trim() ?? "",
      url: normalizeDuckDuckGoUrl(anchor.href),
      snippet: element.querySelector(".result__snippet")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      source: "DuckDuckGo HTML"
    });
    if (results.length >= maxResults) {
      break;
    }
  }
  return results;
}

async function searchBing(
  query: string,
  maxResults: number,
  fetchImpl: ResearchFetch
): Promise<WebSearchResult[]> {
  const params = new URLSearchParams({ q: query, count: String(Math.min(maxResults, 10)) });
  const response = await fetchImpl(`https://www.bing.com/search?${params}`, {
    headers: {
      "User-Agent": BROWSER_USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9"
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const html = await response.text();
  const document = new JSDOM(html, { url: "https://www.bing.com/search" }).window.document;
  const results: WebSearchResult[] = [];
  for (const element of [...document.querySelectorAll("li.b_algo")]) {
    const anchor = element.querySelector<HTMLAnchorElement>("h2 a");
    if (!anchor?.href) {
      continue;
    }
    results.push({
      title: anchor.textContent?.trim() ?? "",
      url: anchor.href,
      snippet: element.querySelector("p")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      source: "Bing HTML"
    });
    if (results.length >= maxResults) {
      break;
    }
  }
  return results;
}

function htmlToReadableMarkdown(html: string, url: string): { title: string; content: string } {
  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document.cloneNode(true) as Document).parse();
  const document = dom.window.document;
  let title = article?.title?.trim() ?? document.title.trim();
  let contentHtml = article?.content ?? "";
  if (!contentHtml) {
    document.querySelectorAll("script, style, noscript, nav, header, footer, aside, form, svg").forEach((node) => node.remove());
    const main = document.querySelector("main, article, [role='main'], .content, #content") ?? document.body;
    contentHtml = main?.innerHTML ?? "";
  }
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  turndown.use(gfm);
  const content = turndown.turndown(contentHtml)
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!title) {
    title = new URL(url).hostname;
  }
  return { title, content };
}

async function validatePublicUrl(
  rawUrl: string,
  resolveHostname: (hostname: string) => Promise<string[]>
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("web_fetch requires a valid absolute URL");
  }
  if (!(["http:", "https:"] as string[]).includes(parsed.protocol)) {
    throw new Error("web_fetch supports only http and https URLs");
  }
  if (parsed.username || parsed.password) {
    throw new Error("web_fetch does not accept credentials in URLs");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("web_fetch accepts public research URLs only; use bash for authorized target requests");
  }
  const addresses = isIP(hostname) ? [hostname] : await resolveHostname(hostname);
  if (addresses.length === 0 || addresses.some((address) => !isPublicIpAddress(address))) {
    throw new Error("web_fetch resolved to a non-public address; use bash for authorized target requests");
  }
  return parsed;
}

async function resolveHostnameAddresses(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map((item) => item.address);
}

function isPublicIpAddress(address: string): boolean {
  if (address.includes(":")) {
    const normalized = address.toLowerCase();
    if (normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd")) {
      return false;
    }
    if (/^fe[89ab]/.test(normalized)) {
      return false;
    }
    const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    return mapped ? isPublicIpAddress(mapped) : true;
  }
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const [first, second] = octets;
  return !(
    first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 0 && octets[2] === 0)
    || (first === 192 && second === 0 && octets[2] === 2)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || (first === 198 && second === 51 && octets[2] === 100)
    || (first === 203 && second === 0 && octets[2] === 113)
    || first >= 224
  );
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<{
  bytes: Uint8Array;
  byteLength: number;
  truncated: boolean;
}> {
  if (!response.body) {
    return { bytes: new Uint8Array(), byteLength: 0, truncated: false };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const remaining = maxBytes - byteLength;
    if (value.byteLength > remaining) {
      chunks.push(value.subarray(0, Math.max(remaining, 0)));
      byteLength = maxBytes;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    byteLength += value.byteLength;
    if (byteLength >= maxBytes) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, byteLength, truncated };
}

function normalizeNvdRecord(cve: Record<string, unknown>): VulnerabilityRecord {
  const descriptions = Array.isArray(cve.descriptions) ? cve.descriptions as Array<Record<string, unknown>> : [];
  const description = String(descriptions.find((item) => item.lang === "en")?.value ?? descriptions[0]?.value ?? "");
  const metrics = cve.metrics as Record<string, unknown> | undefined;
  const metric = firstMetric(metrics);
  const references = Array.isArray(cve.references) ? cve.references as Array<Record<string, unknown>> : [];
  return {
    cveId: String(cve.id ?? "Unknown"),
    description: description.slice(0, 700),
    severity: String(metric?.baseSeverity ?? "UNKNOWN"),
    ...(typeof metric?.baseScore === "number" ? { cvssScore: metric.baseScore } : {}),
    affectedVersions: extractAffectedVersions(cve.configurations),
    references: references.map((item) => String(item.url ?? "")).filter(Boolean).slice(0, 8),
    ...(typeof cve.published === "string" ? { published: cve.published } : {}),
    ...(typeof cve.lastModified === "string" ? { modified: cve.lastModified } : {}),
    source: "NVD"
  };
}

function firstMetric(metrics: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metrics) {
    return undefined;
  }
  for (const key of ["cvssMetricV40", "cvssMetricV31", "cvssMetricV30", "cvssMetricV2"]) {
    const entries = metrics[key];
    if (Array.isArray(entries) && entries.length > 0) {
      const first = entries[0] as Record<string, unknown>;
      return first.cvssData as Record<string, unknown> | undefined;
    }
  }
  return undefined;
}

function extractAffectedVersions(rawConfigurations: unknown): string[] {
  const values: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    const item = value as Record<string, unknown>;
    for (const key of ["versionStartIncluding", "versionStartExcluding", "versionEndIncluding", "versionEndExcluding"]) {
      if (typeof item[key] === "string") {
        values.push(`${key}=${item[key]}`);
      }
    }
    Object.values(item).forEach(visit);
  };
  visit(rawConfigurations);
  return [...new Set(values)].slice(0, 8);
}

function buildVulnerabilityFollowupQueries(query: string, cveId: string | undefined): string[] {
  if (cveId) {
    return [`${cveId} exploit`, `${cveId} PoC GitHub`, `${cveId} writeup`];
  }
  return [
    `${query} vulnerability exploit`,
    `${query} PoC GitHub`,
    `${query} security advisory CVE`
  ];
}

function publicReferenceRelevance(query: string, cveId: string | undefined, item: WebSearchResult): number {
  const text = `${item.title} ${item.snippet} ${item.url}`.toLowerCase();
  if (cveId && text.includes(cveId.toLowerCase())) {
    return 10;
  }
  const tokens = significantQueryTokens(query);
  const matches = tokens.filter((token) => text.includes(token)).length;
  const exploitSignal = VULNERABILITY_SIGNAL_RE.test(text) ? 2 : 0;
  return matches > 0 && exploitSignal > 0 ? matches + exploitSignal : 0;
}

function significantQueryTokens(query: string): string[] {
  const stopwords = new Set(["the", "and", "for", "with", "version", "framework", "server", "application"]);
  return [...new Set(query.toLowerCase().match(/[a-z0-9][a-z0-9._-]{1,}/g) ?? [])]
    .filter((token) => !stopwords.has(token) && !/^v?\d+(?:\.\d+)*$/.test(token))
    .slice(0, 6);
}

function dedupeReferences<T extends WebSearchResult>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.url.toLowerCase();
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function vulnerabilityEvidenceSummary(
  query: string,
  resultClass: string,
  vulnerabilities: VulnerabilityRecord[],
  references: WebSearchResult[]
): string {
  if (vulnerabilities.length > 0) {
    return `Public vulnerability sources returned ${vulnerabilities.length} CVE record(s) for "${query}". These records require target version and precondition validation.`;
  }
  if (references.length > 0) {
    return `Public web research returned ${references.length} potentially relevant reference(s) for "${query}" without a structured CVE match. Treat them as family-level leads.`;
  }
  if (resultClass === "source_failure") {
    return `Vulnerability research for "${query}" was inconclusive because every configured source failed.`;
  }
  return `No public vulnerability hit was found for "${query}" in the queried sources. This is weak negative evidence only.`;
}

function vulnerabilityNextSteps(
  resultClass: string,
  vulnerabilities: VulnerabilityRecord[],
  references: WebSearchResult[]
): string[] {
  if (vulnerabilities.length > 0 || references.length > 0) {
    return [
      "Verify the target product and exact version against affected-version constraints.",
      "Use web_fetch on the most relevant advisory or PoC reference to extract entrypoints and prerequisites.",
      "Validate only applicable preconditions on the authorized target before treating a lead as a vulnerability."
    ];
  }
  return resultClass === "source_failure"
    ? ["Retry the failed source or use web_search with the generated follow-up queries; do not treat source failure as a negative finding."]
    : ["Continue evidence-driven target analysis; absence from queried public sources does not exclude a vulnerability."];
}

function extractVersion(query: string): string | undefined {
  return query.match(/\bv?\d+(?:\.\d+){1,3}(?:[-+._][a-z0-9.-]+)?\b/i)?.[0]?.replace(/^v/i, "");
}

function extractProductPhrase(query: string): string {
  const withoutCve = query.replace(/CVE-\d{4}-\d{4,7}/ig, " ");
  const version = extractVersion(withoutCve);
  return withoutCve.replace(version ?? "", " ").replace(/\s+/g, " ").trim();
}

function normalizeDuckDuckGoUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl, "https://html.duckduckgo.com");
  return parsed.searchParams.get("uddg") ?? parsed.toString();
}

function contentTypeCharset(contentType: string): string {
  const charset = contentType.match(/charset=([^;\s]+)/i)?.[1]?.replace(/["']/g, "");
  return charset && ["utf-8", "utf8", "us-ascii"].includes(charset.toLowerCase()) ? charset : "utf-8";
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function toolJsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
