"use strict";

/**
 * Serveur central — prototype « Vote 2026 ».
 *
 * Implémente le contrat d'API du plan (§7.6) avec le module http natif :
 *   - séparation autorisation / bulletin par jeton à usage unique ;
 *   - compteurs persistés sur disque (reprise après redémarrage) ;
 *   - invariant d'intégrité : somme des compteurs = nombre d'électeurs ayant voté.
 *
 * Aucune dépendance externe : lancer avec « node server.js ».
 */

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const CONFIG = {
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || "127.0.0.1",
  adminKey: process.env.ADMIN_KEY || "admin-2026-demo",
  tokenTtlMs: 150_000,
  dataDir: path.join(__dirname, "data"),
  publicDir: path.join(__dirname, "public"),
};

const URNE_FILE = path.join(CONFIG.dataDir, "urne.json");
const STATE_FILE = path.join(CONFIG.dataDir, "state.json");
const CANDIDATES_FILE = path.join(CONFIG.dataDir, "candidates.json");

// ---------------------------------------------------------------------------
// État en mémoire + persistance
// ---------------------------------------------------------------------------

const sessions = new Map();        // token -> { candidateId, expiresAt }
const consumedTokens = new Set();  // anneau d'idempotence des jetons déjà traités
const CONSUMED_RING = 64;

const audit = {
  AUTH_OK: 0, AUTH_CLOSED: 0, VOTE_OK: 0, VOTE_REPLAY: 0,
  TOKEN_EXPIRED: 0, TOKEN_UNKNOWN: 0, AUTH_401: 0, BOOT: 0,
};

let candidatesData = readJson(CANDIDATES_FILE, { candidates: [], registered: 0 });
let registered = Number(candidatesData.registered) || 0;
const candidates = candidatesData.candidates;
const candidateIds = new Set(candidates.map((c) => c.id));

let tally = emptyTally();
let votedCount = 0;
let poll = "CLOSED";

loadPersistedState();
audit.BOOT += 1;

function emptyTally() {
  const t = {};
  for (const c of candidates) t[c.id] = 0;
  return t;
}

function loadPersistedState() {
  const urne = readJson(URNE_FILE, null);
  if (urne && urne.tally) {
    for (const id of Object.keys(tally)) {
      tally[id] = Number(urne.tally[id]) || 0;
    }
    votedCount = Number(urne.votedCount) || sumTally();
  }
  const state = readJson(STATE_FILE, null);
  if (state && (state.poll === "OPEN" || state.poll === "CLOSED")) {
    poll = state.poll;
  }
}

function persistUrne() {
  writeJson(URNE_FILE, { tally, votedCount });
}

function persistState() {
  writeJson(STATE_FILE, { poll });
}

function sumTally() {
  return Object.values(tally).reduce((a, b) => a + b, 0);
}

// ---------------------------------------------------------------------------
// Utilitaires HTTP
// ---------------------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 4096) reject(new Error("corps trop volumineux"));
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("JSON invalide"));
      }
    });
    req.on("error", reject);
  });
}

function isAdmin(req) {
  const header = req.headers["authorization"] || "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const given = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(CONFIG.adminKey);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function rememberConsumed(token) {
  consumedTokens.add(token);
  if (consumedTokens.size > CONSUMED_RING) {
    const oldest = consumedTokens.values().next().value;
    consumedTokens.delete(oldest);
  }
}

// ---------------------------------------------------------------------------
// Logique métier
// ---------------------------------------------------------------------------

function buildResults() {
  return {
    poll,
    participation: { voted: votedCount, registered },
    tally: candidates.map((c) => ({ id: c.id, label: c.label, count: tally[c.id] })),
    integrity: { gap: sumTally() - votedCount },
  };
}

function handleAuth(res) {
  if (poll !== "OPEN") {
    audit.AUTH_CLOSED += 1;
    return sendJson(res, 403, { status: "REFUSE", reason: "POLL_CLOSED" });
  }
  const token = crypto.randomBytes(16).toString("hex");
  sessions.set(token, { candidateId: null, expiresAt: Date.now() + CONFIG.tokenTtlMs });
  audit.AUTH_OK += 1;
  return sendJson(res, 200, { status: "AUTORISE", token, ttl_s: CONFIG.tokenTtlMs / 1000 });
}

