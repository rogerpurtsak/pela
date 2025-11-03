import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { logger } from "npm:hono/logger";
import * as kv from "./kv_store.ts";

const app = new Hono();

// --- CORS whitelist
const ALLOWED = new Set<string>(["http://localhost:5173", "https://pela.vercel.app", "https://pela.xyz"]);

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: (origin) => (origin && ALLOWED.has(origin) ? origin : false),
    allowHeaders: ["Content-Type", "Authorization", "x-client-info", "apikey", "X-Venue-Admin"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
  }),
);

async function sha256(s: string) {
  const enc = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// admin sessioni kontroll
async function requireAdmin(c: any, venueId: string) {
  const token = c.req.header("X-Venue-Admin") || c.req.header("x-venue-admin");
  if (!token) return false;
  const ok = await kv.get(`admin:sess:${venueId}:${token}`);
  return Boolean(ok);
}


// --- Loo alam-app ja defineeri KÕIK route’id selle peale:
const api = new Hono();

// juurtest
api.get("/", (c) => c.text("ok"));

// Health
api.get("/health", (c) => c.json({ status: "ok" }));

// Queue
api.get("/queue/:venueId", async (c) => {
  try {
    const venueId = c.req.param("venueId");
    const queueItems = await kv.getByPrefix(`queue:${venueId}:`);
    queueItems.sort((a: any, b: any) => (b.hype ?? 0) - (a.hype ?? 0));
    return c.json({ queue: queueItems });
  } catch (e) {
    console.error("Error fetching queue:", e);
    return c.json({ error: "Failed to fetch queue" }, 500);
  }
});

// Now playing
api.get("/now-playing/:venueId", async (c) => {
  try {
    const venueId = c.req.param("venueId");
    const nowPlaying = await kv.get(`nowplaying:${venueId}`);
    return c.json({ nowPlaying: nowPlaying || null });
  } catch (e) {
    console.error("Error fetching now playing:", e);
    return c.json({ error: "Failed to fetch now playing" }, 500);
  }
});

api.post("/play-next/:venueId", async (c) => {
  try {
    const venueId = c.req.param("venueId");
    if (!(await requireAdmin(c, venueId))) return c.json({ error: "Forbidden" }, 403);
    const deviceId = await kv.get(`spotify:device:${venueId}`);
    if (!deviceId) return c.json({ error: "No device selected for this venue" }, 400);

    // 1) vali järgmine lugu
    const items = await kv.getByPrefix(`queue:${venueId}:`);
    if (items.length === 0) return c.json({ error: "Queue empty" }, 400);
    items.sort((a: any, b: any) =>
      (b.hype ?? 0) - (a.hype ?? 0) || (a.addedAt ?? 0) - (b.addedAt ?? 0)
    );
    const next = items[0];
    const uri = next.uri || (next.spotifyId ? `spotify:track:${next.spotifyId}` : null);
    if (!uri) return c.json({ error: "Song has no Spotify URI/ID" }, 400);

    // 2) token + transfer + play
    const token = await getUserAccessTokenForVenue(venueId);

    await fetch("https://api.spotify.com/v1/me/player", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ device_ids: [deviceId], play: false }),
    });

    const r = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ uris: [uri], position_ms: 0 }),
    });
    if (!r.ok) {
      const t = await r.text();
      console.error("play failed:", t);
      return c.json({ error: "Failed to start playback" }, 500);
    }

    // 3) uuenda nowplaying ja eemalda queue'st
    await kv.set(`nowplaying:${venueId}`, {
      title: next.title,
      artist: next.artist,
      albumArt: next.albumArt,
      uri,
      startedAt: Date.now(),
      id: next.id,
    });
    await kv.del(`queue:${venueId}:${next.id}`);

    return c.json({ success: true });
  } catch (e) {
    console.error("play-next error:", e);
    return c.json({ error: "Failed to play next" }, 500);
  }
});


// Vote
api.post("/vote", async (c) => {
  try {
    const { venueId, songId, sessionId } = await c.req.json();
    if (!venueId || !songId || !sessionId) {
      return c.json({ error: "Missing required fields" }, 400);
    }
    const voteKey = `vote:${venueId}:${sessionId}:${songId}`;
    if (await kv.get(voteKey)) return c.json({ error: "Already voted for this song" }, 400);
    await kv.set(voteKey, true);

    const queueKey = `queue:${venueId}:${songId}`;
    const song = await kv.get(queueKey);
    if (!song) return c.json({ error: "Song not found in queue" }, 404);

    const updatedSong = { ...song, hype: (song.hype ?? 0) + 1 };
    await kv.set(queueKey, updatedSong);
    return c.json({ success: true, hype: updatedSong.hype });
  } catch (e) {
    console.error("Error voting for song:", e);
    return c.json({ error: "Failed to vote for song" }, 500);
  }
});

