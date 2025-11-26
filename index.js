/**
 * index.js — Tipster PRO adapted to SportMonks v3 (keeps all modules/endpoints)
 *
 * Endpoints:
 *  - /            -> status + check API key
 *  - /api/*       -> generic proxy to SportMonks (keeps query params + api_token)
 *  - /match       -> example fixtures (league/season/round)
 *  - /last5       -> últimos N partidos de un equipo (SportMonks)
 *  - /predict     -> predictor rápido (últimos 5)
 *  - /predict_full-> predictor Poisson + heurística (más exhaustivo)
 *  - /test        -> muestra si la API key está presente
 *  - /debug_match -> muestra raw fixture (participants + scores) - useful for debugging
 *
 * Notes:
 *  - Expects env var API_KEY (or API_FOOTBALL_KEY) containing SportMonks api_token
 *  - This file preserves your original endpoints and improves compatibility with SportMonks v3
 */

import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.API_KEY || process.env.API_FOOTBALL_KEY || null;
const API_BASE = "https://api.sportmonks.com/v3/football";

// --- utilities --------------------------------------------------------------
function safeGetScoreObj(fixture) {
  if (!fixture) return null;
  const scores = fixture.scores || fixture.score || [];
  if (Array.isArray(scores) && scores.length) {
    const prefer = scores.find(s => /CURRENT|LIVE|FT|FULLTIME/i.test(s.description)) || scores[0];
    return prefer.score || null;
  } else if (typeof scores === "object" && scores !== null) {
    return scores;
  }
  return null;
}

function getHomeAwayFromFixture(fixture) {
  const homeP = fixture.participants?.find(p => p.meta?.location === "home") || fixture.participants?.find(p => /home/i.test(p.type || p.meta?.location || ""));
  const awayP = fixture.participants?.find(p => p.meta?.location === "away") || fixture.participants?.find(p => /away/i.test(p.type || p.meta?.location || ""));
  return { homeP, awayP };
}

function getGoalsFromFixture(fixture) {
  const scoreObj = safeGetScoreObj(fixture);
  const local = scoreObj?.localteam_score ?? scoreObj?.localteam_goals ?? scoreObj?.goals_home ?? scoreObj?.home ?? scoreObj?.goals;
  const visitor = scoreObj?.visitorteam_score ?? scoreObj?.visitorteam_goals ?? scoreObj?.goals_away ?? scoreObj?.away ?? 0;
  const homeGoals = typeof local === "number" ? local : (Number(local) || 0);
  const awayGoals = typeof visitor === "number" ? visitor : (Number(visitor) || 0);
  return { homeGoals, awayGoals };
}

// --- API wrapper -----------------------------------------------------------
async function apiFootball(path, params = {}) {
  if (!API_KEY) throw new Error("API_KEY not set");
  const normalizedPath = path.startsWith("/") ? path : "/" + path;
  const mergedParams = { ...params, api_token: API_KEY };
  const resp = await axios.get(`${API_BASE}${normalizedPath}`, { params: mergedParams, timeout: 15000 });
  return resp.data;
}

// --- Proxy helper ---------------------------------------------------------
function normalizePathForProxy(path) {
  return path.replace(/^\/+/, "");
}

// --- Routes ----------------------------------------------------------------
app.get("/", (req, res) => {
  if (!API_KEY) {
    return res.status(400).json({
      ok: false,
      message: "API key not found. Add API_KEY (SportMonks api_token) to environment variables."
    });
  }
  res.send("🔥 Servidor Tipster PRO funcionando — API key detectada 🔥");
});

app.get("/api/*", async (req, res) => {
  if (!API_KEY) return res.status(400).json({ ok: false, message: "API_KEY missing" });
  try {
    const rawPath = req.params[0] || "";
    const path = normalizePathForProxy(rawPath);
    const resp = await axios.get(`${API_BASE}/${path}`, {
      params: { ...req.query, api_token: API_KEY }
    });
    return res.json(resp.data);
  } catch (err) {
    return res.status(err.response?.status || 500).json({
      ok: false,
      message: err.message,
      details: err.response?.data || null
    });
  }
});

app.get("/debug_match", async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ ok: false, message: "use /debug_match?id=FIXTURE_ID" });
    const data = await apiFootball(`/fixtures/${id}`, { include: "participants;scores" });
    return res.json({ ok: true, data });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message, details: e.response?.data || null });
  }
});

