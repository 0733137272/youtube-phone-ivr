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

function rankResults(items, queryTokens, rawQuery) {
  const qLower = (rawQuery || '').toLowerCase().trim();
  const noiseKeywords = [
    'מילים', 'קריוקי', 'אקורדים', 'פסנתר', 'תווים', 'ווקאלי', 'ווקאלית',
    'רמיקס', 'remix', 'karaoke', 'piano', 'cover', 'קאבר', 'אינסטרומנטלי',
  ];

  return items.map((item) => {
    const tLower = (item.title || '').toLowerCase();
    const cLower = (item.channel_name || '').toLowerCase();
    let score = typeof item.rank === 'number' ? -item.rank : 0;

    // 1. Boost if singer / channel matches query tokens (official channel)
    for (const t of queryTokens) {
      if (cLower.includes(t)) score += 15;
    }

    // 2. Boost if exact raw query appears in title
    if (qLower && tLower.includes(qLower)) {
      score += 20;
    }

    // 3. Penalty for covers, lyrics, piano, karaoke, etc.
    for (const noise of noiseKeywords) {
      if (tLower.includes(noise)) {
        score -= 25;
      }
    }

    return { ...item, _score: score };
  }).sort((a, b) => b._score - a._score);
}

async function searchLocal(query, limit = 10) {
  const normQuery = normalizeText(query);
  if (!normQuery) return { totalCount: 0, results: [] };

  const tokens = normQuery.split(' ').filter((t) => t.length >= 2);
  if (tokens.length === 0) return { totalCount: 0, results: [] };

  const ftsDb = getLocalFtsDb();
  const tursoDb = getDb();

  // 1. Search the 427,759-video NetFree FTS5 database if available
  if (ftsDb) {
    const ftsMatch = tokens.map((t) => `"${t}"*`).join(' AND ');
    let rows = [];
    let totalCount = 0;

    try {
      const countRes = await ftsDb.execute({
        sql: `SELECT count(*) as cnt FROM video_fts WHERE video_fts MATCH ?`,
        args: [ftsMatch],
      });
      totalCount = Number(countRes.rows[0]?.cnt || 0);

      const ftsRes = await ftsDb.execute({
        sql: `SELECT url, title, channel, rank FROM video_fts WHERE video_fts MATCH ? ORDER BY rank LIMIT 50`,
        args: [ftsMatch],
      });
      rows = ftsRes.rows;
    } catch (_) {}

    // Fallback to OR search if strict AND returned nothing
    if (rows.length === 0 && tokens.length > 1) {
      const ftsOrMatch = tokens.map((t) => `"${t}"*`).join(' OR ');
      try {
        const countRes = await ftsDb.execute({
          sql: `SELECT count(*) as cnt FROM video_fts WHERE video_fts MATCH ?`,
          args: [ftsOrMatch],
        });
        totalCount = Number(countRes.rows[0]?.cnt || 0);

        const ftsRes = await ftsDb.execute({
          sql: `SELECT url, title, channel, rank FROM video_fts WHERE video_fts MATCH ? ORDER BY rank LIMIT 50`,
          args: [ftsOrMatch],
        });
        rows = ftsRes.rows;
      } catch (_) {}
    }

    if (rows.length > 0) {
      let rawItems = rows.map((r) => ({
        video_id: extractVideoId(r.url),
        title: r.title,
        channel_name: r.channel,
        rank: r.rank,
        cached_path: null,
      }));

      // Also prepend any newly synced songs from Turso matching all tokens
      if (process.env.TURSO_DATABASE_URL) {
        try {
          const tursoLikes = tokens.map(() => `norm_title LIKE ?`).join(' AND ');
          const tursoRes = await tursoDb.execute({
            sql: `SELECT video_id, title, cached_path FROM videos WHERE ${tursoLikes} AND title != video_id LIMIT 5`,
            args: tokens.map((t) => `%${t}%`),
          });
          const seen = new Set(rawItems.map((r) => r.video_id));
          for (const tr of tursoRes.rows) {
            if (!seen.has(tr.video_id)) {
              rawItems.unshift({
                video_id: tr.video_id,
                title: tr.title,
                channel_name: 'נטפרי - חדש',
                rank: -50, // high priority
                cached_path: tr.cached_path || null,
              });
              seen.add(tr.video_id);
              totalCount++;
            }
          }
        } catch (_) {}
      }

      // Re-rank to bring the absolute best official match to the top
      const ranked = rankResults(rawItems, tokens, query);
      const results = ranked.slice(0, limit);

      // Enrich top results with cached_path from Turso if already downloaded
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

      return { totalCount, results };
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
  return { totalCount: scored.length, results: scored.slice(0, limit) };
}

module.exports = { getDb, initDb, normalizeText, searchLocal };
