import type { PolicyReport, RedFlag } from "./shared";

export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Policies longer than this are truncated (the report says so). */
export const MAX_POLICY_CHARS = 90_000;
export const CHUNK_CHARS = 6_000;
export const MAX_CHUNKS = 15;
/** Reuse a cached analysis for this long before re-reading the page. */
export const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/**
 * Validates a user-supplied URL, normalizes it so the same policy always maps
 * to the same cache key, and derives a short stable id from it.
 */
export async function normalizePolicyUrl(
  raw: string,
): Promise<{ id: string; url: string }> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`"${raw}" is not a valid URL. Include https://`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only http and https links can be analyzed.");
  }
  if (isPrivateHost(url.hostname)) {
    throw new Error("That address points to a private network.");
  }

  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith("utm_")) url.searchParams.delete(key);
  }
  let normalized = url.toString();
  if (normalized.endsWith("/") && url.pathname !== "/") {
    normalized = normalized.slice(0, -1);
  }

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalized),
  );
  const id = [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return { id, url: normalized };
}

/** Accepts either a report id or a policy URL and returns the report id. */
export async function resolvePolicyRef(ref: string): Promise<string> {
  const trimmed = ref.trim();
  return /^https?:\/\//i.test(trimmed)
    ? (await normalizePolicyUrl(trimmed)).id
    : trimmed;
}

function isPrivateHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.startsWith("[") || // IPv6 literals
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

// ---------------------------------------------------------------------------
// Text extraction and chunking
// ---------------------------------------------------------------------------

/** Good-enough HTML to text for server-rendered policy pages. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template|nav)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|ul|ol|table)>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&(#39|apos|rsquo|lsquo);/gi, "'")
    .replace(/&(ldquo|rdquo);/gi, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Splits on paragraph boundaries so clauses are not cut mid-sentence. */
export function chunkText(
  text: string,
  size = CHUNK_CHARS,
  max = MAX_CHUNKS,
): { chunks: string[]; truncated: boolean } {
  const chunks: string[] = [];
  let current = "";
  for (const para of text.split(/\n{2,}/)) {
    if (para.length > size) {
      if (current) chunks.push(current);
      current = "";
      for (let i = 0; i < para.length; i += size) {
        chunks.push(para.slice(i, i + size));
      }
      continue;
    }
    if (current && current.length + para.length + 2 > size) {
      chunks.push(current);
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current) chunks.push(current);
  return { chunks: chunks.slice(0, max), truncated: chunks.length > max };
}

// ---------------------------------------------------------------------------
// LLM calls
// ---------------------------------------------------------------------------

export interface ChunkFindings {
  company: string;
  dataCollected: string[];
  sharedWith: string[];
  retention: string[];
  userRights: string[];
  redFlags: { issue: string; quote: string }[];
}

const stringList = { type: "array", items: { type: "string" } };
const redFlagList = {
  type: "array",
  items: {
    type: "object",
    properties: { issue: { type: "string" }, quote: { type: "string" } },
    required: ["issue", "quote"],
  },
};

const FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    company: { type: "string" },
    dataCollected: stringList,
    sharedWith: stringList,
    retention: stringList,
    userRights: stringList,
    redFlags: redFlagList,
  },
  required: [
    "company",
    "dataCollected",
    "sharedWith",
    "retention",
    "userRights",
    "redFlags",
  ],
};

const REPORT_SCHEMA = {
  type: "object",
  properties: {
    company: { type: "string" },
    summary: { type: "string" },
    riskScore: { type: "integer" },
    riskRationale: { type: "string" },
    dataCollected: stringList,
    sharedWith: stringList,
    retention: stringList,
    userRights: stringList,
    redFlags: redFlagList,
  },
  required: [
    "company",
    "summary",
    "riskScore",
    "riskRationale",
    "dataCollected",
    "sharedWith",
    "retention",
    "userRights",
    "redFlags",
  ],
};

export const EXTRACT_PROMPT = `You are a privacy analyst reading one section of a website's privacy policy.
Extract only what this section actually says. Do not use outside knowledge about the company.

Fill these fields:
- company: the company or service name if this section names it, otherwise an empty string.
- dataCollected: kinds of personal data collected (for example "precise location", "contacts list").
- sharedWith: who data is shared with or sold to, and why.
- retention: how long data is kept.
- userRights: rights the user has (access, deletion, opt-out) and how to use them.
- redFlags: practices a privacy-conscious person would worry about, such as selling data, sharing for advertising, indefinite retention, broad rights to change the policy without notice, or collecting sensitive data. For each, give a short plain-language issue and a quote copied word for word from the section, under 30 words.

Use empty arrays when the section says nothing about a field. Keep each item under 20 words.`;

export const SYNTHESIZE_PROMPT = `You combine findings extracted from every section of one privacy policy into a single report for a person who is not a lawyer.

Rules:
- Merge duplicates and keep the most specific wording.
- Keep quotes exactly as given. Never write new quotes.
- summary: three or four plain sentences on what the company collects, who it shares with, and what control the user has.
- riskScore: an integer from 1 to 10. 1 means minimal collection, no selling or advertising use, short retention, and clear deletion rights. 10 means broad collection including sensitive data, selling or advertising use, indefinite retention, and weak or hard-to-use rights.
- riskRationale: one or two sentences explaining the score.
- redFlags: the most important concerns first, at most 8.
- Each list has at most 12 items.`;