app.get("/match", async (req, res) => {
  try {
    const params = {
      league: req.query.league,
      season: req.query.season,
      round: req.query.round,
      include: "participants;scores",
      per_page: req.query.per_page || 25
    };
    Object.keys(params).forEach(k => params[k] == null && delete params[k]);
    const data = await apiFootball("/fixtures", params);
    return res.json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message, details: e.response?.data || null });
  }
});

async function fetchLastMatches(teamId, league = null, season = null, last = 10) {
  const params = {
    filters: `team_id:${teamId}`,
    include: "participants;scores",
    per_page: last
  };
  if (league) params.filters += `;league_id:${league}`;
  if (season) params.filters += `;season_id:${season}`;
  const data = await apiFootball("/fixtures", params);
  return data.data || [];
}

function calcTeamStats(fixtures, teamId) {
  let played = 0;
  let gf = 0, ga = 0;
  let gf_home = 0, ga_home = 0, cnt_home = 0;
  let gf_away = 0, ga_away = 0, cnt_away = 0;

  fixtures.forEach(f => {
    const { homeP, awayP } = getHomeAwayFromFixture(f);
    const isHome = homeP?.id === teamId;
    const { homeGoals, awayGoals } = getGoalsFromFixture(f);

    const teamGoals = isHome ? homeGoals : (awayGoals || 0);
    const oppGoals = isHome ? (awayGoals || 0) : (homeGoals || 0);

    played++;
    gf += teamGoals;
    ga += oppGoals;

    if (isHome) { cnt_home++; gf_home += teamGoals; ga_home += oppGoals; }
    else { cnt_away++; gf_away += teamGoals; ga_away += oppGoals; }
  });

  return {
    played,
    gf_avg: played ? gf / played : 0,
    ga_avg: played ? ga / played : 0,
    gf_home_avg: cnt_home ? gf_home / cnt_home : null,
    ga_home_avg: cnt_home ? ga_home / cnt_home : null,
    gf_away_avg: cnt_away ? gf_away / cnt_away : null,
    ga_away_avg: cnt_away ? ga_away / cnt_away : null
  };
}

async function fetchLeagueAverages(leagueId, season) {
  try {
    const params = { league: leagueId, season, per_page: 200, include: "scores" };
    Object.keys(params).forEach(k => params[k] == null && delete params[k]);
    const resp = await apiFootball("/fixtures", params);
    const fixtures = resp.data || [];
    const total = fixtures.length || 1;
    let homeGoals = 0, awayGoals = 0;
    fixtures.forEach(f => {
      const { homeGoals: h, awayGoals: a } = getGoalsFromFixture(f);
      homeGoals += h || 0;
      awayGoals += a || 0;
    });
    return {
      avg_home_goals: homeGoals / total,
      avg_away_goals: awayGoals / total,
      avg_total_goals: (homeGoals + awayGoals) / total
    };
  } catch (e) {
    return { avg_home_goals: 1.35, avg_away_goals: 1.05, avg_total_goals: 2.4 };
  }
}

function factorial(n) { if (n === 0) return 1; let f = 1; for (let i = 1; i <= n; i++) f *= i; return f; }
function poissonP(k, lambda) { if (lambda <= 0) return k === 0 ? 1 : 0; return Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k); }
function clamp01(x) { return Math.max(0, Math.min(1, x)); }

