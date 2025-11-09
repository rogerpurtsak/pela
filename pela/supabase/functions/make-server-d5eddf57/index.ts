// functions/make-server-d5eddf57/index.ts
import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { logger } from "npm:hono/logger";
import * as kv from "./kv_store.ts";

// ———————————————————————————————————————————————————————————
// APP + CORS
// ———————————————————————————————————————————————————————————
const app = new Hono();

// CORS whitelist (täienda vajadusel)
const ALLOWED = new Set<string>([
  'http://localhost:5173',
  'https://pela-ivory.vercel.app',
  'https://pela.rjf.ee',
  'https://pela-lxq2p00is-rogerpurtsaks-projects.vercel.app',   
  'http://rjf.ee/pela',
]);

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: (origin) => (origin && ALLOWED.has(origin) ? origin : false),
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "x-client-info",
      "apikey",
      "X-Venue-Admin",
      "Origin",
      "Accept",
    ],
    allowMethods: ["GET", "POST", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
  }),
);
app.options("/*", (c) => c.body(null, 204));

// Kõik route’id koondame alam-app’i taha:
const api = new Hono();

// ———————————————————————————————————————————————————————————
// JUUR JA HEALTH
// ———————————————————————————————————————————————————————————
api.get("/", (c) => c.text("ok"));
api.get("/health", (c) => c.json({ status: "ok" }));

// ———————————————————————————————————————————————————————————
// QUEUE + NOW PLAYING + PLAY-NEXT
// ———————————————————————————————————————————————————————————

// GET /queue/:venueId — tagasta hype järgi sorditud järjekord
api.get("/queue/:venueId", async (c) => {
  try {
    const venueId = c.req.param("venueId");
    const queueItems = await kv.getByPrefix(`queue:${venueId}:`);
    queueItems.sort((a: any, b: any) => (b.hype ?? 0) - (a.hype ?? 0));
    c.header('Cache-Control', 'no-store');
    return c.json({ queue: queueItems });
  } catch (e) {
    console.error("Error fetching queue:", e);
    return c.json({ error: "Failed to fetch queue" }, 500);
  }
});

// GET /now-playing/:venueId — aktiivne lugu
api.get("/now-playing/:venueId", async (c) => {
  try {
    const venueId = c.req.param("venueId");
    const nowPlaying = await kv.get(`nowplaying:${venueId}`);
    c.header('Cache-Control', 'no-store');
    return c.json({ nowPlaying: nowPlaying || null });
  } catch (e) {
    console.error("now-playing error", e);
    return c.json({ error: "Failed to fetch now playing" }, 500);
  }
});

// POST /play-next/:venueId — valib hype järgi järgmise ja MÄNGIB Spotifys
api.post("/play-next/:venueId", async (c) => {
  try {
    const venueId = c.req.param("venueId");
    const check = await requireAdmin(c, venueId);
    if (!check.ok) return check.res;

    const deviceId = await kv.get(`spotify:device:${venueId}`);
    if (!deviceId) return c.json({ error: "No device selected for this venue" }, 400);

    const items = await kv.getByPrefix(`queue:${venueId}:`);
    if (items.length === 0) {
      await autoFillFromRecommendations(venueId);
      return c.json({ error: "Queue empty – tried auto-fill" }, 400);
    }

    items.sort(
      (a: any, b: any) =>
        (b.hype ?? 0) - (a.hype ?? 0) || (a.addedAt ?? 0) - (b.addedAt ?? 0),
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

    const r = await fetch(
      `https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(deviceId)}`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ uris: [uri], position_ms: 0 }),
      },
    );
    if (!r.ok && r.status !== 204) {
      const t = await r.text();
      console.error("play failed:", t);
      return c.json({ error: "Failed to start playback" }, 500);
    }

    let duration_ms: number | undefined = next.duration_ms;
    if (!duration_ms && next.spotifyId) {
      const catToken = await getSpotifyAccessToken();
      if (catToken) {
        const tr = await fetch(`https://api.spotify.com/v1/tracks/${next.spotifyId}`, {
          headers: { Authorization: `Bearer ${catToken}` },
        });
        if (tr.ok) {
          const td = await tr.json();
          duration_ms = td?.duration_ms;
        }
      }
    }

    await kv.set(`nowplaying:${venueId}`, {
      title: next.title,
      artist: next.artist,
      albumArt: next.albumArt,
      uri,
      id: next.id,
      spotifyId: next.spotifyId,
      duration_ms: duration_ms ?? null,
      startedAt: Date.now(),
    });

    await kv.del(`skip:votes:${venueId}:${next.id}`);

    await kv.del(`queue:${venueId}:${next.id}`);

    if (next.spotifyId) {
      const recent: string[] = (await kv.get(`recent:tracks:${venueId}`)) ?? [];
      const updated = [...recent, next.spotifyId].slice(-10);
      await kv.set(`recent:tracks:${venueId}`, updated);
    }

    return c.json({ success: true });
  } catch (e) {
    console.error("play-next error:", e);
    return c.json({ error: "Failed to play next" }, 500);
  }
});

