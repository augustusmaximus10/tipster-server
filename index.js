import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// Config
const API_BASE = "https://v3.football.api-sports.io";
const API_KEY = process.env.API_KEY;

if (!API_KEY) console.warn("WARNING: API_KEY no definida en env");

const DEFAULT_LAST = 10;

// Helpers
function factorial(n) {
  if (n === 0) return 1;
  let f = 1;
  for (let i = 1; i <= n; i++) f *= i;
  return f;
}

function poissonP(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k);
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

// API wrapper
async function apiFootball(path, params = {}) {
  const resp = await axios.get(`${API_BASE}${path}`, {
    headers: {
      "x-apisports-key": API_KEY,
      "x-apisports-host": "v3.football.api-sports.io"
    },
    params
  });
  return resp.data;
}

// Last matches
async function fetchLastMatches(teamId, league = null, season = null, last = DEFAULT_LAST) {
  const params = { team: teamId, last };
  if (league) params.league = league;
  if (season) params.season = season;

  const data = await apiFootball("/fixtures", params);

  return (data.response || []).filter(
    f => f.goals && f.goals.home !== null && f.goals.away !== null
  );
}

// Stats calculation
function calcTeamStats(fixtures, teamId) {
  let played = 0;
  let gf = 0, ga = 0;
  let gf_home = 0, ga_home = 0, cnt_home = 0;
  let gf_away = 0, ga_away = 0, cnt_away = 0;

  fixtures.forEach(f => {
    const isHome = f.teams.home.id === teamId;
    const teamGoals = isHome ? f.goals.home : f.goals.away;
    const oppGoals = isHome ? f.goals.away : f.goals.home;

    played++;
    gf += teamGoals;
    ga += oppGoals;

    if (isHome) {
      cnt_home++;
      gf_home += teamGoals;
      ga_home += oppGoals;
    } else {
      cnt_away++;
      gf_away += teamGoals;
      ga_away += oppGoals;
    }
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

// League averages
async function fetchLeagueAverages(leagueId, season) {
  try {
    const resp = await apiFootball("/fixtures", {
      league: leagueId,
      season,
      last: 200
    });

    const fixtures = resp.response || [];
    const total = fixtures.length || 1;

    let homeGoals = 0, awayGoals = 0;
    fixtures.forEach(f => {
      homeGoals += f.goals.home || 0;
      awayGoals += f.goals.away || 0;
    });

    return {
      avg_home_goals: homeGoals / total,
      avg_away_goals: awayGoals / total,
      avg_total_goals: (homeGoals + awayGoals) / total
    };
  } catch (e) {
    return {
      avg_home_goals: 1.35,
      avg_away_goals: 1.05,
      avg_total_goals: 2.4
    };
  }
}

// Predictor
async function predictFull(homeId, awayId, leagueId = null, season = null, last = 10) {
  const [homeFixtures, awayFixtures] = await Promise.all([
    fetchLastMatches(homeId, leagueId, season, last),
    fetchLastMatches(awayId, leagueId, season, last)
  ]);

  const homeStats = calcTeamStats(homeFixtures, homeId);
  const awayStats = calcTeamStats(awayFixtures, awayId);

  const leagueAvg =
    leagueId && season
      ? await fetchLeagueAverages(leagueId, season)
      : { avg_home_goals: 1.35, avg_away_goals: 1.05, avg_total_goals: 2.4 };

  const attack_home = homeStats.gf_avg / leagueAvg.avg_total_goals;
  const defense_home = homeStats.ga_avg / leagueAvg.avg_total_goals;
  const attack_away = awayStats.gf_avg / leagueAvg.avg_total_goals;
  const defense_away = awayStats.ga_avg / leagueAvg.avg_total_goals;

  const home_advantage = 1.12;

  const lambda_home =
    leagueAvg.avg_home_goals * attack_home * defense_away * home_advantage;
  const lambda_away = leagueAvg.avg_away_goals * attack_away * defense_home;

  const maxGoals = 5;
  const pHome = new Array(maxGoals + 1).fill(0);
  const pAway = new Array(maxGoals + 1).fill(0);

  for (let k = 0; k <= maxGoals; k++) {
    pHome[k] = poissonP(k, lambda_home);
    pAway[k] = poissonP(k, lambda_away);
  }

  let pHomeWin = 0,
    pDraw = 0,
    pAwayWin = 0;

  let pOver = { "0.5": 0, "1.5": 0, "2.5": 0, "3.5": 0 };
  let pBTTS = 0;

  for (let i = 0; i <= maxGoals; i++) {
    for (let j = 0; j <= maxGoals; j++) {
      const prob = pHome[i] * pAway[j];

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

  const probs = {
    home: +(pHomeWin * 100).toFixed(2),
    draw: +(pDraw * 100).toFixed(2),
    away: +(pAwayWin * 100).toFixed(2)
  };

  const overs = Object.fromEntries(
    Object.entries(pOver).map(([k, v]) => [k, +(v * 100).toFixed(2)])
  );

  const confidencePct = Math.round(
    Math.max(pHomeWin, pDraw, pAwayWin) * 100
  );

  return {
    probabilities: probs,
    over: overs,
    btts: +(pBTTS * 100).toFixed(2),
    confidence: confidencePct
  };
}

// ROUTES
app.get("/", (req, res) =>
  res.send("Servidor Tipster funcionando ✔")
);

app.get("/last5", async (req, res) => {
  try {
    const team = req.query.team;
    if (!team)
      return res.status(400).json({ error: "team query param required" });

    const last = req.query.last ? parseInt(req.query.last) : 5;
    const data = await fetchLastMatches(team, null, null, last);

    res.json({ team, last, data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/predict_full", async (req, res) => {
  try {
    const home = req.query.home;
    const away = req.query.away;

    if (!home || !away)
      return res
        .status(400)
        .json({ error: "home and away query params required" });

    const out = await predictFull(
      parseInt(home),
      parseInt(away),
      null,
      null,
      DEFAULT_LAST
    );

    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/test", (req, res) => {
  res.json({
    received_api_key: process.env.API_KEY ? "SI" : "NO",
    api_key_preview: process.env.API_KEY
      ? process.env.API_KEY.slice(0, 4) + "*"
      : null
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("Servidor corriendo en puerto " + PORT)
);