function handleVote(res, body) {
  const token = String(body.token || "");
  const candidateId = Number(body.candidate_id);

  if (consumedTokens.has(token)) {
    audit.VOTE_REPLAY += 1;
    return sendJson(res, 200, { status: "DEJA_ENREGISTRE" });
  }
  if (poll !== "OPEN") {
    return sendJson(res, 403, { status: "REFUSE", reason: "POLL_CLOSED" });
  }
  const session = sessions.get(token);
  if (!session) {
    audit.TOKEN_UNKNOWN += 1;
    return sendJson(res, 404, { status: "REFUSE", reason: "TOKEN_UNKNOWN" });
  }
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    audit.TOKEN_EXPIRED += 1;
    return sendJson(res, 410, { status: "REFUSE", reason: "TOKEN_EXPIRED" });
  }
  if (!candidateIds.has(candidateId)) {
    return sendJson(res, 400, { status: "REFUSE", reason: "BAD_CANDIDATE" });
  }

  tally[candidateId] += 1;
  votedCount += 1;
  sessions.delete(token);
  rememberConsumed(token);
  persistUrne();
  audit.VOTE_OK += 1;
  return sendJson(res, 200, { status: "ENREGISTRE" });
}

function handleCancel(res, body) {
  sessions.delete(String(body.token || ""));
  return sendJson(res, 200, { status: "ANNULE" });
}

function handleSetPoll(res, body) {
  const state = body.state;
  if (state !== "OPEN" && state !== "CLOSED") {
    return sendJson(res, 400, { error: "state doit valoir OPEN ou CLOSED" });
  }
  poll = state;
  persistState();
  return sendJson(res, 200, { poll });
}

function handleReset(res) {
  tally = emptyTally();
  votedCount = 0;
  sessions.clear();
  consumedTokens.clear();
  persistUrne();
  return sendJson(res, 200, { status: "RESET" });
}

// ---------------------------------------------------------------------------
// Fichiers statiques
// ---------------------------------------------------------------------------

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "/vote.html" : pathname;
  const target = path.join(CONFIG.publicDir, path.normalize(rel));
  if (!target.startsWith(CONFIG.publicDir)) {
    res.writeHead(403).end("Accès refusé");
    return;
  }
  fs.readFile(target, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Introuvable");
      return;
    }
    res.writeHead(200, { "Content-Type": (MIME[path.extname(target)] || "application/octet-stream") + "; charset=utf-8" });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Routage
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;
  const method = req.method;

  if (method === "GET" && pathname === "/api/v1/health") {
    return sendJson(res, 200, {
      status: "OK", version: "1.0.0", poll,
      uptime_s: Math.round(process.uptime()),
      freeMem_kb: Math.round(process.memoryUsage().rss / 1024),
    });
  }
  if (method === "GET" && pathname === "/api/v1/candidates") {
    return sendJson(res, 200, { candidates });
  }

  if (pathname.startsWith("/api/v1/")) {
    let body = {};
    if (method === "POST") {
      try {
        body = await readBody(req);
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (method === "POST" && pathname === "/api/v1/auth") return handleAuth(res);
    if (method === "POST" && pathname === "/api/v1/vote") return handleVote(res, body);
    if (method === "POST" && pathname === "/api/v1/session/cancel") return handleCancel(res, body);

    if (pathname.startsWith("/api/v1/admin/")) {
      if (!isAdmin(req)) {
        audit.AUTH_401 += 1;
        return sendJson(res, 401, { error: "Clé d'administration absente ou invalide" });
      }
      if (method === "GET" && pathname === "/api/v1/admin/results") return sendJson(res, 200, buildResults());
      if (method === "POST" && pathname === "/api/v1/admin/poll") return handleSetPoll(res, body);
      if (method === "GET" && pathname === "/api/v1/admin/audit") {
        return sendJson(res, 200, { poll, integrity: buildResults().integrity, events: audit });
      }
      if (method === "POST" && pathname === "/api/v1/admin/reset") return handleReset(res);
    }

    return sendJson(res, 404, { error: "Route inconnue" });
  }

  if (method === "GET") return serveStatic(req, res, pathname);
  res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" }).end("Méthode non autorisée");
});

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`Serveur Vote 2026 — http://${CONFIG.host}:${CONFIG.port}`);
  console.log(`  Vote        : http://${CONFIG.host}:${CONFIG.port}/vote.html`);
  console.log(`  Administration : http://${CONFIG.host}:${CONFIG.port}/admin.html`);
  console.log(`  Scrutin au démarrage : ${poll}`);
});

// ---------------------------------------------------------------------------
// Entrées/sorties JSON tolérantes
// ---------------------------------------------------------------------------

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  try {
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
  } catch (e) {
    console.error(`Écriture impossible (${file}) : ${e.message}`);
  }
}