api.get("/spotify/now/:venueId", async (c) => {
  try {
    const venueId = c.req.param("venueId");

    const token = await getUserAccessTokenForVenue(venueId);
    const r = await fetch("https://api.spotify.com/v1/me/player", {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (r.status === 204) {
      c.header('Cache-Control','no-store');
      return c.json({ is_playing: false, progress_ms: 0, duration_ms: 0, startedAt: null, item: null });
    }

    if (!r.ok) {
      const t = await r.text();
      console.error("me/player failed:", t);
      return c.json({ error: "Failed to read playback state" }, 500);
    }

    const d = await r.json();
    const is_playing = !!d?.is_playing;
    const progress_ms = d?.progress_ms ?? 0;
    const duration_ms = d?.item?.duration_ms ?? 0;

    const startedAt = is_playing ? Date.now() - progress_ms : null;

    c.header('Cache-Control','no-store');
    return c.json({
      is_playing,
      progress_ms,
      duration_ms,
      startedAt,
      item: d?.item ? {
        name: d.item.name,
        artists: (d.item.artists ?? []).map((a: any) => a.name).join(", "),
        albumArt: d.item.album?.images?.[0]?.url ?? "",
        uri: d.item.uri,
        id: d.item.id,
      } : null
    });
  } catch (e) {
    console.error("spotify/now error:", e);
    return c.json({ error: "Failed to read playback state" }, 500);
  }
});


// ———————————————————————————————————————————————————————————
// HÄÄL (VOTE)
// ———————————————————————————————————————————————————————————
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

// ———————————————————————————————————————————————————————————
// LISA LAUL (otsingu fallbackiga Spotify’st)
// ———————————————————————————————————————————————————————————
api.post("/add-song", async (c) => {
  try {
    const { venueId, sessionId, song } = await c.req.json();
    if (!venueId || !sessionId || !song?.title || !song?.artist) {
      return c.json({ error: "Missing required fields" }, 400);
    }

    // (soovi korral: nõua ka uri/spotifyId ja katkesta, kui puudub)

    // Sessioni cooldown ning eelmine lugu
    const sessionKey = `session:${venueId}:${sessionId}`;
    const session = await kv.get(sessionKey);

    const baseCooldownMs = 0; // testimiseks 0 (vajadusel muuda)
    let enforceCooldown = false;
    let remainingMinutes = 0;

    if (session?.lastAddedAt) {
      const since = Date.now() - session.lastAddedAt;
      if (since < baseCooldownMs) {
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
        429,
      );
    }

    // Kui uri/id puudub → proovi Spotify otsingust
    let trackUri: string | undefined = song.uri;
    let trackId: string | undefined = song.spotifyId;
    let albumArt: string | undefined = song.albumArt;

    if (!trackUri && !trackId) {
      const token = await getSpotifyAccessToken(); // client-credentials (kataloog, mitte playback)
      if (token) {
        const q = encodeURIComponent(`${song.title} ${song.artist}`);
        const sr = await fetch(
          `https://api.spotify.com/v1/search?q=${q}&type=track&limit=1`,
          { headers: { Authorization: `Bearer ${token}` } },
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

    // Loo queue kirje
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

api.post('/admin/add-song', async (c) => {
  try {
    const admin = c.req.header('X-Venue-Admin');
    if (!admin) return c.json({ error: 'missing admin' }, 401);

    const { venueId, title, artist, albumArt, uri, spotifyId } = await c.req.json();
    if (!venueId || !title || !artist) return c.json({ error: 'bad input' }, 400);

    let trackUri: string | undefined = uri;
    let trackId: string | undefined = spotifyId;
    let art: string | undefined = albumArt;

    if (!trackUri && !trackId) {
      const token = await getSpotifyAccessToken();
      if (token) {
        const q = encodeURIComponent(`${title} ${artist}`);
        const sr = await fetch(
          `https://api.spotify.com/v1/search?q=${q}&type=track&limit=1`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (sr.ok) {
          const sd = await sr.json();
          const t = sd?.tracks?.items?.[0];
          if (t?.uri && t?.id) {
            trackUri = t.uri;
            trackId  = t.id;
            if (!art) art = t.album?.images?.[0]?.url ?? "";
          }
        }
      }
    }

    const songId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const queueKey = `queue:${venueId}:${songId}`;
    const newSong = {
      id: songId,
      title,
      artist,
      albumArt: art ?? '',
      uri: trackUri ?? (trackId ? `spotify:track:${trackId}` : undefined),
      spotifyId: trackId ?? undefined,
      hype: 0,
      addedAt: Date.now(),
    };
    await kv.set(queueKey, newSong);

    return c.json({ success: true, song: newSong });
  } catch (e) {
    console.error('admin/add-song error:', e);
    return c.json({ error: 'failed to add song' }, 500);
  }
});


// ———————————————————————————————————————————————————————————
// ADMIN: PIN + SESSIOONID
// ———————————————————————————————————————————————————————————
async function sha256Hex(str: string): Promise<string> {
  const enc = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomId(n = 32) {
  return Array.from(crypto.getRandomValues(new Uint8Array(n)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// POST /admin/set-pin { venueId, pin }
api.post("/admin/set-pin", async (c) => {
  try {
    const { venueId, pin } = await c.req.json();
    if (!venueId || !pin) return c.json({ error: "Missing venueId/pin" }, 400);

    const existing = await kv.get(`admin:pin:${venueId}`);
    if (existing?.hash) return c.json({ error: "PIN already set for this venue" }, 400);

    const salt = randomId(16);
    const digest = await sha256Hex(`${salt}:${pin}`);
    const hash = `sha256:${salt}:${digest}`;
    await kv.set(`admin:pin:${venueId}`, { hash, createdAt: Date.now() });

    return c.json({ success: true });
  } catch (e) {
    console.error("set-pin error:", e);
    return c.json({ error: "Failed to set PIN" }, 500);
  }
});

// POST /admin/login { venueId, pin } -> { token }
api.post("/admin/login", async (c) => {
  try {
    const { venueId, pin } = await c.req.json();
    if (!venueId || !pin) return c.json({ error: "Missing venueId/pin" }, 400);

    const rec = await kv.get(`admin:pin:${venueId}`);
    if (!rec?.hash) return c.json({ error: "No PIN set for this venue" }, 400);

    const [algo, salt, stored] = String(rec.hash).split(":");
    if (algo !== "sha256" || !salt || !stored) {
      return c.json({ error: "PIN record corrupted" }, 500);
    }
    const digest = await sha256Hex(`${salt}:${pin}`);
    if (digest !== stored) return c.json({ error: "Invalid PIN" }, 401);

    const token = randomId(24);
    const ttlMs = 12 * 60 * 60 * 1000; // 12h
    await kv.set(`admin:session:${venueId}:${token}`, { exp: Date.now() + ttlMs });

    return c.json({ token });
  } catch (e) {
    console.error("login error:", e);
    return c.json({ error: "Login failed" }, 500);
  }
});

// Admin nõue (päisest X-Venue-Admin)
async function requireAdmin(c: any, venueId?: string) {
  const token = c.req.header("X-Venue-Admin");
  if (!token) return { ok: false, res: c.json({ error: "Missing X-Venue-Admin" }, 401) };

  const vId =
    venueId ??
    (await c.req.json().catch(() => ({}))).venueId ??
    c.req.query("venueId");
  if (!vId) return { ok: false, res: c.json({ error: "Missing venueId" }, 400) };

  const sess = await kv.get(`admin:session:${vId}:${token}`);
  if (!sess?.exp || sess.exp < Date.now()) {
    return { ok: false, res: c.json({ error: "Session expired" }, 401) };
  }
  return { ok: true, venueId: vId, token };
}

// ———————————————————————————————————————————————————————————
// SPOTIFY: OAuth (per-venue), seadmed, play
// ———————————————————————————————————————————————————————————

// DJ klikib “Connect Spotify”
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
    state: venueId,
    show_dialog: "false",
  });

  return c.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
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

    if (data.refresh_token) {
      await kv.set(`spotify:refresh:${venueId}`, {
        refresh_token: data.refresh_token,
        obtainedAt: Date.now(),
        scopesSaved: true,
      });
    }

    const FRONTEND_URL = Deno.env.get("FRONTEND_URL")!;
    const u = new URL(FRONTEND_URL);
    u.pathname = "/dj";   
    u.searchParams.set("venue", String(venueId));
    u.searchParams.set("admin", "true");
    u.searchParams.set("linked", "1");
    return c.redirect(u.toString(), 302);
  } catch (e) {
    console.error("callback error:", e);
    return c.text("Callback error", 500);
  }
});

// GET /spotify/devices/:venueId — loetle Spotify seadmed (admin nõutud)
api.get("/spotify/devices/:venueId", async (c) => {
  const venueId = c.req.param("venueId");
  const check = await requireAdmin(c, venueId);
  if (!check.ok) return check.res;

  const token = await getUserAccessTokenForVenue(venueId);
  const r = await fetch("https://api.spotify.com/v1/me/player/devices", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return c.json({ error: "Failed to fetch devices" }, 500);
  const data = await r.json();
  return c.json({ devices: data.devices ?? [] });
});

// POST /spotify/select-device { venueId, deviceId } — salvesta venue device
api.post("/spotify/select-device", async (c) => {
  try {
    const { venueId, deviceId } = await c.req.json();
    if (!venueId) return c.json({ error: "Missing venueId" }, 400);
    const check = await requireAdmin(c, venueId);
    if (!check.ok) return check.res;

    await kv.set(`spotify:device:${venueId}`, deviceId);
    return c.json({ success: true });
  } catch (e) {
    console.error("select-device error:", e);
    return c.json({ error: "Failed to select device" }, 500);
  }
});

// (Valikuline) POST /spotify/play — mängi suvalise URIde list administ
api.post("/spotify/play", async (c) => {
  try {
    const { venueId, uris, position_ms = 0 } = await c.req.json();
    if (!venueId || !Array.isArray(uris) || uris.length === 0) {
      return c.json({ error: "Missing venueId/uris" }, 400);
    }
    const check = await requireAdmin(c, venueId);
    if (!check.ok) return check.res;

    const token = await getUserAccessTokenForVenue(venueId);
    const deviceId = await kv.get(`spotify:device:${venueId}`);
    if (!deviceId) return c.json({ error: "No device selected" }, 400);

    // transfer + play
    await fetch("https://api.spotify.com/v1/me/player", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ device_ids: [deviceId], play: false }),
    });

    const r = await fetch(
      `https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(deviceId)}`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ uris, position_ms }),
      },
    );
    if (!r.ok && r.status !== 204) {
      const t = await r.text();
      console.error("spotify/play failed:", t);
      return c.json({ error: "Failed to play" }, 500);
    }

    return c.json({ success: true });
  } catch (e) {
    console.error("spotify/play error:", e);
    return c.json({ error: "Failed to play" }, 500);
  }
});

// GET /skip/status/:venueId  -> { trackId, votes, threshold }
api.get("/skip/status/:venueId", async (c) => {
  const venueId = c.req.param("venueId");
  let now = await kv.get(`nowplaying:${venueId}`);
  if (!now?.id) {
    const state = await getPlayerState(venueId).catch(() => null);
    const item = state?.item;
    if (item?.id) {
      now = {
        id: item.id,
        title: item.name,
        artist: (item.artists ?? []).map((a: any) => a.name).join(", "),
        albumArt: item.album?.images?.[0]?.url ?? "",
        duration_ms: item.duration_ms ?? null,
        startedAt: state?.is_playing ? Date.now() - (state?.progress_ms ?? 0) : null,
        uri: item.uri,
        spotifyId: item.id,
        };
        await kv.set(`nowplaying:${venueId}`, now);
      }
    }
    if (!now?.id) return c.json({ trackId: null, votes: 0, threshold: 5 });

  const threshold = (await kv.get(`skip:threshold:${venueId}`)) ?? 5;
  const votes = (await kv.get(`skip:votes:${venueId}:${now.id}`)) ?? 0;
  return c.json({ trackId: now.id, votes, threshold });
});

// POST /skip/vote { venueId, sessionId }
api.post("/skip/vote", async (c) => {
  try {
    const { venueId, sessionId } = await c.req.json();
    if (!venueId || !sessionId) return c.json({ error: "Missing venueId/sessionId" }, 400);

    // praegune lugu
    let now = await kv.get(`nowplaying:${venueId}`);
   if (!now?.id) {
     const state = await getPlayerState(venueId).catch(() => null);
     const item = state?.item;
     if (item?.id) {
       now = {
         id: item.id,
         title: item.name,
         artist: (item.artists ?? []).map((a: any) => a.name).join(", "),
         albumArt: item.album?.images?.[0]?.url ?? "",
         duration_ms: item.duration_ms ?? null,
         startedAt: state?.is_playing ? Date.now() - (state?.progress_ms ?? 0) : null,
         uri: item.uri,
         spotifyId: item.id,
       };
       await kv.set(`nowplaying:${venueId}`, now);
     }
   }
   if (!now?.id) return c.json({ error: "No track playing" }, 400);
    const trackId = now.id;

    // kas see sessioon on juba hääletanud selle loo vastu?
    const votedKey = `skip:voted:${venueId}:${sessionId}:${trackId}`;
    if (await kv.get(votedKey)) return c.json({ error: "Already voted" }, 400);

    // suurenda häälte arvu
    const votesKey = `skip:votes:${venueId}:${trackId}`;
    const current = (await kv.get(votesKey)) ?? 0;
    const newVotes = current + 1;
    await kv.set(votesKey, newVotes);
    await kv.set(votedKey, true);

    const threshold = (await kv.get(`skip:threshold:${venueId}`)) ?? 5;

    // kui lävi täis → next + nulli loendurid
    if (newVotes >= threshold) {
      try {
        const token = await getUserAccessTokenForVenue(venueId);
        const deviceId = await kv.get(`spotify:device:${venueId}`);

        // Spotify next
        await fetch(
          `https://api.spotify.com/v1/me/player/next${
            deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : ""
          }`,
          { method: "POST", headers: { Authorization: `Bearer ${token}` } }
        );

        // nulli skip häälte loendur (selle loo jaoks)
        await kv.del(votesKey);

        // soovi korral võid kohe värskendada nowplaying infot:
        // (lihtsuse mõttes jätame järgmise /spotify/now polling'u hooleks)
      } catch (e) {
        console.error("skip->next failed:", e);
        // isegi kui next ebaõnnestus, tagastame uue häälte seisu
      }
    }

    return c.json({ ok: true, votes: newVotes, threshold });
  } catch (e) {
    console.error("skip vote error:", e);
    return c.json({ error: "Skip vote failed" }, 500);
  }
});



// ———————————————————————————————————————————————————————————
// SPOTIFY: kataloogi otsing (client-credentials, mitte playback)
// ———————————————————————————————————————————————————————————
api.get("/search-spotify", async (c) => {
  try {
    const query = c.req.query("q");
    if (!query) return c.json({ error: "Query parameter required" }, 400);

    // lihtne ratelimit 60/min (soovi korral tee per-IP/venue)
    const key = "ratelimit:spotify:search";
    const rl = await kv.get(key);
    const now = Date.now();
    if (rl?.count && rl?.resetAt > now) {
      if (rl.count >= 60) {
        const wait = Math.ceil((rl.resetAt - now) / 1000);
        return c.json(
          { error: `Too many searches. Please wait ${wait} seconds.`, retryAfter: wait },
          429,
        );
      }
      await kv.set(key, { count: rl.count + 1, resetAt: rl.resetAt });
    } else {
      await kv.set(key, { count: 1, resetAt: now + 60_000 });
    }

    const token = await getSpotifyAccessToken();
    if (!token) {
      return c.json(
        { error: "Spotify API not configured. Please add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET." },
        500,
      );
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

// (Kui kasutad Web Playback SDK’d)
api.get("/spotify/user-token", async (c) => {
  const venueId = c.req.query("venueId");
  if (!venueId) return c.json({ error: "Missing venueId" }, 400);
  const access_token = await getUserAccessTokenForVenue(venueId);
  return c.json({ access_token });
});

// ———————————————————————————————————————————————————————————
// DEMO INIT
// ———————————————————————————————————————————————————————————
api.post("/init-demo/:venueId", async (c) => {
  try {
    const venueId = c.req.param("venueId");
    const existing = await kv.getByPrefix(`queue:${venueId}:`);
    if (existing.length > 0) return c.json({ message: "Venue already initialized" });

    const demoSongs = [
      {
        id: "demo-1",
        title: "adore u",
        artist: "Fred again..",
        albumArt:
          "https://images.unsplash.com/photo-1571766752116-63b1e6514b53?w=300&h=300&fit=crop",
        hype: 127,
        addedAt: Date.now() - 1_000_000,
      },
      {
        id: "demo-2",
        title: "Heat Waves",
        artist: "Glass Animals",
        albumArt:
          "https://images.unsplash.com/photo-1622224408917-9dfb43de2cd4?w=300&h=300&fit=crop",
        hype: 89,
        addedAt: Date.now() - 800_000,
      },
      {
        id: "demo-3",
        title: "Parem veelgi",
        artist: "Tanel Padar",
        albumArt:
          "https://images.unsplash.com/photo-1629426958038-a4cb6e3830a0?w=300&h=300&fit=crop",
        hype: 56,
        addedAt: Date.now() - 600_000,
      },
      {
        id: "demo-4",
        title: "Blinding Lights",
        artist: "The Weeknd",
        albumArt:
          "https://images.unsplash.com/photo-1606224534096-fcd6bb9a2018?w=300&h=300&fit=crop",
        hype: 43,
        addedAt: Date.now() - 400_000,
      },
    ];
    for (const s of demoSongs) await kv.set(`queue:${venueId}:${s.id}`, s);
    await kv.set(`nowplaying:${venueId}`, {
      id: "demo-now-1", 
      title: "Starboy",
      artist: "The Weeknd ft. Daft Punk",
      albumArt:
        "https://images.unsplash.com/photo-1571766752116-63b1e6514b53?w=300&h=300&fit=crop",
    });
    return c.json({ success: true, message: "Demo data initialized" });
  } catch (e) {
    console.error("Error initializing demo venue:", e);
    return c.json({ error: "Failed to initialize demo venue" }, 500);
  }
});

// ———————————————————————————————————————————————————————————
// SPOTIFY TOKEN HELPERS
// ———————————————————————————————————————————————————————————

// Rakenduse (client-credentials) token — kataloogipäringud
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

async function autoFillFromRecommendations(venueId: string) {
  const token = await getUserAccessTokenForVenue(venueId);
  const deviceId = await kv.get(`spotify:device:${venueId}`);
  if (!deviceId) return;

  // loe viimased 5 seemet
  const recent: string[] = (await kv.get(`recent:tracks:${venueId}`)) ?? [];
  const seeds = recent.slice(-5).join(',');
  if (!seeds) return; // pole seemneid

  const rec = await fetch(
    `https://api.spotify.com/v1/recommendations?seed_tracks=${encodeURIComponent(seeds)}&limit=5`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!rec.ok) return;
  const data = await rec.json();
  const tracks: string[] = (data.tracks ?? []).map((t: any) => t.uri);

  // lisa soovitused Spotify queue'i
  for (const uri of tracks) {
    await fetch(
      `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(uri)}`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` } },
    );
  }

  // kui pausis, käivita
  const st = await fetch("https://api.spotify.com/v1/me/player", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const state = st.ok ? await st.json() : null;
  if (!state?.is_playing) {
    await fetch("https://api.spotify.com/v1/me/player", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ device_ids: [deviceId], play: true }),
    });
  }
}

// Kasutaja (venue) token — playback (Authorization Code -> refresh)
async function getUserAccessTokenForVenue(venueId: string): Promise<string> {
  const r = await kv.get(`spotify:refresh:${venueId}`);
  if (!r?.refresh_token) {
    throw new Error("Venue not linked to Spotify (no refresh token).");
  }

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
      "Authorization": `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
    },
    body,
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`refresh failed: ${t}`);
  }
  const data = await resp.json();

 
  if (data.refresh_token && data.refresh_token !== r.refresh_token) {
    await kv.set(`spotify:refresh:${venueId}`, {
      refresh_token: data.refresh_token,
      obtainedAt: Date.now(),
      scopesSaved: true,
    });
  }

  return data.access_token as string;
}

async function getPlayerState(venueId: string) {
  const token = await getUserAccessTokenForVenue(venueId);
  const r = await fetch("https://api.spotify.com/v1/me/player", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  return await r.json();
}
api.post("/guard/ensure/:venueId", async (c) => {
  const venueId = c.req.param("venueId");
  const check = await requireAdmin(c, venueId);
  if (!check.ok) return check.res;

  const deviceId = await kv.get(`spotify:device:${venueId}`);
  if (!deviceId) return c.json({ ok: false, reason: "no-device" });

  // 1) vaata, kas midagi mängib
  const state = await getPlayerState(venueId);
  const isPlaying = !!state?.is_playing;

  // 2) kas queue on tühi?
  const items = await kv.getByPrefix(`queue:${venueId}:`);

  if (isPlaying) {

    return c.json({ ok: true, playing: true, queue: items.length });
  }

  
  if (items.length > 0) {

    const playNext = await fetch(`${c.req.url.replace(/\/guard\/ensure\/.*/,'')}/play-next/${venueId}`, {
      method: "POST",
      headers: { "X-Venue-Admin": c.req.header("X-Venue-Admin") || "" },
    });
    const j = await playNext.json().catch(() => ({}));
    return c.json({ ok: playNext.ok, tried: "play-next", detail: j });
  } else {
    await autoFillFromRecommendations(venueId);
    return c.json({ ok: true, tried: "auto-fill" });
  }
});


// routing
app.route("/", api);
app.route("/make-server-d5eddf57", api);

Deno.serve(app.fetch);