/**
 * Calls Llama 3.3 in JSON mode and parses the result. Throws when the model
 * returns something unusable so that the enclosing Workflow step retries.
 */
export async function runJson<T>(
  ai: Ai,
  system: string,
  user: string,
  schema: object,
  maxTokens = 2048,
): Promise<T> {
  // run() is overloaded per model; the cast keeps this helper model-agnostic.
  const result = (await (ai as unknown as {
    run: (model: string, input: unknown) => Promise<{ response?: unknown }>;
  }).run(MODEL, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_schema", json_schema: schema },
    max_tokens: maxTokens,
    temperature: 0.1,
  })) as { response?: unknown };
  return parseJson<T>(result.response);
}

export function parseJson<T>(value: unknown): T {
  if (value && typeof value === "object") return value as T;
  if (typeof value !== "string") throw new Error("The model returned no content");
  const cleaned = value.replace(/```(?:json)?/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("The model did not return JSON");
  return JSON.parse(cleaned.slice(start, end + 1)) as T;
}

const strings = (value: unknown, limit: number): string[] =>
  Array.isArray(value)
    ? value
        .filter((v): v is string => typeof v === "string" && v.trim() !== "")
        .map((v) => v.trim())
        .slice(0, limit)
    : [];

const flags = (value: unknown, limit: number) =>
  Array.isArray(value)
    ? value
        .filter(
          (v): v is { issue: string; quote: string } =>
            !!v && typeof v.issue === "string" && typeof v.quote === "string",
        )
        .slice(0, limit)
    : [];

export async function extractFindings(
  ai: Ai,
  section: string,
  index: number,
  total: number,
): Promise<ChunkFindings> {
  const raw = await runJson<Partial<ChunkFindings>>(
    ai,
    EXTRACT_PROMPT,
    `Section ${index + 1} of ${total}:\n\n${section}`,
    FINDINGS_SCHEMA,
  );
  return {
    company: typeof raw.company === "string" ? raw.company.trim() : "",
    dataCollected: strings(raw.dataCollected, 20),
    sharedWith: strings(raw.sharedWith, 20),
    retention: strings(raw.retention, 10),
    userRights: strings(raw.userRights, 15),
    redFlags: flags(raw.redFlags, 10),
  };
}

export async function synthesizeReport(
  ai: Ai,
  input: {
    id: string;
    url: string;
    findings: ChunkFindings[];
    sourceText: string;
    truncated: boolean;
  },
): Promise<PolicyReport> {
  // Merge and dedupe before the model sees anything, so the prompt stays small
  // even for long policies.
  const merge = (pick: (f: ChunkFindings) => string[], limit: number) =>
    [...new Set(input.findings.flatMap(pick))].slice(0, limit);
  const merged = {
    companyCandidates: [...new Set(input.findings.map((f) => f.company).filter(Boolean))],
    dataCollected: merge((f) => f.dataCollected, 40),
    sharedWith: merge((f) => f.sharedWith, 40),
    retention: merge((f) => f.retention, 20),
    userRights: merge((f) => f.userRights, 30),
    redFlags: input.findings.flatMap((f) => f.redFlags).slice(0, 25),
  };

  const raw = await runJson<Record<string, unknown>>(
    ai,
    SYNTHESIZE_PROMPT,
    `Policy URL: ${input.url}\n\nFindings from all sections:\n${JSON.stringify(merged)}`,
    REPORT_SCHEMA,
    3000,
  );

  const host = new URL(input.url).hostname.replace(/^www\./, "");
  const score = Math.round(Number(raw.riskScore));

  return {
    id: input.id,
    url: input.url,
    company:
      typeof raw.company === "string" && raw.company.trim()
        ? raw.company.trim()
        : (merged.companyCandidates[0] ?? host),
    summary: typeof raw.summary === "string" ? raw.summary.trim() : "",
    riskScore: Number.isFinite(score) ? Math.min(10, Math.max(1, score)) : 5,
    riskRationale:
      typeof raw.riskRationale === "string" ? raw.riskRationale.trim() : "",
    dataCollected: strings(raw.dataCollected, 12),
    sharedWith: strings(raw.sharedWith, 12),
    retention: strings(raw.retention, 12),
    userRights: strings(raw.userRights, 12),
    redFlags: verifyQuotes(flags(raw.redFlags, 8), input.sourceText),
    sectionsRead: input.findings.length,
    truncated: input.truncated,
    analyzedAt: Date.now(),
  };
}

/**
 * Checks every quote against the fetched page text. LLMs paraphrase and
 * sometimes invent quotes; for a legal document the reader needs to know
 * which quotes they can rely on.
 */
export function verifyQuotes(
  redFlags: { issue: string; quote: string }[],
  sourceText: string,
): RedFlag[] {
  const squash = (s: string) =>
    s
      .toLowerCase()
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/\s+/g, " ")
      .trim();
  const haystack = squash(sourceText);
  return redFlags.map((flag) => ({
    issue: flag.issue.trim(),
    quote: flag.quote.trim(),
    verified: flag.quote.trim().length > 0 && haystack.includes(squash(flag.quote)),
  }));
}
