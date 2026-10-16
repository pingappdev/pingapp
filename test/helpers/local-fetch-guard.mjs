const anvilEndpoint = process.env.ANVIL_RPC_URL;
const publicEndpoint = process.env.PUBLIC_RPC_URL;
const anvilUrl = anvilEndpoint ? new URL(anvilEndpoint) : undefined;

if (!anvilUrl || publicEndpoint !== anvilEndpoint || !["127.0.0.1", "localhost"].includes(anvilUrl.hostname)
  || process.env.ALCHEMY_API_KEYS !== "") {
  throw new Error("Local fetch guard requires the explicit loopback Anvil endpoint and no RPC fallback.");
}

const originalFetch = globalThis.fetch.bind(globalThis);
const fakeProviders = new Map([
  ["https://api.robinhood.com/rhj/assets", { label: "robinhood-assets", body: { assets: [] } }],
]);

globalThis.fetch = async (input, init) => {
  const target = new URL(input instanceof Request ? input.url : String(input));
  if (target.origin === anvilUrl.origin) return originalFetch(input, init);

  const fake = fakeProviders.get(target.href);
  if (fake) {
    process.stdout.write(`LOCAL_FAKE_PROVIDER=${fake.label}\n`);
    return new Response(JSON.stringify(fake.body), { status: 200, headers: { "content-type": "application/json" } });
  }

  process.stderr.write("BLOCKED_EXTERNAL_FETCH\n");
  throw new Error("Local recovery fetch guard blocked an external request.");
};
