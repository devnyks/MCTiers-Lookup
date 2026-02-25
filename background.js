/**
 * MCTiers Lookup - Background Service Worker
 * Handles all API calls, caching, rate-limiting, and retry logic.
 */

const BASE_URL = 'https://mctiers.com/api/v2';
const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes
const MIN_REQUEST_INTERVAL_MS = 1000; // 1 req/sec

// ─── In-memory cache ────────────────────────────────────────────────────────
const memCache = new Map(); // key → { data, expiresAt }

function cacheGet(key) {
  const entry = memCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { memCache.delete(key); return null; }
  return entry.data;
}

function cacheSet(key, data) {
  memCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  // Mirror to chrome.storage for persistence across SW restarts
  chrome.storage.local.set({ [key]: { data, expiresAt: Date.now() + CACHE_TTL_MS } });
}

async function cacheGetWithStorage(key) {
  const mem = cacheGet(key);
  if (mem) return mem;
  // Try chrome.storage
  return new Promise(resolve => {
    chrome.storage.local.get(key, result => {
      const entry = result[key];
      if (entry && Date.now() < entry.expiresAt) {
        memCache.set(key, entry); // warm mem cache
        resolve(entry.data);
      } else {
        resolve(null);
      }
    });
  });
}

// ─── Rate limiter ────────────────────────────────────────────────────────────
let lastRequestTime = 0;
const requestQueue = [];
let processingQueue = false;

function queueRequest(fn) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ fn, resolve, reject });
    if (!processingQueue) drainQueue();
  });
}

async function drainQueue() {
  processingQueue = true;
  while (requestQueue.length > 0) {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < MIN_REQUEST_INTERVAL_MS) {
      await sleep(MIN_REQUEST_INTERVAL_MS - elapsed);
    }
    const { fn, resolve, reject } = requestQueue.shift();
    lastRequestTime = Date.now();
    try { resolve(await fn()); } catch (e) { reject(e); }
  }
  processingQueue = false;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Fetch with exponential backoff ──────────────────────────────────────────
async function fetchWithBackoff(url, attempt = 0) {
  const maxAttempts = 4;
  try {
    const res = await fetch(url);
    if (res.status === 429 || res.status >= 500) {
      if (attempt < maxAttempts) {
        const delay = Math.pow(2, attempt) * 500 + Math.random() * 300;
        await sleep(delay);
        return fetchWithBackoff(url, attempt + 1);
      }
      throw new ApiError(res.status === 429 ? 'RATE_LIMITED' : 'SERVER_ERROR', res.status);
    }
    if (res.status === 404) throw new ApiError('NOT_FOUND', 404);
    if (!res.ok) throw new ApiError('SERVER_ERROR', res.status);
    return res.json();
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError('NETWORK_ERROR', 0);
  }
}

class ApiError extends Error {
  constructor(type, status) {
    super(type);
    this.type = type;
    this.status = status;
  }
}

// ─── API helpers ─────────────────────────────────────────────────────────────

/** Fetch player profile by name (includes rankings + recent tests). */
async function fetchProfileByName(name) {
  const url = `${BASE_URL}/profile/by-name/${encodeURIComponent(name)}?tests`;
  return fetchWithBackoff(url);
}

/** Fetch player profile by UUID (includes rankings + tests). */
async function fetchProfileByUUID(uuid) {
  const url = `${BASE_URL}/profile/${encodeURIComponent(uuid)}?tests`;
  return fetchWithBackoff(url);
}

// ─── Message handler is defined after prefetchAvatar below ───────────────────

