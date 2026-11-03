// Runs the Worker against a fake Garmin API: cd garmin-connector && npm test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const SECRET = "test-secret-0123456789abcdef";
const env = { CONNECTOR_SECRET: SECRET, GARMIN_API_KEY: "key-abc" };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (exp) => `${b64({ alg: "none" })}.${b64({ exp })}.sig`;

let calls, garminHandler;
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), init });
  return garminHandler(String(url), init);
};
const res = (body, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

const activity = (id, day, extra = {}) => ({
  activityId: id, activityName: `Run ${id}`, startTimeLocal: `${day} 07:30:00`, startTimeGMT: `${day} 06:30:00`,
  activityType: { typeId: 1, typeKey: "running" }, duration: 2700.4, distance: 8123.6, calories: 640, bmrCalories: 95, averageHR: 151.2, ...extra,
});

function defaultGarmin(pages) {
  let tokenCount = 0;
  return (url, init) => {
    if (url.includes("/personalapitoken-service/")) {
      assert.equal(init.headers.Authorization, "ApiKey key-abc");
      tokenCount++;
      return res({ access_token: jwt(Math.floor(Date.now() / 1000) + 86400), token_type: "Bearer", n: tokenCount });
    }
    if (url.includes("/activitylist-service/activities/search/activities")) {
      assert.match(init.headers.Authorization, /^Bearer /);
      const start = Number(new URL(url).searchParams.get("start"));
      return res(pages[start / 40] || []);
    }
    return res({ ok: true, url });
  };
}

const worker = (await import("../worker.js")).default;
const rpc = async (body, path = `/mcp/${SECRET}`) => {
  const r = await worker.fetch(new Request(`https://fuel-log.example.workers.dev${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify(body),
  }), env);
  const type = r.headers.get("content-type") || "";
  return { status: r.status, body: type.includes("json") ? await r.json() : null, type };
};
const callTool = (name, args, id = 3) => rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

beforeEach(() => { calls = []; garminHandler = defaultGarmin([[activity(1, "2026-11-01"), activity(2, "2026-10-30", { bmrCalories: undefined, calories: 300 })]]); });

test("root says it is running and wrong secret is 404", async () => {
  const r = await worker.fetch(new Request("https://x.workers.dev/"), env);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /running/);
  assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, "/mcp/nope")).status, 404);
  assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, `/mcp/${SECRET}x`)).status, 404);
  const g = await worker.fetch(new Request(`https://x.workers.dev/mcp/${SECRET}`), env);
  assert.equal(g.status, 405);
});

test("initialize, initialized notification, tools/list", async () => {
  const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  assert.equal(init.status, 200);
  assert.match(init.type, /application\/json/);
  assert.equal(init.body.result.protocolVersion, "2025-06-18");
  assert.ok(init.body.result.capabilities.tools);
  const odd = await rpc({ jsonrpc: "2.0", id: 9, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  assert.equal(odd.body.result.protocolVersion, "2025-06-18");
  assert.equal((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(list.body.result.tools.map((t) => t.name), ["get_activities", "garmin_get"]);
  assert.equal(list.body.result.tools[0].annotations.readOnlyHint, true);
  const unknown = await rpc({ jsonrpc: "2.0", id: 4, method: "nope" });
  assert.equal(unknown.body.error.code, -32601);
  const badTool = await callTool("nope", {});
  assert.equal(badTool.body.error.code, -32602);
});

test("get_activities shapes Garmin activities and uses active calories", async () => {
  const r = await callTool("get_activities", { start_date: "2026-10-26", end_date: "2026-11-01" });
  const out = r.body.result.structuredContent;
  assert.equal(r.body.result.isError, undefined);
  assert.equal(out.count, 2);
  assert.deepEqual(out.activities[1], {
    id: "1", date: "2026-11-01", start_local: "2026-11-01 07:30:00", name: "Run 1", type: "running",
    duration_min: 45, distance_km: 8.12, calories: 640, active_calories: 545, avg_hr: 151,
  });
  assert.equal(out.activities[0].active_calories, null); // no bmr: page falls back to total
  assert.deepEqual(JSON.parse(r.body.result.content[0].text), out);
  const search = new URL(calls.find((c) => c.url.includes("activitylist")).url);
  assert.equal(search.searchParams.get("startDate"), "2026-10-26");
  assert.equal(search.searchParams.get("endDate"), "2026-11-01");
  assert.equal(search.searchParams.get("limit"), "40");
});

test("pages through results and reuses the token", async () => {
  const page1 = Array.from({ length: 40 }, (_, i) => activity(100 + i, "2026-10-20"));
  garminHandler = defaultGarmin([page1, [activity(500, "2026-10-21")]]);
  const r = await callTool("get_activities", { start_date: "2026-10-01", end_date: "2026-10-31" });
  assert.equal(r.body.result.structuredContent.count, 41);
  await callTool("get_activities", { start_date: "2026-10-01" });
  assert.equal(calls.filter((c) => c.url.includes("personalapitoken")).length, 0, "token cached from earlier test");
});

test("bad dates and long ranges come back as tool errors", async () => {
  for (const args of [{ start_date: "1/11/2026" }, { start_date: "2026-11-02", end_date: "2026-11-01" }, { start_date: "2026-01-01", end_date: "2026-12-31" }]) {
    const r = await callTool("get_activities", args);
    assert.equal(r.body.result.isError, true);
  }
});

test("expired data token is refreshed once; rejected key explains the fix", async () => {
  let dataCalls = 0;
  const base = defaultGarmin([[activity(7, "2026-11-01")]]);
  garminHandler = (url, init) => {
    if (url.includes("activitylist") && ++dataCalls === 1) return res("expired", 401);
    return base(url, init);
  };
  const ok = await callTool("get_activities", { start_date: "2026-11-01" });
  assert.equal(ok.body.result.structuredContent.count, 1);
  assert.equal(calls.filter((c) => c.url.includes("personalapitoken")).length, 1);

  garminHandler = (url) => (url.includes("personalapitoken") ? res("no", 401) : res("expired", 401));
  const bad = await callTool("get_activities", { start_date: "2026-11-01" });
  assert.equal(bad.body.result.isError, true);
  assert.match(bad.body.result.content[0].text, /personalApiToken/);
});

test("garmin_get only allows Garmin service paths", async () => {
  for (const path of ["https://evil.example/x", "/download-service/files/activity/1", "/personalapitoken-service/x", "/sleep-service/../x", "sleep"]) {
    const r = await callTool("garmin_get", { path });
    assert.equal(r.body.result.isError, true, path);
  }
  const r = await callTool("garmin_get", { path: "/sleep-service/sleep/dailySleep?date=2026-11-01" });
  assert.equal(r.body.result.structuredContent.data.ok, true);
  assert.equal(r.body.result.structuredContent.data.url, "https://personal.connectapi.garmin.com/sleep-service/sleep/dailySleep?date=2026-11-01");
});

test("check page reports key status and a sample activity", async () => {
  const r = await worker.fetch(new Request(`https://x.workers.dev/check/${SECRET}`), env);
  const body = await r.text();
  assert.match(body, /✓ Garmin accepted your Personal API key/);
  assert.match(body, /"active_calories": 545/);
  assert.match(body, /Fields Garmin sent: .*activityId/);
  const missing = await worker.fetch(new Request(`https://x.workers.dev/check/${SECRET}`), { CONNECTOR_SECRET: SECRET });
  assert.match(await missing.text(), /GARMIN_API_KEY is not set/);
  assert.equal((await worker.fetch(new Request("https://x.workers.dev/check/wrong-secret-xxxxxxxx"), env)).status, 404);
});
