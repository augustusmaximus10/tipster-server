import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
app.use(cors());

app.get("/", (req, res) => {
  res.send("Servidor Tipster funcionando ✔");
});

// ---- API FOOTBALL ----
app.get("/match", async (req, res) => {
  try {
    const response = await axios.get("https://v3.football.api-sports.io/fixtures", {
      headers: {
        "x-apisports-key": process.env.API_KEY,
        "x-rapidapi-host": "v3.football.api-sports.io"
      },
      params: {
        league: 39,
        season: 2023,
        round: 1
      }
    });

    res.json(response.data);

  } catch (error) {
    console.error("API Error:", error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor corriendo en puerto " + PORT));