async function predictFull(homeId, awayId, leagueId = null, season = null, last = 10) {
  const [homeFixtures, awayFixtures] = await Promise.all([
    fetchLastMatches(homeId, leagueId, season, last),
    fetchLastMatches(awayId, leagueId, season, last)
  ]);

  const homeStats = calcTeamStats(homeFixtures, homeId);
  const awayStats = calcTeamStats(awayFixtures, awayId);

  const leagueAvg = (leagueId && season) ? await fetchLeagueAverages(leagueId, season) : { avg_home_goals: 1.35, avg_away_goals: 1.05, avg_total_goals: 2.4 };

  const attack_home = homeStats.gf_avg && leagueAvg.avg_total_goals ? (homeStats.gf_avg / leagueAvg.avg_total_goals) : 1;
  const defense_home = homeStats.ga_avg && leagueAvg.avg_total_goals ? (homeStats.ga_avg / leagueAvg.avg_total_goals) : 1;
  const attack_away = awayStats.gf_avg && leagueAvg.avg_total_goals ? (awayStats.gf_avg / leagueAvg.avg_total_goals) : 1;
  const defense_away = awayStats.ga_avg && leagueAvg.avg_total_goals ? (awayStats.ga_avg / leagueAvg.avg_total_goals) : 1;

  const home_advantage = 1.12;

  const lambda_home = leagueAvg.avg_home_goals * attack_home * defense_away * home_advantage;
  const lambda_away = leagueAvg.avg_away_goals * attack_away * defense_home;

  const maxGoals = 5;
  const pHome = new Array(maxGoals + 1).fill(0);
  const pAway = new Array(maxGoals + 1).fill(0);
  for (let k = 0; k <= maxGoals; k++) { pHome[k] = poissonP(k, lambda_home); pAway[k] = poissonP(k, lambda_away); }
  const tailH = 1 - pHome.reduce((s, x) => s + x, 0);
  const tailA = 1 - pAway.reduce((s, x) => s + x, 0);
  pHome[maxGoals] += tailH; pAway[maxGoals] += tailA;

  let pHomeWin = 0, pDraw = 0, pAwayWin = 0;
  let pOver = { "0.5": 0, "1.5": 0, "2.5": 0, "3.5": 0 };
  let pBTTS = 0;
  let expected_total_goals = 0;

  for (let i = 0; i <= maxGoals; i++) {
    for (let j = 0; j <= maxGoals; j++) {
      const prob = pHome[i] * pAway[j];
      expected_total_goals += (i + j) * prob;
      if (i > j) pHomeWin += prob;
      else if (i === j) pDraw += prob;
      else pAwayWin += prob;
      const sum = i + j;
      if (sum > 0) pOver["0.5"] += prob;
      if (sum > 1) pOver["1.5"] += prob;
      if (sum > 2) pOver["2.5"] += prob;
      if (sum > 3) pOver["3.5"] += prob;
      if (i > 0 && j > 0) pBTTS += prob;
    }
  }

  const probs = { home: +(pHomeWin * 100).toFixed(2), draw: +(pDraw * 100).toFixed(2), away: +(pAwayWin * 100).toFixed(2) };
  const overs = Object.fromEntries(Object.entries(pOver).map(([k, v]) => [k, + (v * 100).toFixed(2)]));

  const maxProb = Math.max(pHomeWin, pDraw, pAwayWin);
  const dataFactor = clamp01(Math.min(homeStats.played, awayStats.played) / last);
  const lambdaFactor = clamp01((lambda_home + lambda_away) / 4);
  const confidencePct = Math.round((maxProb * 0.8 + dataFactor * 0.1 + lambdaFactor * 0.1) * 100);

  let recommended = { outcome: null, reason: null, confidence: confidencePct };
  if (maxProb >= 0.75 && confidencePct >= 65) {
    recommended.outcome = probs.home === Math.max(probs.home, probs.draw, probs.away) ? "Home win" : probs.away === Math.max(probs.home, probs.draw, probs.away) ? "Away win" : "Draw";
    recommended.reason = "Clear favorite with strong data (>75%).";
  } else if (maxProb >= 0.6 && confidencePct >= 55) {
    recommended.outcome = "Double chance on favorite";
    recommended.reason = "Moderate favorite — suggest double chance.";
  } else if (overs["2.5"] >= 80) {
    recommended.outcome = "Over 2.5";
    recommended.reason = "High probability of goals (>80%).";
  } else {
    recommended.outcome = "No clear value";
    recommended.reason = "No edge detected.";
  }

  return {
    meta: { homeStats, awayStats, leagueAvg, lambda_home, lambda_away, expected_total_goals: +expected_total_goals.toFixed(2), used_last: last },
    distributions: { home: pHome.map(x => +(x * 100).toFixed(2)), away: pAway.map(x => +(x * 100).toFixed(2)) },
    probabilities: probs,
    over: overs,
    btts: +(pBTTS * 100).toFixed(2),
    confidence: confidencePct,
    recommended
  };
}