async function handleLookup(rawName) {
  const name = rawName.trim();
  const cacheKey = `player:${name.toLowerCase()}`;

  const cached = await cacheGetWithStorage(cacheKey);
  if (cached) return { ok: true, data: cached, fromCache: true };

  // Try primary name, then capitalized variant
  const data = await queueRequest(async () => {
    try {
      return await fetchProfileByName(name);
    } catch (e) {
      if (e.type === 'NOT_FOUND') {
        // Try capitalized variant
        const capitalized = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
        if (capitalized !== name) return fetchProfileByName(capitalized);
      }
      throw e;
    }
  });

  // Enrich: transform rankings object into sorted flat array
  const gamemodes = Object.entries(data.rankings || {})
    .map(([slug, ranking]) => ({ slug, ...ranking }))
    .sort((a, b) => a.slug.localeCompare(b.slug));

  // Sort tests desc by timestamp
  const tests = (data.tests || []).sort((a, b) => b.at - a.at);

  const result = {
    uuid: data.uuid,
    name: data.name,
    region: data.region,
    points: data.points,
    overall: data.overall,
    gamemodes,
    tests,
    firstTest: tests.length ? tests[tests.length - 1] : null,
    // 64px exactly matches the display size — no wasted bytes
    skinUrl: `https://crafatar.com/avatars/${data.uuid}?size=64&overlay=true`,
    profileUrl: `https://mctiers.com/player/${data.name}`,
  };

  cacheSet(cacheKey, result);

  // Fire-and-forget: prime the avatar into Cache Storage so the popup
  // gets a cache hit the instant it renders the PlayerAvatar component.
  prefetchAvatar(data.uuid, result.skinUrl);

  return { ok: true, data: result };
}

function classifyError(e) {
  if (!(e instanceof ApiError)) return { type: 'UNKNOWN', message: 'An unexpected error occurred.' };
  switch (e.type) {
    case 'NOT_FOUND':    return { type: 'NOT_FOUND', message: 'Player not found. Check the spelling and try again.' };
    case 'RATE_LIMITED': return { type: 'RATE_LIMITED', message: 'Too many requests — please wait a moment.' };
    case 'SERVER_ERROR': return { type: 'SERVER_ERROR', message: 'MCTiers is having server issues. Try again shortly.' };
    case 'NETWORK_ERROR':return { type: 'NETWORK_ERROR', message: 'Network error. Check your connection.' };
    default:             return { type: 'UNKNOWN', message: 'Something went wrong.' };
  }
}

// ─── Avatar Cache Storage prefetch ────────────────────────────────────────────
const AVATAR_CACHE_NAME = 'mctiers-avatars-v1';

/**
 * Pre-fetch and store the player's 64px avatar into Cache Storage.
 * Silently no-ops on any error — avatar loading in the popup degrades
 * gracefully to a direct fetch if this hasn't run yet.
 *
 * Uses Cache Storage (not the data cache) so the browser's standard
 * HTTP cache headers on crafatar.com are also respected.
 *
 * @param {string} uuid       Player UUID
 * @param {string} [skinUrl]  Full crafatar URL; constructed if omitted
 */
async function prefetchAvatar(uuid, skinUrl) {
  if (!uuid) return;
  const url = skinUrl || `https://crafatar.com/avatars/${uuid}?size=64&overlay=true`;

  try {
    const cache = await caches.open(AVATAR_CACHE_NAME);

    // Only fetch if not already cached
    const existing = await cache.match(url);
    if (existing) return; // already warm

    const resp = await fetch(url);
    if (resp.ok) {
      await cache.put(url, resp);
    }
  } catch {
    // Network error, Cache API unavailable, etc. — silently ignore.
  }
}

// ─── Message handler ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'LOOKUP_PLAYER') {
    handleLookup(msg.name).then(sendResponse).catch(e => {
      sendResponse({ error: classifyError(e) });
    });
    return true; // keep channel open for async response
  }

  if (msg.type === 'PREFETCH_AVATAR') {
    // Popup requests a prefetch (e.g. for a cached player result that
    // was served before prefetchAvatar had a chance to run).
    prefetchAvatar(msg.uuid, msg.skinUrl);
    // No response needed — fire and forget from popup's perspective.
    return false;
  }
});
