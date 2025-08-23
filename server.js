/**

Express + Jikan API Service


---

Features:

Endpoints:


GET /titles?type=series|movie&page={n}

GET /search?keyword={q}

GET /details?id={mal_id}

10 minute in-memory caching (Map-based)


Clean formatting: { id, title, poster }


Error handling for failed API calls


Run:

npm i express axios

node server.js

Optional dev env:

PORT=4000 node server.js */


const express = require('express'); const axios = require('axios');

const app = express(); const PORT = process.env.PORT || 3000;

// ----------------------------- // Cache helper (Map-based TTL) // ----------------------------- const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes const cache = new Map(); // key -> { value, expiresAt }

function getCache(key) { const hit = cache.get(key); if (!hit) return null; if (Date.now() > hit.expiresAt) { cache.delete(key); return null; } return hit.value; }

function setCache(key, value, ttlMs = CACHE_TTL_MS) { cache.set(key, { value, expiresAt: Date.now() + ttlMs }); }

// Clean up expired entries occasionally (best-effort) setInterval(() => { const now = Date.now(); for (const [k, v] of cache.entries()) { if (v.expiresAt <= now) cache.delete(k); } }, 60 * 1000).unref(); // every 1 min, don't keep process alive

// ----------------------------- // Jikan API client // ----------------------------- const JIKAN = axios.create({ baseURL: 'https://api.jikan.moe/v4', timeout: 12_000, headers: { 'User-Agent': 'Express-Jikan-Proxy/1.0' }, });

async function jikanGet(path, params = {}) { try { const res = await JIKAN.get(path, { params }); return res.data; // Jikan v4 responses use { data, pagination? } } catch (err) { const status = err.response?.status || 500; const message = err.response?.data?.message || err.message || 'Unknown error'; const details = err.response?.data || null; const e = new Error(message); e.status = status; e.details = details; throw e; } }

// ----------------------------- // Mapping helpers // ----------------------------- function pickTitle(anime) { // Prefer English title from titles[]; fallback to title, then japanese // Jikan v4: anime.titles is an array [{ type: 'Default'|'English'|'Japanese'|..., title: '...' }] const english = Array.isArray(anime.titles) ? anime.titles.find(t => t.type === 'English')?.title : null; const fallback = anime.title || null; // Default title const jp = anime.title_japanese || null; return english || fallback || jp || 'Untitled'; }

function pickPoster(anime) { // Prefer webp large > jpg large > jpg image_url fallback const images = anime.images || {}; const webp = images.webp || {}; const jpg = images.jpg || {}; return ( webp.large_image_url || webp.image_url || jpg.large_image_url || jpg.image_url || null ); }

function mapAnimeListItem(anime) { return { id: anime.mal_id, title: pickTitle(anime), poster: pickPoster(anime), }; }

// Build an episodes map { [number]: preferredTitle } function buildEpisodesMap(episodes) { const map = {}; for (const ep of episodes) { if (!ep) continue; const num = ep.mal_id ?? ep.episode_id ?? ep.number ?? ep.episode ?? ep?.aired?.episode ?? null; const n = ep.mal_id || ep.episode_id || ep.mal_id || ep?.episode || ep?.number; const episodeNo = Number.isFinite(ep.mal_id) ? ep.mal_id : (Number.isFinite(ep.episode) ? ep.episode : (Number.isFinite(ep.mal_id) ? ep.mal_id : ep?.mal_id)); const key = ep.episode ?? ep.mal_id ?? ep.number ?? null;

const preferredTitle = ep.title || ep.title_romanji || ep.title_japanese || ep.title_romanized || null;
const episodeNumber = ep.mal_id && typeof ep.mal_id === 'number' ? ep.mal_id
  : (typeof ep.mal_id === 'string' && !Number.isNaN(Number(ep.mal_id)) ? Number(ep.mal_id)
  : (typeof ep.episode === 'number' ? ep.episode
  : (typeof ep.number === 'number' ? ep.number : null)));

const k = episodeNumber ?? key ?? n ?? num;
if (k != null) map[String(k)] = preferredTitle;

} return map; }

// ----------------------------- // Routes // -----------------------------

// Health app.get('/health', (req, res) => { res.json({ ok: true, uptime: process.uptime() }); });

// GET /titles?type=series|movie&page={page} app.get('/titles', async (req, res) => { const rawType = String(req.query.type || '').toLowerCase(); const page = Number(req.query.page || 1) || 1;

let jikanType; if (rawType === 'series') jikanType = 'tv'; else if (rawType === 'movie') jikanType = 'movie'; else return res.status(400).json({ error: "Invalid 'type'. Use 'series' or 'movie'." });

const cacheKey = titles:${jikanType}:page:${page}; const cached = getCache(cacheKey); if (cached) return res.json(cached);

try { const payload = await jikanGet('/anime', { type: jikanType, page }); const list = Array.isArray(payload.data) ? payload.data.map(mapAnimeListItem) : []; setCache(cacheKey, list); res.json(list); } catch (e) { res.status(e.status || 500).json({ error: e.message, details: e.details || null }); } });

