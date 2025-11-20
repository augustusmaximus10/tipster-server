// index.js — Motor predictivo completo (Poisson + heurística) // Requiere: axios, express, cors import express from "express"; import axios from "axios"; import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// Config
const API_BASE = "https://v3.football.api-sports.io";
const API_KEY = process.env.API_KEY;
if (!API_KEY) console.warn("WARNING: API_KEY no definida en env");

const DEFAULT_LAST = 10; // partidos a usar para promedios

// Helpers
function factorial(n) {
  if (n === 0) return 1;
  let f = 1;
  for (let i = 1; i <= n; i++) f *= i;
  return f;
}
function poissonP(k, lambda) {
  // protege contra lambda 0
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k); } function clamp01(x) { return Math.max(0, Math.min(1, x)); }

// Simple request wrapper to API-Football async function apiFootball(path, params = {}) {
  const resp = await axios.get(`${API_BASE}${path}`, {
    headers: {
      "x-apisports-key": API_KEY,
      "x-apisports-host": "v3.football.api-sports.io"
    },
    params
  });
  return resp.data;
}

// Fetch last N fixtures for a team (completed matches) async function fetchLastMatches(teamId, league = null, season = null, last = DEFAULT_LAST) {
  const params = { team: teamId, last };
  if (league) params.league = league;
  if (season) params.season = season;
  const data = await apiFootball("/fixtures", params);
  // keep only finished matches with goals
  return (data.response || []).filter(f => f.goals && (f.goals.home !== null && f.goals.away !== null)); }

// Compute averages and basic features from fixtures function calcTeamStats(fixtures, teamId) {
  let played = 0;
  let gf = 0, ga = 0;
  let gf_home = 0, ga_home = 0, cnt_home = 0;
  let gf_away = 0, ga_away = 0, cnt_away = 0;
  let xg_sum = 0, xga_sum = 0, xg_count = 0;
  let shots = 0, shots_on = 0, shots_count = 0;

  fixtures.forEach(f => {
    const isHome = f.teams.home.id === teamId;
    const teamGoals = isHome ? f.goals.home : f.goals.away;
    const oppGoals = isHome ? f.goals.away : f.goals.home;
    played++;
    gf += teamGoals; ga += oppGoals;
    if (isHome) { cnt_home++; gf_home += teamGoals; ga_home += oppGoals; }
    else { cnt_away++; gf_away += teamGoals; ga_away += oppGoals; }

    // xG si existe en evento -> f.statistics puede tener xG en algunos planes
    // API-Football v3 incluye statistics endpoint por fixture, pero aquí revisamos f.statistics si existe.
    if (f.statistics && Array.isArray(f.statistics)) {
      // buscar estadística 'Expected goals' o 'xG' - depende del plan
      // esto es un intento seguro; si no está, se ignora.
      f.statistics.forEach(stat => {
        if (stat && stat.team && stat.team.id === teamId && stat.type && stat.value != null) {
          // no asumir estructura: mejor dejarlo en blanco salvo que sepas qué campo viene
        }
      });
    }

    // Shots (si disponibles)
    if (f.statistics && f.statistics.length) {
      const teamStats = f.statistics.find(s => s.team && s.team.id === teamId);
      if (teamStats) {
        const st = teamStats.statistics || teamStats;
        if (st.shots) { shots += st.shots; shots_on += st.shots_on || 0; shots_count++; }
      }
    }
  });

  return {
    played,
    gf_avg: played ? gf / played : 0,
    ga_avg: played ? ga / played : 0,
    gf_home_avg: cnt_home ? gf_home / cnt_home : null,
    ga_home_avg: cnt_home ? ga_home / cnt_home : null,
    gf_away_avg: cnt_away ? gf_away / cnt_away : null,
    ga_away_avg: cnt_away ? ga_away / cnt_away : null,
    shots_avg: shots_count ? shots / shots_count : null,
    shots_on_avg: shots_count ? shots_on / shots_count : null
    // xG fields could be added if you enrich fixtures with statistics endpoint
  };
}

// Compute league averages (fallbacks)
async function fetchLeagueAverages(leagueId, season) {
  try {
    const resp = await apiFootball("/fixtures", { league: leagueId, season, last: 200 });
    const fixtures = resp.response || [];
    const total = fixtures.length || 1;
    let homeGoals = 0, awayGoals = 0;
    fixtures.forEach(f => { homeGoals += f.goals.home || 0; awayGoals += f.goals.away || 0; });
    return {
      avg_home_goals: homeGoals / total,
      avg_away_goals: awayGoals / total,
      avg_total_goals: (homeGoals + awayGoals) / total
    };
  } catch (e) {
    return { avg_home_goals: 1.35, avg_away_goals: 1.05, avg_total_goals: 2.4 };
  }
}

