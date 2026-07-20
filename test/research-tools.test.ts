import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchPublicReference,
  searchPublicWeb,
  searchVulnerabilities
} from "../src/tools/research-tools.js";

test("web fetch extracts bounded readable content from a public page", async () => {
  const result = await fetchPublicReference("https://example.test/advisory", {
    resolveHostname: async () => ["93.184.216.34"],
    fetch: async () => new Response(`
      <html>
        <head><title>Security Advisory</title><style>.hidden { display: none }</style></head>
        <body>
          <nav>Navigation noise</nav>
          <main><h1>Dify advisory</h1><p>Affected versions before 1.2.3 require authentication.</p></main>
          <script>secretNoise()</script>
        </body>
      </html>
    `, { headers: { "content-type": "text/html; charset=utf-8" } })
  });

  assert.equal(result.success, true);
  assert.equal(result.title, "Security Advisory");
  assert.match(String(result.content), /Affected versions before 1\.2\.3/);
  assert.doesNotMatch(String(result.content), /Navigation noise|secretNoise/);
  assert.equal(result.sourceKind, "public_research_reference");
});

test("web fetch rejects private destinations and private redirects", async () => {
  await assert.rejects(
    fetchPublicReference("http://127.0.0.1/admin"),
    /public research URLs only|non-public address/
  );

  await assert.rejects(
    fetchPublicReference("http://[::1]/admin"),
    /non-public address/
  );

  await assert.rejects(
    fetchPublicReference("https://public.test/start", {
      resolveHostname: async () => ["93.184.216.34"],
      fetch: async () => new Response(null, {
        status: 302,
        headers: { location: "http://10.0.0.8/internal" }
      })
    }),
    /non-public address/
  );
});

test("web search uses Brave when a configured API key is available", async () => {
  const result = await searchPublicWeb("Dify vulnerability", 3, {
    env: { BRAVE_SEARCH_API_KEY: "test-key" },
    fetch: async (input) => {
      assert.match(String(input), /api\.search\.brave\.com/);
      return Response.json({
        web: {
          results: [{
            title: "Dify Security Advisory",
            url: "https://example.test/dify-advisory",
            description: "Affected versions and remediation"
          }]
        }
      });
    }
  });

  assert.equal(result.success, true);
  assert.equal(result.backend, "brave");
  assert.equal((result.results as unknown[]).length, 1);
});

test("web search falls back to Bing when DuckDuckGo is unavailable", async () => {
  const result = await searchPublicWeb("Dify vulnerability", 3, {
    env: {},
    fetch: async (input) => {
      const url = String(input);
      if (url === "https://html.duckduckgo.com/html/") {
        return new Response("blocked", { status: 503 });
      }
      if (url.startsWith("https://www.bing.com/search?")) {
        return new Response(`
          <ol><li class="b_algo">
            <h2><a href="https://example.test/dify-cve">Dify vulnerability advisory</a></h2>
            <p>Affected versions and exploit prerequisites.</p>
          </li></ol>
        `);
      }
      throw new Error(`Unexpected URL: ${url}`);
    }
  });

  assert.equal(result.success, true);
  assert.equal(result.backend, "bing_html");
  assert.equal((result.results as Array<Record<string, unknown>>)[0]?.url, "https://example.test/dify-cve");
});

test("vulnerability search combines NVD records and public research leads", async () => {
  const fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.startsWith("https://services.nvd.nist.gov/")) {
      return Response.json({
        vulnerabilities: [{
          cve: {
            id: "CVE-2025-12345",
            descriptions: [{ lang: "en", value: "Dify request validation issue" }],
            metrics: {
              cvssMetricV31: [{ cvssData: { baseSeverity: "HIGH", baseScore: 8.1 } }]
            },
            configurations: [{
              nodes: [{ cpeMatch: [{ vulnerable: true, versionEndExcluding: "1.2.3" }] }]
            }],
            references: [{ url: "https://vendor.test/advisory" }],
            published: "2025-01-02T00:00:00.000",
            lastModified: "2025-01-03T00:00:00.000"
          }
        }]
      });
    }
    if (url === "https://html.duckduckgo.com/html/") {
      return new Response(`
        <div class="result">
          <a class="result__a" href="https://github.com/example/dify-poc">Dify CVE-2025-12345 PoC</a>
          <a class="result__snippet">Exploit prerequisites for affected Dify versions</a>
        </div>
      `);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await searchVulnerabilities("Dify 1.2.0", 5, { fetch, env: {} });
  const vulnerabilities = result.vulnerabilities as Array<Record<string, unknown>>;

  assert.equal(result.resultClass, "direct_hit");
  assert.equal(result.negativeSignalStrength, "none");
  assert.equal(vulnerabilities[0]?.cveId, "CVE-2025-12345");
  assert.deepEqual(vulnerabilities[0]?.affectedVersions, ["versionEndExcluding=1.2.3"]);
  assert.equal((result.publicReferences as unknown[]).length, 1);
  assert.deepEqual(result.applicability, {
    product: "Dify",
    version: "1.2.0",
    status: "requires_target_validation"
  });
  assert.match(String(result.evidenceSummary), /require target version and precondition validation/);
});

test("vulnerability search ignores public pages without vulnerability signal", async () => {
  const fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.startsWith("https://services.nvd.nist.gov/")) {
      return Response.json({ vulnerabilities: [] });
    }
    if (url === "https://html.duckduckgo.com/html/") {
      return new Response(`
        <div class="result">
          <a class="result__a" href="https://dify.ai/">Dify official website</a>
          <a class="result__snippet">Dify is an open-source LLM app development platform.</a>
        </div>
      `);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await searchVulnerabilities("Dify", 3, { fetch, env: {} });
  const coverage = result.sourceCoverage as { webSearch: { status: string } };

  assert.equal(result.resultClass, "no_public_hit");
  assert.equal((result.publicReferences as unknown[]).length, 0);
  assert.equal(coverage.webSearch.status, "no_results");
});

test("vulnerability search treats empty public coverage as weak negative evidence", async () => {
  const fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.startsWith("https://services.nvd.nist.gov/")) {
      return Response.json({ vulnerabilities: [] });
    }
    if (url === "https://html.duckduckgo.com/html/") {
      return new Response("<html><body>No results</body></html>");
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await searchVulnerabilities("UnknownCMS 9.9", 3, { fetch, env: {} });

  assert.equal(result.resultClass, "no_public_hit");
  assert.equal(result.negativeSignalStrength, "weak");
  assert.match(String(result.evidenceSummary), /weak negative evidence only/);
});
