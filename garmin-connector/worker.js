// Garmin Sync: a small MCP connector that lets Claude and the Fuel Log page read your own
// Garmin Connect data through Garmin's Personal API. Read-only: it never changes anything in Garmin.
//
// Set these as Secrets on the Worker (Cloudflare dashboard > the Worker > Settings > Variables and Secrets):
//   GARMIN_API_KEY    the key from https://connect.garmin.com/app/settings/personalApiToken
//   CONNECTOR_SECRET  a long random string. The connector URL is https://<worker>/mcp/<CONNECTOR_SECRET>
//
// Routes
//   GET  /                         says the Worker is running (no data)
//   GET  /check/<CONNECTOR_SECRET>  checks the Garmin key and shows what one activity looks like
//   POST /mcp/<CONNECTOR_SECRET>    the MCP endpoint (Streamable HTTP, JSON responses, no sessions)

const GARMIN = "https://personal.connectapi.garmin.com";
const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";
const ACTIVITY_SEARCH = "/activitylist-service/activities/search/activities";
const PAGE_SIZE = 40; // Garmin returns HTTP 500 for pages larger than about 45
const MAX_DAYS = 92;
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "garmin-sync", title: "Garmin Sync", version: "1.0.0" };
const KEY_PAGE = "connect.garmin.com/app/settings/personalApiToken";
const UA = "FuelLog-GarminSync/1.1 (+https://github.com/garethaird2005/Fuel-Log)";

const ACTIVITY_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    date: { type: "string", description: "Local calendar date, YYYY-MM-DD" },
    start_local: { type: "string" },
    name: { type: "string" },
    type: { type: ["string", "null"] },
    duration_min: { type: ["number", "null"] },
    distance_km: { type: ["number", "null"] },
    calories: { type: ["number", "null"], description: "Total kcal during the activity, resting included" },
    active_calories: { type: ["number", "null"], description: "kcal above resting burn" },
    avg_hr: { type: ["number", "null"] },
  },
  required: ["id", "date", "name"],
};

const TOOLS = [
  {
    name: "get_activities",
    title: "Get Garmin workouts",
    description:
      "List the user's Garmin workouts (activities) between two dates, inclusive, with duration, distance and calories burned. " +
      "Dates are YYYY-MM-DD in the user's local time. At most 92 days per call.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "First day, YYYY-MM-DD" },
        end_date: { type: "string", description: "Last day, YYYY-MM-DD. Defaults to start_date." },
      },
      required: ["start_date"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string" },
        end_date: { type: "string" },
        count: { type: "integer" },
        activities: { type: "array", items: ACTIVITY_SCHEMA },
      },
      required: ["start_date", "end_date", "count", "activities"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "garmin_get",
    title: "Read Garmin data",
    description:
      "Read one endpoint of the user's own Garmin Connect Personal API (GET only) and return its JSON. Use it for data get_activities " +
      "doesn't cover, for example: daily summaries /usersummary-service/v2/dailysummaries?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD " +
      "(31 days max), sleep /sleep-service/sleep/dailySleep?date=YYYY-MM-DD, HRV /hrv-service/hrv/YYYY-MM-DD, " +
      "weight /weight-service/weight/range/YYYY-MM-DD/YYYY-MM-DD?includeAll=true (grams), food log /nutrition-service/food/logs/YYYY-MM-DD, " +
      "one activity /activity-service/activity/ACTIVITY_ID.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Path starting with /, including any query string" } },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/") return text("Garmin Sync for Fuel Log is running.\n");

    const check = path.match(/^\/check\/([^/]+)$/);
    if (check) {
      if (!secretMatches(check[1], env)) return text("Not found\n", 404);
      return text(await runCheck(env));
    }

    const mcp = path.match(/^\/mcp\/([^/]+)$/);
    if (!mcp || !secretMatches(mcp[1], env)) return text("Not found\n", 404);
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });

    let body;
    try {
      body = await request.json();
    } catch {
      return json(rpcError(null, -32700, "Parse error"));
    }
    if (Array.isArray(body)) {
      const replies = (await Promise.all(body.map((m) => handle(m, env)))).filter(Boolean);
      return replies.length ? json(replies) : new Response(null, { status: 202 });
    }
    const reply = await handle(body, env);
    return reply ? json(reply) : new Response(null, { status: 202 });
  },
};

// ---------- MCP ----------