// Core predictor — devuelve objeto completo async function predictFull(homeId, awayId, leagueId = null, season = null, last = 10) {
  // fetch recent matches
  const [homeFixtures, awayFixtures] = await Promise.all([
    fetchLastMatches(homeId, leagueId, season, last),
    fetchLastMatches(awayId, leagueId, season, last)
  ]);

  const homeStats = calcTeamStats(homeFixtures, homeId);
  const awayStats = calcTeamStats(awayFixtures, awayId);

  const leagueAvg = (leagueId && season) ? await fetchLeagueAverages(leagueId, season) : { avg_home_goals: 1.35, avg_away_goals: 1.05, avg_total_goals: 2.4 };

  // Strengths (relative to league average)
  const attack_home = (homeStats.gf_avg && leagueAvg.avg_total_goals) ? (homeStats.gf_avg / leagueAvg.avg_total_goals) : 1;
  const defense_home = (homeStats.ga_avg && leagueAvg.avg_total_goals) ? (homeStats.ga_avg / leagueAvg.avg_total_goals) : 1;
  const attack_away = (awayStats.gf_avg && leagueAvg.avg_total_goals) ? (awayStats.gf_avg / leagueAvg.avg_total_goals) : 1;
  const defense_away = (awayStats.ga_avg && leagueAvg.avg_total_goals) ? (awayStats.ga_avg / leagueAvg.avg_total_goals) : 1;

  const home_advantage = 1.12; // tunable

  // Lambdas (goles esperados)
  const lambda_home = leagueAvg.avg_home_goals * attack_home * defense_away * home_advantage;
  const lambda_away = leagueAvg.avg_away_goals * attack_away * defense_home;

  // Construir distribuciones Poisson 0..5 (5+ acumulado)
  const maxGoals = 5;
  const pHome = new Array(maxGoals + 1).fill(0);
  const pAway = new Array(maxGoals + 1).fill(0);
  for (let k = 0; k <= maxGoals; k++) {
    pHome[k] = poissonP(k, lambda_home);
    pAway[k] = poissonP(k, lambda_away);
  }
  const tailH = 1 - pHome.reduce((s, x) => s + x, 0);
  const tailA = 1 - pAway.reduce((s, x) => s + x, 0);
  pHome[maxGoals] += tailH;
  pAway[maxGoals] += tailA;

  // Matriz de resultados por convolución
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

  // convertir a porcentajes 0-100 con 2 decimales
  const probs = { home: +(pHomeWin * 100).toFixed(2), draw: +(pDraw * 100).toFixed(2), away: +(pAwayWin * 100).toFixed(2) };
  const overs = Object.fromEntries(Object.entries(pOver).map(([k, v]) => [k, + (v * 100).toFixed(2)]));

  // Confidence heuristic:
  // Base = prob máxima. Ajuste por cantidad de partidos usados (más data -> más confianza)
  const maxProb = Math.max(pHomeWin, pDraw, pAwayWin);
  const dataFactor = clamp01(Math.min(homeStats.played, awayStats.played) / last); // 0..1
  // si lambdas son muy pequeños o igual, bajar confianza
  const lambdaFactor = clamp01((lambda_home + lambda_away) / 4); // approx max ~4
  let confidenceScore = maxProb * 0.8 + dataFactor * 0.1 + lambdaFactor * 0.1;
  // escala a 0-100
  const confidencePct = Math.round(confidenceScore * 100);

  // Recommendation logic (simple, transparente)
  let recommended = { outcome: null, reason: null, confidence: confidencePct };
  // If model gives a clear favorite with high confidence -> recommend single
  if (maxProb >= 0.75 && confidencePct >= 65) {
    recommended.outcome = probs.home === Math.max(probs.home, probs.draw, probs.away) ? "Home win" :
                          probs.away === Math.max(probs.home, probs.draw, probs.away) ? "Away win" : "Draw";
    recommended.reason = "Alta probabilidad modelo (>75%) y suficiente historial";
  } else if (maxProb >= 0.6 && confidencePct >= 55) {
    recommended.outcome = "Double chance on favorite";
    recommended.reason = "Probabilidad moderada (60%+) — sugerida doble oportunidad";
  } else if (overs["2.5"] >= 80) {
    recommended.outcome = "Over 2.5";
    recommended.reason = "Alta probabilidad de goles (>80%)";
  } else {
    recommended.outcome = "No clear value";
    recommended.reason = "Probabilidades no muestran edge claro";
  }

  return {
    meta: {
      homeStats, awayStats, leagueAvg: leagueAvg, lambda_home, lambda_away, expected_total_goals: +expected_total_goals.toFixed(2),
      used_last: last
    },
    distributions: { home: pHome.map(x => +(x * 100).toFixed(2)), away: pAway.map(x => +(x * 100).toFixed(2)) },
    probabilities: probs,
    over: overs,
    btts: + (pBTTS * 100).toFixed(2),
    confidence: confidencePct,
    recommended,
    explanation: {
      why: [
        "Modelo Poisson usando lambdas calculadas desde promedios recientes y fuerza relativa (attack/defense).",
        "Confidence combina máxima probabilidad con cantidad de datos y magnitud de lambdas."
      ]
    }
  };
}

// ROUTES

app.get("/", (req, res) => res.send("Servidor Tipster funcionando ✔️"));

// last5 endpoint
app.get("/last5", async (req, res) => {
  try {
    const team = req.query.team;
    if (!team) return res.status(400).json({ error: "team query param required" });
    const last = req.query.last ? parseInt(req.query.last) : 5;
    const league = req.query.league || null;
    const season = req.query.season || null;
    const data = await fetchLastMatches(team, league, season, last);
    res.json({ team, last, data });
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).json({ error: e.message });
  }
});

// predict_full endpoint
app.get("/predict_full", async (req, res) => {
  try {
    const home = req.query.home;
    const away = req.query.away;
    if (!home || !away) return res.status(400).json({ error: "home and away query params required" });
    const league = req.query.league || null;
    const season = req.query.season || null;
    const last = req.query.last ? parseInt(req.query.last) : DEFAULT_LAST;
    const out = await predictFull(parseInt(home), parseInt(away), league ? parseInt(league) : null, season ? parseInt(season) : null, last);
    res.json(out);
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).json({ error: e.message });
  }
});

// test route to show API key presence
app.get("/test", (req, res) => {
  res.json({ received_api_key: process.env.API_KEY ? "SI" : "NO", api_key_preview: process.env.API_KEY ? process.env.API_KEY.slice(0,4) + "***" : null }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor corriendo en puerto " + PORT));