// Add song
api.post("/add-song", async (c) => {
  try {
    const { venueId, sessionId, song } = await c.req.json();
    if (!venueId || !sessionId || !song?.title || !song?.artist) {
      return c.json({ error: "Missing required fields" }, 400);
    }
    // === soovitus: nõua ka uri/spotifyId, või vähemalt salvesta kui olemas
    // if (!song?.uri && !song?.spotifyId) return c.json({ error: "Spotify URI/ID required" }, 400);

    // alles siis saab uue laulu lisada kui tal pole eelmist queues ja nowplayingus
    const sessionKey = `session:${venueId}:${sessionId}`;
    const session = await kv.get(sessionKey);

    // testimiseks 0
    const baseCooldownMs = venueId === 0;

    let enforceCooldown = false;
    let remainingMinutes = 0;

    if (session?.lastAddedAt) {
      const since = Date.now() - session.lastAddedAt;

      if (since < baseCooldownMs) {
        // Kontrolli, kas eelmine lugu on endiselt aktiivne (queue'is või now-playing)
        let prevStillActive = false;

        if (session.lastSongId) {
          const prevInQueue = await kv.get(`queue:${venueId}:${session.lastSongId}`);
          const nowP = await kv.get(`nowplaying:${venueId}`);
          prevStillActive = Boolean(prevInQueue) || nowP?.id === session.lastSongId;
        }

        if (prevStillActive) {
          enforceCooldown = true;
          remainingMinutes = Math.ceil((baseCooldownMs - since) / 60000);
        }
      }
    }

    if (enforceCooldown) {
      return c.json(
        { error: "Cooldown active", cooldownMinutes: remainingMinutes },
        429
      );
    }


    // kui uri/spotifyid pole antud siis proovi leida spotify otsinguga
    let trackUri: string | undefined = song.uri;
    let trackId: string | undefined = song.spotifyId;
    let albumArt: string | undefined = song.albumArt;

    if (!trackUri && !trackId) {
      const token = await getSpotifyAccessToken(); // sinu olemasolev client-credentials helper
      if (token) {
        const q = encodeURIComponent(`${song.title} ${song.artist}`);
        const sr = await fetch(
          `https://api.spotify.com/v1/search?q=${q}&type=track&limit=1`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (sr.ok) {
          const sd = await sr.json();
          const t = sd?.tracks?.items?.[0];
          if (t?.uri && t?.id) {
            trackUri = t.uri;
            trackId = t.id;
            if (!albumArt) albumArt = t.album?.images?.[0]?.url ?? "";
          }
        }
      }
    }
    const songId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const queueKey = `queue:${venueId}:${songId}`;
    const newSong = {
      id: songId,
      title: song.title,
      artist: song.artist,
      albumArt: albumArt ?? song.albumArt ?? "",
      uri: trackUri ?? (trackId ? `spotify:track:${trackId}` : undefined),
      spotifyId: trackId ?? undefined,
      hype: 0,
      addedAt: Date.now(),
    };
    await kv.set(queueKey, newSong);
    await kv.set(sessionKey, { venueId, sessionId, lastAddedAt: Date.now(), lastSongId: songId });
    return c.json({ success: true, song: newSong });
  } catch (e) {
    console.error("Error adding song to queue:", e);
    return c.json({ error: "Failed to add song to queue" }, 500);
  }
});


// === OAuth: login → callback ===

// DJ klikib "Connect Spotify" → suuname autoriseerima
api.get("/spotify/login", (c) => {
  const venueId = c.req.query("venueId");
  if (!venueId) return c.text("Missing venueId", 400);

  const clientId = Deno.env.get("SPOTIFY_CLIENT_ID")!;
  const redirectUri = Deno.env.get("SPOTIFY_REDIRECT_URI")!;
  const scopes = [
    "streaming",
    "user-read-playback-state",
    "user-modify-playback-state",
    "user-read-currently-playing",
  ].join(" ");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes,
    state: venueId, // seome venue
    // PKCE pole rangelt vajalik, kuna vahetame serveris
  });

  return c.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
});

