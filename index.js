import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
app.use(cors());

app.get("/", (req, res) => {
  res.send("Servidor Tipster funcionando ✔️");
});

// ---- EJEMPLO API FOOTBALL ----
app.get("/match", async (req, res) => {
  try {
    const response = await axios.get("https://v3.football.api-sports.io/fixtures", {
      headers: {
        "x-apisports-key": "TU_API_KEY_AQUI" 
      },
      params: {
        league: 39,
        season: 2023,
        round: 1
      }
    });

    res.json(response.data);

  } catch (error) {
    res.json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor corriendo en puerto " + PORT));