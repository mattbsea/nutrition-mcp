// Black-box smoke test over HTTP against a running server:
//
//   MCP_KEY=<key> DATA_DIR=$(mktemp -d) HOST=127.0.0.1 PORT=8099 bun src/index.ts &
//   bun scripts/smoke.ts http://127.0.0.1:8099 <key>
//
// Walks initialize, tools/list, a representative set of tools, the export
// download and delete_account, then checks the wrong-key behaviour. Prints
// request/response excerpts. Exits non-zero on the first unexpected result.
// The key is only ever sent in the URL path; it is never printed.

const [base, key] = process.argv.slice(2);
if (!base || !key) {
    console.error("usage: bun scripts/smoke.ts <base-url> <mcp-key>");
    process.exit(2);
}

const HEADERS = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
};
let id = 0;

async function rpc(method: string, params: unknown, path = `/mcp/${key}`) {
    const body = { jsonrpc: "2.0", id: ++id, method, params };
    const res = await fetch(base + path, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify(body),
    });
    const text = await res.text();
    // Stateless server: the reply is a single JSON body or a single SSE frame.
    const data =
        text.startsWith("event:") ||
        text.includes("\ndata:") ||
        text.startsWith("data:")
            ? text
                  .split("\n")
                  .filter((l) => l.startsWith("data:"))
                  .map((l) => l.slice(5).trim())[0]
            : text;
    return {
        status: res.status,
        json: data ? JSON.parse(data) : null,
        raw: text,
    };
}

const redact = (s: string) => s.split(key).join("[key]");
const excerpt = (v: unknown, n = 260) => {
    const s = redact(typeof v === "string" ? v : JSON.stringify(v));
    return s.length > n ? s.slice(0, n) + "…" : s;
};
function check(cond: unknown, what: string) {
    if (!cond) {
        console.error(`FAIL: ${what}`);
        process.exit(1);
    }
}
const textOf = (r: { result?: { content?: { text: string }[] } }) =>
    (r.result?.content ?? []).map((c) => c.text).join("\n");

async function tool(name: string, args: Record<string, unknown> = {}) {
    const r = await rpc("tools/call", { name, arguments: args });
    console.log(
        `\n> tools/call ${name} ${excerpt(args, 120)}\n< ${r.status} ${excerpt(textOf(r.json) || r.json)}`,
    );
    check(r.status === 200, `${name} HTTP status`);
    check(
        !r.json.result?.isError,
        `${name} returned isError: ${excerpt(textOf(r.json))}`,
    );
    return r.json;
}

const init = await rpc("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
});
console.log(
    `> initialize\n< ${init.status} ${excerpt(init.json?.result?.serverInfo)} protocol=${init.json?.result?.protocolVersion}`,
);
check(
    init.status === 200 && init.json.result.serverInfo.name === "nutrition-mcp",
    "initialize",
);

const list = await rpc("tools/list", {});
const names: string[] = list.json.result.tools.map(
    (t: { name: string }) => t.name,
);
console.log(
    `\n> tools/list\n< ${list.status} ${names.length} tools:\n  ${names.join(", ")}`,
);
check(names.length > 40, "tools/list count");

await tool("set_timezone", { timezone: "UTC" });
await tool("log_meal", {
    description: "porridge with berries",
    meal_type: "breakfast",
    calories: 320,
    protein_g: 12,
    carbs_g: 52,
    fat_g: 7,
});
const today = await tool("get_meals_today");
check(textOf(today).includes("porridge"), "get_meals_today shows the meal");
await tool("set_nutrition_goals", {
    daily_calories: 2000,
    daily_protein_g: 150,
});
const progress = await tool("get_goal_progress");
check(textOf(progress).includes("2000"), "get_goal_progress mentions the goal");
await tool("log_water", { amount_ml: 500 });
await tool("log_weight", { weight: 80.4, unit: "kg" });
const exp = await tool("export_all_data");
const m = /(\/exports\/download\?exp=\d+&sig=[\w-]+)/.exec(textOf(exp));
check(m, "export link in the tool text");
const dl = await fetch(base + m![1]!);
const zip = new Uint8Array(await dl.arrayBuffer());
console.log(
    `\n> GET ${m![1]!.slice(0, 40)}…\n< ${dl.status} ${dl.headers.get("content-type")} ${zip.length} bytes, magic=${String.fromCharCode(zip[0]!, zip[1]!)}`,
);
check(
    dl.status === 200 && zip[0] === 0x50 && zip[1] === 0x4b,
    "export download is a ZIP",
);
const bad = await fetch(base + m![1]!.replace(/sig=./, "sig=X"));
console.log(
    `> GET same link, tampered signature\n< ${bad.status} ${await bad.text()}`,
);
check(bad.status === 404, "tampered export link is a 404");
await tool("delete_account", { confirm: true });
const after = await tool("get_meals_today");
check(!textOf(after).includes("porridge"), "data is gone after delete_account");
const gone = await fetch(base + m![1]!);
console.log(`> GET export link after delete_account\n< ${gone.status}`);
check(gone.status === 404, "export archive removed by delete_account");

// ---- perimeter
const wrong = await rpc("tools/list", {}, `/mcp/${key.slice(0, -1)}x`);
const nonexistent = await fetch(base + "/no/such/route", {
    method: "POST",
    body: "{}",
});
const wrongRaw = await fetch(base + `/mcp/${"w".repeat(key.length)}`, {
    method: "POST",
    headers: HEADERS,
    body: "{}",
});
console.log(`\n> POST /mcp/<wrong key>\n< ${wrong.status} ${wrong.raw}`);
console.log(
    `> POST /mcp/<wrong key, same length>\n< ${wrongRaw.status} ${await wrongRaw.text()}`,
);
console.log(
    `> POST /no/such/route\n< ${nonexistent.status} ${await nonexistent.text()}`,
);
const noKey = await fetch(base + "/mcp", {
    method: "POST",
    headers: HEADERS,
    body: "{}",
});
console.log(`> POST /mcp (no key)\n< ${noKey.status}`);
const hs = await fetch(base + "/api/v1/health-sync/pending");
console.log(
    `> GET /api/v1/health-sync/pending\n< ${hs.status} ${await hs.text()}`,
);
const root = await fetch(base + "/");
console.log(`> GET /\n< ${root.status} ${await root.text()}`);
check(
    wrong.status === 404 &&
        wrongRaw.status === 404 &&
        nonexistent.status === 404 &&
        noKey.status === 404,
    "wrong/missing key and unknown route are all 404",
);
check(hs.status === 501 && root.status === 404, "health-sync 501, / 404");
console.log("\nSMOKE OK");