// Too seadmete list (DJ UI-s kuvamiseks)
api.get("/spotify/devices/:venueId", async (c) => {
  const venueId = c.req.param("venueId");
  if (!(await requireAdmin(c, venueId))) return c.json({ error: "Forbidden" }, 403);
  const token = await getUserAccessTokenForVenue(venueId);
  const r = await fetch("https://api.spotify.com/v1/me/player/devices", {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) return c.json({ error: "Failed to fetch devices" }, 500);
  const data = await r.json();
  return c.json({ devices: data.devices ?? [] });
});

// Salvesta valitud device_id venuele
api.post("/spotify/select-device", async (c) => {
  try {
    const { venueId, deviceId } = await c.req.json();
  if (!venueId) return c.json({ error: "Missing venueId" }, 400);
  if (!(await requireAdmin(c, venueId))) return c.json({ error: "Forbidden" }, 403);
    await kv.set(`spotify:device:${venueId}`, deviceId);
    return c.json({ success: true });
  } catch (e) {
    console.error("select-device error:", e);
    return c.json({ error: "Failed to select device" }, 500);
  }
});


// Spotify kutsub siia ?code=...&state=<venueId>
api.get("/spotify/callback", async (c) => {
  try {
    const code = c.req.query("code");
    const venueId = c.req.query("state");
    if (!code || !venueId) return c.text("Missing code/state", 400);

    const clientId = Deno.env.get("SPOTIFY_CLIENT_ID")!;
    const clientSecret = Deno.env.get("SPOTIFY_CLIENT_SECRET")!;
    const redirectUri = Deno.env.get("SPOTIFY_REDIRECT_URI")!;

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    });

    const resp = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!resp.ok) {
      const t = await resp.text();
      console.error("token exchange failed:", t);
      return c.text("Token exchange failed", 500);
    }
    const data = await resp.json();

    // salvestame refresh tokeni venue külge
    await kv.set(`spotify:refresh:${venueId}`, {
      refresh_token: data.refresh_token,
      obtainedAt: Date.now(),
      scopesSaved: true,
    });

    // suuna DJ vaatesse tagasi (pane oma URL)
    return c.redirect(`http://localhost:5173/?venue=${venueId}&admin=true&linked=1`);
  } catch (e) {
    console.error("callback error:", e);
    return c.text("Callback error", 500);
  }
});

// set admin pin
api.post("/admin/set-pin", async (c) => {
  const { venueId, pin } = await c.req.json();
  if (!venueId || !pin) return c.json({ error: "Missing venueId/pin" }, 400);

  const exists = await kv.get(`admin:pin:${venueId}`);
  if (exists) return c.json({ error: "PIN already set" }, 400);

  const salt = crypto.randomUUID();
  const hash = await sha256(pin + ":" + salt);
  await kv.set(`admin:pin:${venueId}`, { hash, salt });
  return c.json({ success: true });
});

// login kontrollib pini
api.post("/admin/login", async (c) => {
  const { venueId, pin } = await c.req.json();
  if (!venueId || !pin) return c.json({ error: "Missing venueId/pin" }, 400);

  const rec = await kv.get(`admin:pin:${venueId}`);
  if (!rec?.hash || !rec?.salt) return c.json({ error: "PIN not set" }, 400);

  const hash = await sha256(pin + ":" + rec.salt);
  if (hash !== rec.hash) return c.json({ error: "Invalid PIN" }, 401);

  const sess = crypto.randomUUID();
  const ttlMs = 24 * 60 * 60 * 1000; // 24h
  await kv.set(`admin:sess:${venueId}:${sess}`, { createdAt: Date.now() }, { ttl: ttlMs });
  return c.json({ success: true, token: sess, expiresInMs: ttlMs });
});

// Logout
api.post("/admin/logout", async (c) => {
  const { venueId } = await c.req.json();
  const token = c.req.header("X-Venue-Admin") || c.req.header("x-venue-admin");
  if (!venueId || !token) return c.json({ error: "Missing venueId/token" }, 400);
  await kv.del(`admin:sess:${venueId}:${token}`);
  return c.json({ success: true });
});


// Spotify token helper
async function getSpotifyAccessToken(): Promise<string | null> {
  try {
    const cached = await kv.get("spotify:access_token");
    if (cached?.token && cached?.expiresAt > Date.now()) return cached.token;

    const clientId = Deno.env.get("SPOTIFY_CLIENT_ID");
    const clientSecret = Deno.env.get("SPOTIFY_CLIENT_SECRET");
    if (!clientId || !clientSecret) {
      console.error("Spotify credentials not configured");
      return null;
    }

    const resp = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      },
      body: "grant_type=client_credentials",
    });
    if (!resp.ok) {
      console.error("Failed to get Spotify token:", await resp.text());
      return null;
    }
    const { access_token, expires_in } = await resp.json();
    const expiresAt = Date.now() + (expires_in - 300) * 1000;
    await kv.set("spotify:access_token", { token: access_token, expiresAt });
    return access_token;
  } catch (e) {
    console.error("Error getting Spotify access token:", e);
    return null;
  }
}

