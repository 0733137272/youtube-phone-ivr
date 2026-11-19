const { createClient } = require('@libsql/client');
const fs = require('fs');
const path = require('path');

let client = null;
let localFtsClient = null;

function getDb() {
  if (!client) {
    client = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  }
  return client;
}

function getLocalFtsDb() {
  if (!localFtsClient) {
    const dbPath = path.join(__dirname, '..', 'data', 'yutfri_index.db');
    if (fs.existsSync(dbPath)) {
      localFtsClient = createClient({ url: `file:${dbPath}` });
    }
  }
  return localFtsClient;
}

async function initDb() {
  const db = getDb();
  await db.batch([
    `CREATE TABLE IF NOT EXISTS channels (
      channel_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      uploads_playlist_id TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      added_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_indexed_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS videos (
      video_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      title TEXT NOT NULL,
      norm_title TEXT NOT NULL,
      duration_sec INTEGER DEFAULT 0,
      published_at TEXT,
      view_count INTEGER DEFAULT 0,
      cached_path TEXT,
      play_count INTEGER DEFAULT 0,
      indexed_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT NOT NULL,
      status TEXT DEFAULT 'queued',
      error TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS requests_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT DEFAULT CURRENT_TIMESTAMP,
      transcript TEXT,
      top_match TEXT,
      outcome TEXT
    )`,
  ], 'write');
}

const NOISE_WORDS = /\b(official|video|audio|lyrics|hd|4k|live|קליפ רשמי|הקליפ הרשמי|מילים|גרסה רשמית)\b/gi;

function normalizeText(str) {
  if (!str) return '';
  return str
    .replace(/[\u0591-\u05C7]/g, '') // remove Hebrew niqqud
    .replace(NOISE_WORDS, ' ')
    .replace(/[^\u0590-\u05FFa-zA-Z0-9\s]/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function extractVideoId(url) {
  const m = String(url || '').match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : String(url || '');
}

async function searchLocal(query, limit = 5) {
  const normQuery = normalizeText(query);
  if (!normQuery) return [];

  const tokens = normQuery.split(' ').filter((t) => t.length >= 2);
  if (tokens.length === 0) return [];

  const ftsDb = getLocalFtsDb();
  const tursoDb = getDb();

  // 1. Search the 427,759-video NetFree FTS5 database if available
  if (ftsDb) {
    const ftsMatch = tokens.map((t) => `"${t}"*`).join(' AND ');
    let rows = [];
    try {
      const ftsRes = await ftsDb.execute({
        sql: `SELECT url, title, channel FROM video_fts WHERE video_fts MATCH ? ORDER BY rank LIMIT ?`,
        args: [ftsMatch, limit * 3],
      });
      rows = ftsRes.rows;
    } catch (_) {}

    // Fallback to OR search if strict AND returned nothing
    if (rows.length === 0 && tokens.length > 1) {
      const ftsOrMatch = tokens.map((t) => `"${t}"*`).join(' OR ');
      try {
        const ftsRes = await ftsDb.execute({
          sql: `SELECT url, title, channel FROM video_fts WHERE video_fts MATCH ? ORDER BY rank LIMIT ?`,
          args: [ftsOrMatch, limit * 3],
        });
        rows = ftsRes.rows;
      } catch (_) {}
    }

    if (rows.length > 0) {
      const results = rows.slice(0, limit).map((r) => ({
        video_id: extractVideoId(r.url),
        title: r.title,
        channel_name: r.channel,
        cached_path: null,
      }));

      // Enrich with cached_path from Turso if already downloaded
      if (process.env.TURSO_DATABASE_URL) {
        const ids = results.map((r) => r.video_id);
        const placeholders = ids.map(() => '?').join(',');
        try {
          const cacheRes = await tursoDb.execute({
            sql: `SELECT video_id, cached_path FROM videos WHERE video_id IN (${placeholders}) AND cached_path IS NOT NULL`,
            args: ids,
          });
          const cacheMap = new Map(cacheRes.rows.map((r) => [r.video_id, r.cached_path]));
          for (const item of results) {
            if (cacheMap.has(item.video_id)) {
              item.cached_path = cacheMap.get(item.video_id);
            }
          }
        } catch (_) {}
      }
      return results;
    }
  }

  // 2. Fallback to Turso videos table
  const whereClauses = tokens.map(() => `(v.norm_title LIKE ? OR c.display_name LIKE ?)`).join(' OR ');
  const args = [];
  for (const t of tokens) {
    args.push(`%${t}%`, `%${t}%`);
  }

  const res = await tursoDb.execute({
    sql: `SELECT v.video_id, v.title, v.norm_title, v.duration_sec, v.view_count, v.cached_path, c.display_name AS channel_name
          FROM videos v
          JOIN channels c ON v.channel_id = c.channel_id
          WHERE c.enabled = 1 AND v.duration_sec BETWEEN 30 AND 720 AND (${whereClauses})
          LIMIT 100`,
    args,
  });

  // Score results by token overlap + exact substring + popularity
  const scored = res.rows.map((row) => {
    const haystack = `${row.norm_title} ${normalizeText(row.channel_name)}`;
    let score = 0;
    for (const t of tokens) {
      if (haystack.includes(t)) score += 1;
    }
    if (haystack.includes(normQuery)) score += 2;
    score += Math.min(Number(row.view_count || 0) / 1000000, 0.5);
    return { ...row, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

module.exports = { getDb, initDb, normalizeText, searchLocal };