async function handle(msg, env) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return msg && typeof msg === "object" && "id" in msg ? rpcError(msg.id ?? null, -32600, "Invalid request") : null;
  }
  if (!("id" in msg)) return null; // notifications (initialized, cancelled, ...) need no reply
  const { id, method } = msg;
  const params = msg.params || {};
  switch (method) {
    case "initialize": {
      const asked = params.protocolVersion;
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[1],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Read-only access to this user's own Garmin Connect data. Use get_activities for workouts and calories; " +
          "use garmin_get for sleep, daily summaries, HRV, weight and the Garmin food log.",
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call": {
      const name = params.name;
      if (!TOOLS.some((t) => t.name === name)) return rpcError(id, -32602, `Unknown tool: ${name}`);
      return rpcResult(id, await callTool(name, params.arguments || {}, env));
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

async function callTool(name, args, env) {
  try {
    const data = name === "get_activities" ? await getActivities(args, env) : await garminGet(args, env);
    const body = JSON.stringify(data);
    if (body.length > 400000) {
      return { content: [{ type: "text", text: body.slice(0, 400000) + "\n[cut short: ask for a smaller date range]" }] };
    }
    return { content: [{ type: "text", text: body }], structuredContent: data };
  } catch (e) {
    const message = e && e.userMessage ? e.userMessage : "Something went wrong talking to Garmin. Try again in a minute.";
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

// ---------- tools ----------

async function getActivities(args, env) {
  const start = String(args.start_date || "");
  const end = String(args.end_date || args.start_date || "");
  if (!isDate(start) || !isDate(end)) throw userError("Use dates like 2026-11-01.");
  if (end < start) throw userError("end_date must be on or after start_date.");
  if (dayCount(start, end) > MAX_DAYS) throw userError(`Ask for ${MAX_DAYS} days or fewer at a time.`);

  const raw = [];
  for (let page = 0; page < 10; page++) {
    const q = new URLSearchParams({ start: String(page * PAGE_SIZE), limit: String(PAGE_SIZE), startDate: start, endDate: end });
    const batch = listOf(await garmin(`${ACTIVITY_SEARCH}?${q}`, env));
    raw.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  const seen = new Set();
  const activities = raw
    .map(shapeActivity)
    .filter((a) => (!a.date || (a.date >= start && a.date <= end)) && !seen.has(a.id) && seen.add(a.id))
    .sort((a, b) => (a.start_local < b.start_local ? -1 : a.start_local > b.start_local ? 1 : 0));
  return { start_date: start, end_date: end, count: activities.length, activities };
}

async function garminGet(args, env) {
  const p = String(args.path || "");
  const ok =
    /^\/[a-z0-9-]+-service\/[A-Za-z0-9\-._~/%]*(\?[A-Za-z0-9\-._~=&%+:,]*)?$/.test(p) &&
    !p.includes("..") &&
    !p.startsWith("/download-service") &&
    !p.startsWith("/personalapitoken-service");
  if (!ok) throw userError("Give a Garmin API path such as /sleep-service/sleep/dailySleep?date=2026-11-01.");
  const data = await garmin(p, env);
  return { path: p, data };
}

// Garmin's activity list uses Garmin Connect's field names. Fall back across the names we know.
function shapeActivity(a) {
  const startLocal = String(a.startTimeLocal || a.startTimeGMT || a.startTime || "");
  const total = numOrNull(a.calories ?? a.totalKilocalories ?? a.activeKilocalories);
  const bmr = numOrNull(a.bmrCalories ?? a.bmrKilocalories);
  let active = numOrNull(a.activeKilocalories ?? a.activeCalories);
  if (active == null && total != null && bmr != null) active = Math.max(0, total - bmr);
  const seconds = numOrNull(a.duration ?? a.durationInSeconds ?? a.elapsedDuration);
  const meters = numOrNull(a.distance ?? a.distanceInMeters);
  const type = a.activityType && typeof a.activityType === "object" ? a.activityType.typeKey : a.activityType;
  return {
    id: String(a.activityId ?? a.summaryId ?? a.id ?? `${startLocal}-${a.activityName || ""}`),
    date: startLocal.slice(0, 10),
    start_local: startLocal,
    name: String(a.activityName || prettify(type) || "Workout"),
    type: type ? String(type) : null,
    duration_min: seconds != null ? Math.round(seconds / 60) : null,
    distance_km: meters ? Math.round(meters / 10) / 100 : null,
    calories: total != null ? Math.round(total) : null,
    active_calories: active != null ? Math.round(active) : null,
    avg_hr: numOrNull(a.averageHR ?? a.averageHeartRateInBeatsPerMinute) != null ? Math.round(a.averageHR ?? a.averageHeartRateInBeatsPerMinute) : null,
  };
}

// ---------- check page ----------

async function runCheck(env) {
  const lines = ["Garmin Sync check", ""];
  if (!env.GARMIN_API_KEY) return lines.concat("✗ GARMIN_API_KEY is not set on this Worker yet.").join("\n") + "\n";
  try {
    await accessToken(env, true);
    lines.push("✓ Garmin accepted your Personal API key.");
    const end = isoDay(0), start = isoDay(-13);
    const q = new URLSearchParams({ start: "0", limit: "5", startDate: start, endDate: end });
    const list = listOf(await garmin(`${ACTIVITY_SEARCH}?${q}`, env));
    lines.push(`✓ Found ${list.length} activit${list.length === 1 ? "y" : "ies"} between ${start} and ${end}${list.length === 5 ? " (showing up to 5)" : ""}.`);
    if (list[0]) {
      lines.push("", "Newest one as Fuel Log will see it:", JSON.stringify(shapeActivity(list[0]), null, 2));
      lines.push("", "Fields Garmin sent: " + Object.keys(list[0]).sort().join(", "));
    } else {
      lines.push("Record a workout on your watch, sync it to Garmin Connect, then reload this page.");
    }
  } catch (e) {
    lines.push("✗ " + (e && e.userMessage ? e.userMessage : String(e)));
  }
  return lines.join("\n") + "\n";
}

// ---------- Garmin API ----------

let cached = null; // { token, exp (ms), key }

async function accessToken(env, force) {
  const key = String(env.GARMIN_API_KEY || "").trim();
  if (!key) throw userError("GARMIN_API_KEY is not set on the Cloudflare Worker yet.");
  if (!force && cached && cached.key === key && cached.exp - Date.now() > 3600_000) return cached.token;

  let r;
  try {
    // The token comes back as raw text, so asking for JSON only gets HTTP 406. Accept anything, like Garmin's curl example.
    r = await fetch(GARMIN + TOKEN_PATH, { method: "POST", headers: { Authorization: `ApiKey ${key}`, Accept: "*/*", "User-Agent": UA } });
  } catch {
    throw userError("Couldn't reach Garmin. Try again in a minute.");
  }
  if (r.status === 401 || r.status === 403) {
    throw userError(`Garmin rejected your Personal API key. It may have expired or been deleted. Create a new one at ${KEY_PAGE} and update GARMIN_API_KEY in Cloudflare.`);
  }
  if (r.status === 429) throw userError("Garmin is limiting requests right now. Try again in a few minutes.");
  if (!r.ok) throw userError(`Garmin's token service answered ${r.status}${await snippet(r)}.${r.status >= 500 ? " Try again in a few minutes." : ""}`);
  const { token, expiresIn } = parseToken((await r.text()).trim());
  if (!token) throw userError("Garmin's token reply wasn't in the expected format.");
  const exp = jwtExpiry(token) || (expiresIn ? Date.now() + expiresIn * 1000 : Date.now() + 23 * 3600_000);
  cached = { token, exp, key };
  return token;
}

async function garmin(path, env, retried = false) {
  const token = await accessToken(env, retried);
  let r;
  try {
    r = await fetch(GARMIN + path, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json, */*;q=0.8", "User-Agent": UA } });
  } catch {
    throw userError("Couldn't reach Garmin. Try again in a minute.");
  }
  if (r.status === 401 && !retried) return garmin(path, env, true);
  if (r.status === 401 || r.status === 403) throw userError("Garmin refused the request. Check that your Personal API key is still active.");
  if (r.status === 404) throw userError(`Garmin has no data at ${path.split("?")[0]}.`);
  if (r.status === 429) throw userError("Garmin is limiting requests right now. Try again in a few minutes.");
  if (r.status === 204) return null;
  if (!r.ok) throw userError(`Garmin answered ${r.status} for ${path.split("?")[0]}. Try a smaller date range or try again later.`);
  const t = await r.text();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

// ---------- helpers ----------

// Garmin sends the access token as raw text. Also accept a JSON object, a JSON string or a "Bearer " prefix.
function parseToken(raw) {
  let j;
  try { j = JSON.parse(raw); } catch { j = undefined; }
  if (j && typeof j === "object") {
    const t = j.access_token || j.accessToken || j.token || (j.data && (j.data.access_token || j.data.accessToken));
    return { token: typeof t === "string" && t.trim() ? t.trim() : null, expiresIn: numOrNull(j.expires_in ?? j.expiresIn) };
  }
  const text = (typeof j === "string" ? j : raw).trim().replace(/^Bearer\s+/i, "");
  return { token: /^[A-Za-z0-9._~+\/=-]{20,}$/.test(text) ? text : null, expiresIn: null };
}

// A short, single-line excerpt of an error reply, for the check page.
async function snippet(r) {
  try {
    const t = (await r.text()).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
    return t ? ` (${t})` : "";
  } catch {
    return "";
  }
}

function secretMatches(given, env) {
  const want = String(env.CONNECTOR_SECRET || "");
  let got;
  try {
    got = decodeURIComponent(given);
  } catch {
    return false;
  }
  if (want.length < 16 || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

function listOf(v) {
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.activityList)) return v.activityList;
  if (v && Array.isArray(v.activities)) return v.activities;
  return [];
}

function jwtExpiry(token) {
  try {
    const part = token.split(".")[1];
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const exp = JSON.parse(atob(b64)).exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function isDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
const dayCount = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000) + 1;
const isoDay = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const numOrNull = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const prettify = (s) => (s ? String(s).replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : "");
const userError = (userMessage) => Object.assign(new Error(userMessage), { userMessage });
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const json = (v) => new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json" } });
const text = (s, status = 200) => new Response(s, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