// === USER TOKEN (Authorization Code) ===
async function getUserAccessTokenForVenue(venueId: string): Promise<string> {
  const r = await kv.get(`spotify:refresh:${venueId}`);
    if (!r?.refresh_token) throw new Error("Venue not linked to Spotify (no refresh token).");

    const clientId = Deno.env.get("SPOTIFY_CLIENT_ID")!;
    const clientSecret = Deno.env.get("SPOTIFY_CLIENT_SECRET")!;

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: r.refresh_token,
    });

    const resp = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": `Basic ${btoa(`${clientId}:${clientSecret}`)}`
      },
      body,
    });
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`refresh failed: ${t}`);
    }
    const data = await resp.json();
  return data.access_token as string;
}


// Spotify search
api.get("/search-spotify", async (c) => {
  try {
    const query = c.req.query("q");
    if (!query) return c.json({ error: "Query parameter required" }, 400);

    const key = "ratelimit:spotify:search";
    const rl = await kv.get(key);
    const now = Date.now();
    if (rl?.count && rl?.resetAt > now) {
      if (rl.count >= 60) {
        const wait = Math.ceil((rl.resetAt - now) / 1000);
        return c.json({ error: `Too many searches. Please wait ${wait} seconds.`, retryAfter: wait }, 429);
      }
      await kv.set(key, { count: rl.count + 1, resetAt: rl.resetAt });
    } else {
      await kv.set(key, { count: 1, resetAt: now + 60_000 });
    }

    const token = await getSpotifyAccessToken();
    if (!token) {
      return c.json({ error: "Spotify API not configured. Please add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET." }, 500);
    }

    const resp = await fetch(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=10`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!resp.ok) {
      const text = await resp.text();
      console.error("Spotify search failed:", text);
      if (resp.status === 401) {
        await kv.del("spotify:access_token");
        return c.json({ error: "Authentication expired. Please try again." }, 401);
      }
      return c.json({ error: "Failed to search Spotify" }, 500);
    }

    const data = await resp.json();
    const results = (data.tracks.items ?? []).map((t: any) => ({
      id: t.id,
      spotifyId: t.id,
      uri: t.uri,
      title: t.name,
      artist: t.artists.map((a: any) => a.name).join(", "),
      albumArt: t.album.images?.[0]?.url ?? "",
    }));

    return c.json({ results });
  } catch (e) {
    console.error("Error searching Spotify:", e);
    return c.json({ error: "Failed to search Spotify" }, 500);
  }
});

// igaks juhuks kui vaja web sdk aga muidu mingist apist
api.get("/spotify/user-token", async (c) => {
  const venueId = c.req.query("venueId");
  if (!venueId) return c.json({ error: "Missing venueId" }, 400);
  const access_token = await getUserAccessTokenForVenue(venueId);
  return c.json({ access_token });
});


// Init demo
api.post("/init-demo/:venueId", async (c) => {
  try {
    const venueId = c.req.param("venueId");
    const existing = await kv.getByPrefix(`queue:${venueId}:`);
    if (existing.length > 0) return c.json({ message: "Venue already initialized" });

    const demoSongs = [
      { id: "demo-1", title: "adore u", artist: "Fred again..", albumArt: "https://images.unsplash.com/photo-1571766752116-63b1e6514b53?w=300&h=300&fit=crop", hype: 127, addedAt: Date.now() - 1_000_000 },
      { id: "demo-2", title: "Heat Waves", artist: "Glass Animals", albumArt: "https://images.unsplash.com/photo-1622224408917-9dfb43de2cd4?w=300&h=300&fit=crop", hype: 89, addedAt: Date.now() - 800_000 },
      { id: "demo-3", title: "Parem veelgi", artist: "Tanel Padar", albumArt: "https://images.unsplash.com/photo-1629426958038-a4cb6e3830a0?w=300&h=300&fit=crop", hype: 56, addedAt: Date.now() - 600_000 },
      { id: "demo-4", title: "Blinding Lights", artist: "The Weeknd", albumArt: "https://images.unsplash.com/photo-1606224534096-fcd6bb9a2018?w=300&h=300&fit=crop", hype: 43, addedAt: Date.now() - 400_000 },
    ];
    for (const s of demoSongs) await kv.set(`queue:${venueId}:${s.id}`, s);
    await kv.set(`nowplaying:${venueId}`, {
      title: "Starboy",
      artist: "The Weeknd ft. Daft Punk",
      albumArt: "https://images.unsplash.com/photo-1571766752116-63b1e6514b53?w=300&h=300&fit=crop",
    });
    return c.json({ success: true, message: "Demo data initialized" });
  } catch (e) {
    console.error("Error initializing demo venue:", e);
    return c.json({ error: "Failed to initialize demo venue" }, 500);
  }
});

// M Ä N G I T A K S E  KAHEL TEEL: / ja /make-server-d5eddf57
app.route("/", api);
app.route("/make-server-d5eddf57", api);

Deno.serve(app.fetch);