// GET /search?keyword={query} app.get('/search', async (req, res) => { const keyword = String(req.query.keyword || '').trim(); if (!keyword) return res.status(400).json({ error: "Missing 'keyword' query param." });

const cacheKey = search:${keyword.toLowerCase()}; const cached = getCache(cacheKey); if (cached) return res.json(cached);

try { const payload = await jikanGet('/anime', { q: keyword, order_by: 'score', sort: 'desc' }); const list = Array.isArray(payload.data) ? payload.data.map(mapAnimeListItem) : []; setCache(cacheKey, list); res.json(list); } catch (e) { res.status(e.status || 500).json({ error: e.message, details: e.details || null }); } });

// GET /details?id={id} app.get('/details', async (req, res) => { const id = Number(req.query.id); if (!Number.isFinite(id)) return res.status(400).json({ error: "Missing or invalid 'id'" });

const cacheKey = details:${id}; const cached = getCache(cacheKey); if (cached) return res.json(cached);

try { // 1) Base details const details = await jikanGet(/anime/${id}/full); const anime = details.data; if (!anime) throw Object.assign(new Error('Anime not found'), { status: 404 });

const base = {
  id: anime.mal_id,
  title: pickTitle(anime),
  poster: pickPoster(anime),
};

// 2) Relations -> treat 'Prequel'/'Sequel' etc as "seasons" list (best-effort)
const relationsPayload = await jikanGet(`/anime/${id}/relations`).catch(() => ({ data: [] }));
const seasons = Array.isArray(relationsPayload.data)
  ? relationsPayload.data
      .filter(r => ['Prequel', 'Sequel', 'Side story', 'Alternative version', 'Spin-off'].includes(r.relation))
      .flatMap(r => (Array.isArray(r.entry) ? r.entry : []))
      .map(entry => ({ id: entry.mal_id, title: entry.name }))
  : [];

// 3) Episodes (pull multiple pages if needed, up to a safe cap)
const episodes = [];
let page = 1;
const MAX_PAGES = 10; // safety cap (Jikan pages usually 100 eps per page)
let hasNext = true;

while (hasNext && page <= MAX_PAGES) {
  const epsPayload = await jikanGet(`/anime/${id}/episodes`, { page });
  if (Array.isArray(epsPayload.data)) episodes.push(...epsPayload.data);
  const pag = epsPayload.pagination || {};
  hasNext = Boolean(pag.has_next_page);
  page += 1;
}

const episodesSimplified = episodes.map(ep => ({
  number: typeof ep.mal_id === 'number' ? ep.mal_id : (typeof ep.episode === 'number' ? ep.episode : ep?.number ?? null),
  title: ep.title || ep.title_romanji || ep.title_japanese || ep.title_romanized || null,
  aired: ep.aired || null,
  filler: ep.filler ?? false,
  recap: ep.recap ?? false,
  url: ep.url || null,
})).filter(e => e.number != null);

const epMap = buildEpisodesMap(episodes);

const result = {
  ...base,
  seasons, // best-effort related entries representing franchise seasons/spinoffs
  episodes: {
    count: episodesSimplified.length,
    items: episodesSimplified,
    map: epMap,
  },
};

setCache(cacheKey, result);
res.json(result);

} catch (e) { res.status(e.status || 500).json({ error: e.message, details: e.details || null }); } });

// 404 app.use((req, res) => { res.status(404).json({ error: 'Not Found' }); });

// Error handler app.use((err, req, res, next) => { console.error('Unhandled error:', err); res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' }); });

app.listen(PORT, () => { console.log(Server listening on http://localhost:${PORT}); });

