// Read-only helpers for the Portaldot native runtime over WebSocket.
// Used by the release preflight, bind.js and the funding checks.
// Every call is a storage read - nothing here signs or broadcasts anything.

const { assertOptionSome } = require('./validation.cjs');

const DEFAULT_TIMEOUT_MS = 20000;
const CONNECT_TIMEOUT_MS = 20000;

const KIND_QUERIES = {
  asset: { module: 'assets', query: 'asset', label: 'native asset' },
  nft_collection: { module: 'nfts', query: 'collection', label: 'native NFT collection' },
};

function withTimeout(operation, message, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${message} (timed out after ${timeoutMs}ms)`)), timeoutMs);
  });
  return Promise.race([
    Promise.resolve(operation),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

async function withNativeConnection(wsUrl, callback, timeoutMs = CONNECT_TIMEOUT_MS) {
  const { ApiPromise, WsProvider } = await import('@polkadot/api');
  const provider = new WsProvider(wsUrl, 2000);
  let api;
  try {
    api = await withTimeout(
      ApiPromise.create({ provider }),
      `connecting to the native runtime over ${wsUrl}`,
      timeoutMs
    );
    return await callback(api);
  } finally {
    if (api) {
      try {
        await api.disconnect();
      } catch {
        // disconnect failures are irrelevant once the result is timed out
      }
    } else {
      try {
        provider.disconnect();
      } catch {
        // provider may never have been created
      }
    }
  }
}

function requireStorageQuery(api, spec) {
  const runtimeQuery = api && api.query && api.query[spec.module] && api.query[spec.module][spec.query];
  if (typeof runtimeQuery !== 'function') {
    throw new Error(
      `the native runtime does not support ${spec.module}.${spec.query}: the query is missing from runtime metadata, so the object cannot be verified. Failing closed.`
    );
  }
  return runtimeQuery;
}

// Query a native object and reject Option::None, unsupported storage
// queries, RPC failures, timeouts and ambiguous results. Returns
// { kind, id, exists: true, details } only for a definitely existing object.
async function queryNativeObject({ wsUrl, kind, id, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const spec = KIND_QUERIES[kind];
  if (!spec) {
    throw new Error(`unknown native object kind: ${kind}`);
  }
  const label = `${spec.label} ${id}`;
  return withNativeConnection(wsUrl, async (api) => {
    const storageQuery = requireStorageQuery(api, spec);
    const option = await withTimeout(
      storageQuery(id),
      `reading ${label} from the native runtime`,
      timeoutMs
    );
    assertOptionSome(option, label);
    return {
      kind,
      id,
      exists: true,
      details: summarize(String(option.toString()), label),
    };
  }, timeoutMs);
}

// Trimmed, existence-neutral description used for logs only - never as
// proof of existence (existence is proven by assertOptionSome above).
function summarize(text, label) {
  const single = String(text).replace(/\s+/g, ' ').trim();
  const max = 200;
  return single.length > max ? `${single.slice(0, max)}… (${label} details truncated)` : single;
}

async function readNativeFreeBalance({ wsUrl, ss58, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return withNativeConnection(wsUrl, async (api) => {
    if (typeof (api.query && api.query.system && api.query.system.account) !== 'function') {
      throw new Error('the native runtime does not support system.account; the native balance cannot be verified. Failing closed.');
    }
    const accountInfo = await withTimeout(
      api.query.system.account(ss58),
      `reading the free balance of ${ss58} from the native runtime`,
      timeoutMs
    );
    if (accountInfo === null || typeof accountInfo !== 'object' || !accountInfo.data || typeof accountInfo.data.free === 'undefined') {
      throw new Error(`the native balance read for ${ss58} returned an unexpected shape; refusing to interpret it as funded`);
    }
    return BigInt(accountInfo.data.free.toString());
  }, timeoutMs);
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  CONNECT_TIMEOUT_MS,
  KIND_QUERIES,
  queryNativeObject,
  readNativeFreeBalance,
  summarize,
  requireStorageQuery,
  withNativeConnection,
};