function computeStatsFromFixtures(fixtures, teamId) {
  let wins = 0, draws = 0, losses = 0, goalsFor = 0, goalsAgainst = 0;
  fixtures.forEach(match => {
    const { homeP, awayP } = getHomeAwayFromFixture(match);
    const isHome = homeP?.id === teamId;
    const { homeGoals, awayGoals } = getGoalsFromFixture(match);

    const gf = isHome ? homeGoals : awayGoals;
    const ga = isHome ? awayGoals : homeGoals;
    goalsFor += gf; goalsAgainst += ga;
    if (gf > ga) wins++; else if (gf === ga) draws++; else losses++;
  });
  const games = fixtures.length || 1;
  return { games, wins, draws, losses, goalsFor, goalsAgainst, winRate: wins / games, avgFor: goalsFor / games, avgAgainst: goalsAgainst / games };
}

function miniPredict(statsHome, statsAway) {
  const homeScore = statsHome.winRate * 1.5 + statsHome.avgFor;
  const awayScore = statsAway.winRate * 1.5 + statsAway.avgFor;
  const total = homeScore + awayScore;
  return { home: +((homeScore / total) * 100).toFixed(2), away: +((awayScore / total) * 100).toFixed(2), draw: +(100 - ((homeScore / total) * 100 + (awayScore / total) * 100)).toFixed(2) };
}

app.get("/last5", async (req, res) => {
  try {
    const team = req.query.team;
    if (!team) return res.status(400).json({ error: "team query param required" });
    const last = req.query.last ? parseInt(req.query.last) : 5;
    const league = req.query.league || null;
    const season = req.query.season || null;
    const data = await fetchLastMatches(team, league, season, last);
    return res.json({ team, last, data });
  } catch (e) {
    return res.status(500).json({ error: e.message, details: e.response?.data || null });
  }
});

app.get("/predict", async (req, res) => {
  try {
    const { home, away } = req.query;
    if (!home || !away) return res.status(400).json({ error: "home & away required" });
    const last = 5;
    const [hf, af] = await Promise.all([ fetchLastMatches(home, null, null, last), fetchLastMatches(away, null, null, last) ]);
    const statsHome = computeStatsFromFixtures(hf, parseInt(home));
    const statsAway = computeStatsFromFixtures(af, parseInt(away));
    const pred = miniPredict(statsHome, statsAway);
    return res.json({ homeStats: statsHome, awayStats: statsAway, prediction: pred });
  } catch (e) {
    return res.status(500).json({ error: e.message, details: e.response?.data || null });
  }
});

app.get("/predict_full", async (req, res) => {
  try {
    const home = parseInt(req.query.home), away = parseInt(req.query.away);
    if (!home || !away) return res.status(400).json({ error: "home and away required" });
    const league = req.query.league ? parseInt(req.query.league) : null;
    const season = req.query.season ? parseInt(req.query.season) : null;
    const last = req.query.last ? parseInt(req.query.last) : 10;
    const out = await predictFull(home, away, league, season, last);
    return res.json(out);
  } catch (e) {
    return res.status(500).json({ error: e.message, details: e.response?.data || null });
  }
});

// ------------------------------------------------------
// /team/:name — Buscar equipo por nombre + últimos 5 partidos (SPORTMONKS)
// ------------------------------------------------------
app.get("/team/:name", async (req, res) => {
  try {
    const teamName = req.params.name;

    // 1. Buscar equipo con SportMonks
    const search = await apiFootball(`/teams?search=${teamName}`);

    if (!search.data || search.data.length === 0) {
      return res.status(404).json({ ok: false, message: "Equipo no encontrado" });
    }

    // SportMonks regresa datos dentro de "data"
    const team = search.data[0];
    const teamId = team.id;

    // 2. Obtener últimos 5 partidos
    const lastMatches = await fetchLastMatches(teamId, null, null, 5);

    // 3. Respuesta final
    return res.json({
      ok: true,
      team: {
        id: team.id,
        name: team.name,
        shortCode: team.short_code || null,
        logo: team.logo_path || team.image_path || null,
        country: team.country?.name || null,
        league: team.league?.name || null,
      },
      last5: lastMatches
    });

  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message,
      details: e.response?.data || null
    });
  }
});

app.get("/test", (req, res) => {
  return res.json({ received_api_key: API_KEY ? "SI" : "NO", api_key_preview: API_KEY ? (API_KEY.slice(0,4) + "") : null });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor Tipster PRO corriendo en puerto " + PORT));










