import express from "express";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";

import { createServer as createViteServer } from "vite";
import { initDiscordBot, getAvailableVoiceChannels, isDiscordConnected } from "./discordBot.js";

dotenv.config();

process.on('uncaughtException', (err: any) => {
  const errStr = err ? (err.message || String(err)) : '';
  if (errStr.includes('Cannot perform IP discovery') || errStr.includes('socket closed')) {
    console.log(`[Voice Connection Diagnostics] Handled anticipated Voice Connection uncaught exception cleanly (UDP IP discovery restricted inside Google Cloud Run/Sandbox environment).`);
    return;
  }
  console.error('UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (reason: any, promise) => {
  const reasonStr = reason ? (reason.message || String(reason)) : '';
  if (reasonStr.includes('Cannot perform IP discovery') || reasonStr.includes('socket closed')) {
    console.log(`[Voice Connection Diagnostics] Handled anticipated Voice Connection unhandled rejection cleanly (UDP IP discovery restricted inside Google Cloud Run/Sandbox environment).`);
    return;
  }
  console.error('UNHANDLED REJECTION at:', promise, 'reason:', reason);
});

// Global in-memory schedule for simplicity across the Applet.
export const globalSettings = {
  voiceLang: "en",
  youtubeCookie: ""
};

const PREFS_FILE = path.join(process.cwd(), '.discord-prefs.json');
try {
  if (fs.existsSync(PREFS_FILE)) {
    const prefs = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf-8'));
    if (prefs.token) {
      process.env.DISCORD_TOKEN = prefs.token;
    }
    if (prefs.musicToken) {
      process.env.DISCORD_MUSIC_TOKEN = prefs.musicToken;
    }
    if (prefs.settings) {
      Object.assign(globalSettings, prefs.settings);
    }
  }
} catch (e) {
  console.error("Failed to read prefs:", e);
}

function savePrefs() {
  try {
    const data = {
      token: process.env.DISCORD_TOKEN,
      musicToken: process.env.DISCORD_MUSIC_TOKEN,
      settings: globalSettings
    };
    fs.writeFileSync(PREFS_FILE, JSON.stringify(data, null, 2));

    // Also write to .env for fallback local development persistence
    const envPath = path.join(process.cwd(), '.env');
    let envLines: string[] = [];
    if (fs.existsSync(envPath)) {
      envLines = fs.readFileSync(envPath, 'utf8').split('\n');
    }

    const tKey = 'DISCORD_TOKEN';
    const mKey = 'DISCORD_MUSIC_TOKEN';
    const tVal = `DISCORD_TOKEN="${process.env.DISCORD_TOKEN || ''}"`;
    const mVal = `DISCORD_MUSIC_TOKEN="${process.env.DISCORD_MUSIC_TOKEN || ''}"`;

    let tFound = false;
    let mFound = false;

    envLines = envLines.map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith(`${tKey}=`)) {
        tFound = true;
        return tVal;
      }
      if (trimmed.startsWith(`${mKey}=`)) {
        mFound = true;
        return mVal;
      }
      return line;
    });

    if (!tFound) {
      envLines.push(tVal);
    }
    if (!mFound) {
      envLines.push(mVal);
    }

    fs.writeFileSync(envPath, envLines.join('\n').trim() + '\n', 'utf8');
  } catch (e) {
    console.error("Failed to write prefs:", e);
  }
}

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  
  app.use(express.json({ limit: '50mb' }));

  // Security Middleware removed as basic auth is handled by CloudPanel.

  // API to get settings
  app.get("/api/settings", (req, res) => {
    res.json(globalSettings);
  });

  // API to update settings
  app.post("/api/settings", async (req, res) => {
    if (typeof req.body.voiceLang === 'string') {
      globalSettings.voiceLang = req.body.voiceLang;
    }
    if (typeof req.body.youtubeCookie === 'string') {
      globalSettings.youtubeCookie = req.body.youtubeCookie;
      try {
        const { applyYoutubeCookie } = await import("./discordMusicBot.js");
        await applyYoutubeCookie(req.body.youtubeCookie);
      } catch (err: any) {
        console.error("Failed to propagate YouTube cookie to music bot:", err.message || err);
      }
    }
    savePrefs();
    res.json({ success: true, settings: globalSettings });
  });

  // API to get discord voice channels
  app.get("/api/discord/channels", (req, res) => {
    res.json(getAvailableVoiceChannels());
  });

  // API to query connection status
  app.get("/api/discord/status", (req, res) => {
    res.json({ connected: isDiscordConnected() });
  });

  app.get("/api/discord-music/status", async (req, res) => {
    const { isDiscordMusicConnected } = await import("./discordMusicBot.js");
    res.json({ connected: isDiscordMusicConnected() });
  });

  // API to connect externally
  app.post("/api/discord/connect", async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "Token is required" });
    
    try {
      await initDiscordBot(globalSettings, token);
      
      process.env.DISCORD_TOKEN = token;
      savePrefs();

      res.json({ success: true, message: "Connected to Discord successfully!" });
    } catch (err: any) {
      res.status(400).json({ error: "Failed to connect: " + err.message });
    }
  });

  app.post("/api/discord-music/connect", async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "Token is required" });
    
    try {
      const { initDiscordMusicBot, applyYoutubeCookie } = await import("./discordMusicBot.js");
      if (globalSettings.youtubeCookie) {
        await applyYoutubeCookie(globalSettings.youtubeCookie);
      }
      await initDiscordMusicBot(token);
      
      process.env.DISCORD_MUSIC_TOKEN = token;
      savePrefs();

      res.json({ success: true, message: "Music Bot connected to Discord successfully!" });
    } catch (err: any) {
      res.status(400).json({ error: "Failed to connect Music Bot: " + err.message });
    }
  });

  // API to disconnect and disengage of token conflict
  app.post("/api/discord/disconnect", async (req, res) => {
    try {
      const { stopDiscordBot } = await import("./discordBot.js");
      stopDiscordBot();
      process.env.DISCORD_TOKEN = "";
      savePrefs();
      res.json({ success: true, message: "Discord bot stopped successfully and session disengaged." });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to disengage bot: " + err.message });
    }
  });

  app.post("/api/discord-music/disconnect", async (req, res) => {
    try {
      const { stopDiscordMusicBot } = await import("./discordMusicBot.js");
      stopDiscordMusicBot();
      process.env.DISCORD_MUSIC_TOKEN = "";
      savePrefs();
      res.json({ success: true, message: "Discord music bot stopped successfully." });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to disengage music bot: " + err.message });
    }
  });

  app.post("/api/discord-music/volume", async (req, res) => {
    try {
      const { setGlobalMusicVolume } = await import("./discordMusicBot.js");
      const { volume } = req.body;
      if (typeof volume === 'number') {
        setGlobalMusicVolume(volume / 100);
        res.json({ success: true });
      } else {
        res.status(400).json({ error: "Invalid volume" });
      }
    } catch (err: any) {
      res.status(500).json({ error: "Failed to set volume: " + err.message });
    }
  });

  app.get("/api/discord-music/volume", async (req, res) => {
    try {
      const { getGlobalMusicVolume } = await import("./discordMusicBot.js");
      res.json({ volume: Math.round(getGlobalMusicVolume() * 100) });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to get volume: " + err.message });
    }
  });

  app.get("/api/discord-music/helptext", async (req, res) => {
    try {
      const { getCustomHelpText } = await import("./discordMusicBot.js");
      res.json({ helpText: getCustomHelpText() });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to get help text: " + err.message });
    }
  });

  app.post("/api/discord-music/helptext", async (req, res) => {
    try {
      const { setCustomHelpText } = await import("./discordMusicBot.js");
      const { helpText } = req.body;
      if (typeof helpText === 'string') {
        setCustomHelpText(helpText);
        res.json({ success: true, helpText });
      } else {
        res.status(400).json({ error: "Invalid text" });
      }
    } catch (err: any) {
      res.status(500).json({ error: "Failed to set help text: " + err.message });
    }
  });

  app.post("/api/discord/test", async (req, res) => {
    try {
      const { testVoice } = await import("./discordBot.js");
      const { channelId, lang, text } = req.body;
      if (!channelId) return res.status(400).json({ error: "Missing channelId" });
      
      await testVoice(channelId, lang || 'en', text);
      res.json({ success: true, message: "Test voice requested." });
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ error: err.message, stack: err.stack });
    }
  });

  // Catch-all for API routes to prevent Vite SPA fallback from returning HTML
  app.use("/api", (req, res) => {
    res.status(404).json({ error: "API endpoint not found: " + req.method + " " + req.url });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  // Initialize Discord Bot
  if (process.env.DISCORD_TOKEN) {
    initDiscordBot(globalSettings, undefined, true).then(() => {
      console.log("Discord bot successfully initialized on startup.");
    }).catch((e: any) => {
      console.log("Note: Discord bot startup initialization skipped or bypassed.");
    });
  } else {
    console.log("DISCORD_TOKEN environment variable is not set. Discord features are disabled.");
  }
  
  if (process.env.DISCORD_MUSIC_TOKEN) {
    import("./discordMusicBot.js").then(async ({ initDiscordMusicBot, applyYoutubeCookie }) => {
      if (globalSettings.youtubeCookie) {
        await applyYoutubeCookie(globalSettings.youtubeCookie);
      }
      initDiscordMusicBot(undefined, true).then(() => {
        console.log("Discord music bot successfully initialized on startup.");
      }).catch((e: any) => {
        console.log("Note: Discord music bot startup initialization skipped or bypassed.");
      });
    }).catch((e: any) => {
      console.log("Note: Failed to import or initialize discord music bot on startup:", e.message || e);
    });
  }
}

startServer();
