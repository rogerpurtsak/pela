import { SetStateAction, useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Copy, Check, Download, Music } from "lucide-react";
import { motion } from "motion/react";
import AdminBar from "./AdminBar";
import { NowPlayingCard } from "./NowPlayingCard";
import { AddSongSheet } from "./AddSongSheet";
import { useNavigate } from "react-router-dom";
import { PlaybackProgress } from "./PlaybackProgress";


interface VenueAdminProps {
  venueId?: string;
  onGoAudience?: () => void;
  nextSong?: { title: string; artist: string; albumArt: string } | null;
}

type Device = { id: string; name: string; type: string; is_active: boolean };

const qs0 = new URLSearchParams(window.location.search);
const adminParam0 = qs0.get("admin") === "true";
const venueFromUrl0 = qs0.get("venue") || "";
const linkedParam0 = qs0.get("linked") === "1";

const LINKED_KEY = (v: string) => `spotify:linked:${v}`;
const LOGIN_GUARD_KEY = (v: string) => `spotify:loginInFlight:${v}`;

const BASE = import.meta.env.VITE_EDGE_BASE as string;
if (!BASE) throw new Error('env puudub ');

export function VenueAdmin({ venueId: initialVenueId, onGoAudience, nextSong }: VenueAdminProps) {
  const venueFromUrl =
  new URLSearchParams(window.location.search).get("venue") || "";
  const [venueId, setVenueId] = useState(initialVenueId || venueFromUrl || "");
  const [venueName, setVenueName] = useState("");
  const [copied, setCopied] = useState(false);

  // --- DJ flow state ---
  const [devices, setDevices] = useState<Device[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [now, setNow] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [cooldownMinutes, setCooldownMinutes] = useState<number | undefined>(undefined);
  const navigate = useNavigate();
  const [hasPin, setHasPin] = useState(false);
  const [nowLive, setNowLive] = useState<{
  startedAt: number | null;
  duration_ms: number;
  is_playing: boolean;
  item: { name: string; artists: string; albumArt: string; uri: string; id: string } | null;
  } | null>(null);


  const venueUrl = venueId ? `${window.location.origin}/?venue=${venueId}` : "";

  const [pin, setPin] = useState("");
  const [adminToken, setAdminToken] = useState<string | null>(null);


    const [isLinked, setIsLinked] = useState<boolean>(() => {
    if (!venueFromUrl0) return linkedParam0;
    return linkedParam0 || sessionStorage.getItem(LINKED_KEY(venueFromUrl0)) === "1";
  });

  useEffect(() => {
    if (!venueId) return;
    const sp = new URLSearchParams(window.location.search);
    const gotLinked = sp.get("linked") === "1";
    if (gotLinked) {
      sessionStorage.setItem(LINKED_KEY(venueId), "1");
      sessionStorage.removeItem(LOGIN_GUARD_KEY(venueId)); // katkestab autologini edasi
      setIsLinked(true);

      // puhasta 'linked' URL-ist (jätame admin & venue alles)
      sp.delete("linked");
      const clean = `${location.pathname}?${sp.toString()}`;
      window.history.replaceState(null, "", clean);
    } else {
      // kui URL-is pole linked, aga storage ütleb, sünkroniseeri
      const stored = sessionStorage.getItem(LINKED_KEY(venueId)) === "1";
      if (stored && !isLinked) setIsLinked(true);
    }
  }, [venueId]);


  useEffect(() => {
    if (!venueId) return;
    const sp = new URLSearchParams(window.location.search);
    const adminParam = sp.get("admin") === "true";
    if (adminParam && !isLinked) {
      const guardKey = LOGIN_GUARD_KEY(venueId);
      if (!sessionStorage.getItem(guardKey)) {
        sessionStorage.setItem(guardKey, "1");
        window.location.href = `${BASE}/spotify/login?venueId=${encodeURIComponent(venueId)}`;
      }
    }
  }, [venueId, isLinked]);


  useEffect(() => {
  if (!venueId || !adminToken) return;
  let alive = true;

  const ping = async () => {
    try {
      await fetch(`${BASE}/guard/ensure/${encodeURIComponent(venueId)}`, {
        method: "POST",
        headers: { "X-Venue-Admin": adminToken },
        cache: "no-store",
      });
    } catch {}
    if (alive) setTimeout(ping, 4000);
  };

  ping();
  return () => { alive = false; };
}, [venueId, adminToken]);


  function openSpotifyApp() {
  const webUrl = 'https://open.spotify.com/';
  const isAndroid = /Android/i.test(navigator.userAgent);
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

  const appUrl = 'spotify:'; 

  const androidIntent =
    'intent://#Intent;scheme=spotify;package=com.spotify.music;' +
    'S.browser_fallback_url=' + encodeURIComponent(webUrl) + ';end';

  // fallback timeout
  const failover = setTimeout(() => {
    // Kui äpp ei neelanud fookust/ei avanud, mine web’i
    window.location.href = webUrl;
  }, 2000);

  // Kui tab kaotab nähtavuse (äppi mindi), katkesta fallback
  const cancel = () => { clearTimeout(failover); document.removeEventListener('visibilitychange', cancel); };
  document.addEventListener('visibilitychange', cancel);

  try {
    if (isAndroid) {
      // androidi chrome nt intent://
      window.location.href = androidIntent;
    } else {
      // iOS + desktop
      window.location.href = appUrl;
    }
  } catch {
    clearTimeout(failover);
    window.location.href = webUrl;
  }
}



    const audienceUrl = useMemo(
    () => (venueId ? `${window.location.origin}/?venue=${venueId}` : ""),
    [venueId]
  );

    async function adminAddSong(song: { title: string; artist: string; albumArt: string }) {
    if (!venueId) return alert("Venue ID puudub.");
    if (!adminToken) return alert("Logi adminina sisse (PIN).");

    const r = await fetch(`${BASE}/admin/add-song`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Venue-Admin": adminToken,
      },
      body: JSON.stringify({ venueId, ...song }),
    });
    const j = await r.json();
    if (!r.ok) return alert(j.error || "Lisamine ebaõnnestus");

    setIsAddOpen(false);
    setCooldownMinutes(undefined);
    alert("Lugu lisatud järjekorda.");
  }

  function goAudience() {
    if (!venueId) return alert("Genereeri venue ID.");
    navigate({ pathname: '/', search: `?venue=${venueId}` });
  }

  useEffect(() => {
    if (!venueId) return;
    let alive = true;

    const tick = async () => {
      try {
        const r = await fetch(`${BASE}/spotify/now/${encodeURIComponent(venueId)}`, { cache: "no-store" });
        const j = await r.json();
        if (!alive) return;
        setNowLive({
          startedAt: j.startedAt ?? null,
          duration_ms: j.duration_ms ?? 0,
          is_playing: !!j.is_playing,
          item: j.item ?? null,
        });
      } catch (e) {
        // ignore või logi
      } finally {
        if (alive) setTimeout(tick, 2500);
      }
    };

    tick();
    return () => { alive = false; };
  }, [venueId]);


  useEffect(() => {
    if (!venueId) return;
    const id = setInterval(() => {
      loadNow();
      loadQueue();
    }, 5000);
    return () => clearInterval(id);
  }, [venueId]);

  function saveToken(t: string | null) {
    if (!venueId) return;
    if (t) {
      localStorage.setItem(`adminToken:${venueId}`, t);
    } else {
      localStorage.removeItem(`adminToken:${venueId}`);
    }
    setAdminToken(t);
  }

  const generateVenueId = () => {
    const id = `venue-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    setVenueId(id);
    setDevices([]);
    setDeviceId("");
    setNow(null);
    setHasPin(false);
    setAdminToken(null);
  };

  const handleCopy = () => {
    if (!venueUrl) return;
    navigator.clipboard.writeText(venueUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadQR = () => {
    const svg = document.getElementById("qr-code");
    if (!svg) return;

    const svgData = new XMLSerializer().serializeToString(svg);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const img = new Image();

    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx?.drawImage(img, 0, 0);

      const pngFile = canvas.toDataURL("image/png");
      const downloadLink = document.createElement("a");
      downloadLink.download = `hype-queue-${venueId}.png`;
      downloadLink.href = pngFile;
      downloadLink.click();
    };

    img.src = "data:image/svg+xml;base64," + btoa(svgData);
  };

  // --- DJ flow actions ---
  function connectSpotify() {
    if (!venueId) return alert("Genereeri kõigepealt venue ID.");
    sessionStorage.setItem(LOGIN_GUARD_KEY(venueId), "1"); // tähista tahtlik login
    window.location.href = `${BASE}/spotify/login?venueId=${encodeURIComponent(venueId)}`;
  }


  async function refreshDevices() {
    if (!venueId) return alert("Venue ID puudub.");
    if (!adminToken) return alert("Logi adminina sisse.");
    setLoading(true);
    try {
      const r = await fetch(`${BASE}/spotify/devices/${venueId}`, {
        headers: { "X-Venue-Admin": adminToken },
      });
      const j = await r.json();
      if (!r.ok) return alert(j.error || "Failed to fetch devices");
      setDevices(j.devices || []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!venueId) { setHasPin(false); return; }
    const v = localStorage.getItem(`hasPin:${venueId}`) === '1';
    setHasPin(v);
  }, [venueId]);

  async function setPinFirstTime() {
    if (!venueId) return alert("Genereeri venue ID");
    if (!pin) return alert("Sisesta PIN");
    const r = await fetch(`${BASE}/admin/set-pin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ venueId, pin }),
    });
    const j = await r.json();
    if (!r.ok) return alert(j.error || "Failed to set PIN");
    localStorage.setItem(`hasPin:${venueId}`, '1');
    setHasPin(true);
    alert("PIN salvestatud. Logi nüüd sisse.");
  }


  async function adminLogin() {
    if (!venueId) return alert("Genereeri venue ID");
    if (!pin) return alert("Sisesta PIN");
    const r = await fetch(`${BASE}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ venueId, pin }),
    });
    const j = await r.json();
    if (!r.ok) return alert(j.error || "Login failed");
    saveToken(j.token);
    setPin("");
  }


  async function selectPlaybackDevice() {
    if (!venueId) return alert("Venue ID puudub.");
    if (!deviceId) return alert("Vali seade.");
    if (!adminToken) return alert("Logi adminina sisse.");
    setLoading(true);
    try {
      const r = await fetch(`${BASE}/spotify/select-device`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Venue-Admin": adminToken },
        body: JSON.stringify({ venueId, deviceId }),
      });
      const j = await r.json();
      if (!r.ok) return alert(j.error || "Failed to save device");
      alert("Seade salvestatud sellele venue’le.");
    } finally {
      setLoading(false);
    }
  }

  async function playNext() {
    if (!adminToken) { alert("DJ pole sisse logitud (PIN)."); return; }
    setLoading(true);
    try {
      const r = await fetch(`${BASE}/play-next/${venueId}`, {
        method: "POST",
        headers: { "X-Venue-Admin": adminToken }
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Play failed");
      await loadNow();
    } catch (e:any) {
      alert(e.message || "Play next error");
    } finally {
      setLoading(false);
    }
  }

  async function loadNow() {
    if (!venueId) {
      setNow(null);
      return;
    }
    const r = await fetch(`${BASE}/now-playing/${encodeURIComponent(venueId)}`);
    const j = await r.json();
    setNow(j.nowPlaying || null);
  }


  useEffect(() => { if (venueId) loadNow(); }, [venueId]);

  async function adminLogout() {
    if (!venueId || !adminToken) return saveToken(null);
    await fetch(`${BASE}/admin/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Venue-Admin": adminToken },
      body: JSON.stringify({ venueId }),
    });
    saveToken(null);
  }


  return (
  <div className="bg-[#222222]">
    <div className="max-w-2xl mx-auto px-4 py-8 bg-[#212121]">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-center mb-8"
      >
        <div className="mb-6">
          <span className="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-300 backdrop-blur">
            DJ paneel
          </span>

          <h1 className="mt-3 text-3xl md:text-4xl font-semibold tracking-tight leading-tight">
            <span className="bg-gradient-to-r from-[#1DB954] via-emerald-400 to-purple-500 bg-clip-text text-transparent drop-shadow-[0_1px_6px_rgba(29,185,84,0.25)]">
              type&nbsp;shift
            </span>
          </h1>

          <p className="mt-3 text-sm md:text-base text-gray-300">
            Loo QR-kood ja halda enda paneeli
          </p>
        </div>
      </motion.div>
        <Button variant="outline" className="border-gray-700 mb-10 hover:bg-[#cbe4d4] hover:text-black hover:scale-105 hover:rounded-2xl cursor-pointer" onClick={goAudience}>
          ← Tagasi queue’sse
        </Button>


      {/* admin login mdea juhul kui vaja on */}

      {/* Admin (PIN) plokk – lisa see näiteks QR-kaardi järel */}
            {venueId && (
              <Card className="bg-[#1a1a1a] border-gray-800 p-6 mb-6 text-[#1DB954]">
                <h2 className="text-lg font-semibold mb-2">Admin (PIN)</h2>

                {!adminToken && (
                  <div className="flex gap-2 items-center mb-3">
                    <Input
                      value={pin}
                      onChange={(e) => setPin(e.target.value)}
                      placeholder="Sisesta PIN"
                      className="bg-[#0e0e0e] border-gray-700 text-white placeholder-gray-500 caret-white"
                    />
                    {!hasPin && (
                      <Button onClick={setPinFirstTime} className="text-black bg-white hover:bg-[#cbe4d4]">
                        Set PIN
                      </Button>
                    )}
                    <Button onClick={adminLogin} className="text-black bg-white hover:bg-[#cbe4d4]">
                      Login
                    </Button>
                  </div>
                )}

                {adminToken && (
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-emerald-400">Oled sisse logitud.</span>
              <Button onClick={adminLogout} variant="outline" className="text-black bg-white hover:bg-[#cbe4d4]">
                Logout
              </Button>
            </div>
          )}
        </Card>
      )}


      {/* 0) Venue seaded + QR */}
      <Card className="bg-black border-gray-800 p-6 mb-6">
        <div className="space-y-4">
          <div>
            <label className="text-sm text-gray-400 mb-2 block">
              Koha nimi (valikuline)
            </label>
            <Input
              value={venueName}
              onChange={(e) => setVenueName(e.target.value)}
              placeholder="nt. NOKU"
              className="bg-[#0e0e0e] border-gray-700 text-white placeholder-gray-500 caret-white"
            />
          </div>

          {!venueId ? (
            <Button
              onClick={generateVenueId}
              className="w-full text-black bg-white hover:bg-[#cbe4d4] hover:text-black hover:rounded-2xl cursor-pointer"
            >
              <Music className="w-4 h-4 mr-2" />
              Genereeri uus venue ID
            </Button>
          ) : (
            <div className="space-y-4">
              <div>
                <label className="text-sm text-gray-400 mb-2 block">Venue ID</label>
                <div className="bg-[#0e0e0e] border border-gray-700 rounded-lg p-3 font-mono text-sm break-all text-white">
                  {venueId}
                </div>
              </div>

              <div>
                <label className="text-sm text-gray-400 mb-2 block">Audience URL</label>
                <div className="flex gap-2">
                  <Input
                    value={venueUrl}
                    readOnly
                    className="bg-[#0e0e0e] border-gray-700 font-mono text-sm text-white placeholder-gray-500 caret-white"
                  />
                  <Button
                    onClick={handleCopy}
                    variant="outline"
                    className="border-gray-700 text-black hover:bg-[#cbe4d4] hover:text-black hover:scale-105 hover:rounded-2xl cursor-pointer"
                  >
                    {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </Button>
                </div>
              </div>


              <div className="bg-white p-6 rounded-lg">
                <QRCodeSVG
                  id="qr-code"
                  value={venueUrl}
                  size={256}
                  level="H"
                  includeMargin
                  className="mx-auto"
                />
                {venueName && (
                  <p className="text-center mt-4 text-black font-semibold">
                    {venueName}
                  </p>
                )}
              </div>

              <Button onClick={handleDownloadQR} variant="outline" className="w-full border-gray-700 hover:bg-[#cbe4d4] hover:text-black hover:rounded-2xl cursor-pointer">
                <Download className="w-4 h-4 mr-2" />
                Lae QR-kood alla (PNG)
              </Button>

              <div className="bg-[#0e0e0e] border border-gray-700 rounded-lg p-4">
                <h3 className="text-sm font-semibold mb-2 text-[#1DB954]">
                  Kuidas kasutada:
                </h3>
                <ol className="text-sm text-gray-400 space-y-1 list-decimal list-inside">
                  <li>Prindi või kuva QR-kood oma uritusel</li>
                  <li>Külastajad skaneerivad QR-koodi oma telefoniga</li>
                  <li>Avatakse pela sinu venue’ga</li>
                  <li>Külastajad saavad hääletada ja lisada lugusid</li>
                </ol>
              </div>

              <Button
                onClick={() => {
                  setVenueId("");
                  setVenueName("");
                  setDevices([]);
                  setDeviceId("");
                  setNow(null);
                  setHasPin(false);
                  setAdminToken(null);
                }}
                variant="ghost"
                className="w-full text-gray-500 cursor-pointer"
              >
                Loo uus venue
              </Button>
            </div>
          )}
        </div>
      </Card>

      {/* 1) Spotify ühendus */}
      <Card className="bg-[#1a1a1a] border-gray-800 p-6 mb-6 text-[#1DB954]">
        <h2 className="text-lg font-semibold mb-2">1) Connect Spotify</h2>
        <p className="text-sm text-gray-400 mb-3">
          Staatus: {isLinked ? "✅ lingitud" : "❌ linkimata"}
        </p>

        <Button onClick={connectSpotify} variant="outline"
          className="text-black bg-white hover:bg-[#cbe4d4] hover:text-black hover:rounded-2xl cursor-pointer">
          Connect Spotify
        </Button>
        {!venueId && (
          <p className="text-xs text-gray-500 mt-2">
            Genereeri kõigepealt venue ID.
          </p>
        )}
      </Card>

      {/* 2) Seadme valik */}
      <Card className="bg-[#1a1a1a] border-gray-800 p-6 mb-6 text-[#1DB954]">
        <h2 className="text-lg font-semibold mb-2">
          2) Playback device (desktop/mobiili Spotify)
        </h2>
          <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-2 mb-3">
          <Button onClick={refreshDevices} variant="outline"
            className="text-black bg-white hover:bg-[#cbe4d4] hover:text-black hover:rounded-2xl cursor-pointer"
            disabled={!adminToken || !venueId || loading}>
            Refresh devices
          </Button>
            <select
              className="bg-black border border-gray-700 rounded-lg px-3 py-2"
              value={deviceId}
              onChange={(e) => setDeviceId(e.target.value)}
              disabled={!adminToken || devices.length === 0}
            >
              <option value="">-- vali seade --</option>
              {devices.map(d => (
                <option key={d.id} value={d.id}>
                  {(d.name || d.type) + (d.is_active ? " (active)" : "")}
                </option>
              ))}
            </select>

            <Button onClick={selectPlaybackDevice} variant="outline"
              className="text-black bg-white hover:bg-[#cbe4d4] hover:text-black hover:rounded-2xl cursor-pointer"
              disabled={!adminToken || !deviceId}>
              Use this device
            </Button>

            <Button
              onClick={openSpotifyApp}
              variant="outline"
              className="shrink-0 whitespace-nowrap text-black bg-white hover:bg-[#cbe4d4] hover:text-black hover:rounded-2xl cursor-pointer"
            >
              Open Spotify app
            </Button>
          </div>

        <p className="text-xs text-gray-500">
          Ava Spotify äpp ja hoia seade online/active.
        </p>
      </Card>

        <Card className="bg-[#1a1a1a] border-gray-800 p-6 text-[#1DB954]">
          {/* Päis + Lisa laul nupp */}
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold">3) Control</h2>
            <Button
              onClick={() => setIsAddOpen(true)}
              className="text-black bg-white hover:bg-[#cbe4d4] hover:text-black hover:rounded-2xl cursor-pointer"
            >
              + Lisa laul
            </Button>
          </div>

          {/* Play next / Reload */}
          <div className="flex gap-2 mb-3">
            <Button
              onClick={playNext}
              className="text-black bg-white hover:bg-[#cbe4d4] hover:text-black hover:rounded-2xl cursor-pointer"
              disabled={loading || !venueId}
            >
              Play next
            </Button>
            <Button
              onClick={loadNow}
              variant="outline"
              className="text-black bg-white hover:bg-[#cbe4d4] hover:text-black hover:rounded-2xl cursor-pointer"
              disabled={loading || !venueId}
            >
              Reload Now Playing
            </Button>
          </div>

          {/* info-kaart (kasuta live item'i infot kui olemas) */}
          <NowPlayingCard
            song={
              nowLive?.item
                ? {
                    title: nowLive.item.name,
                    artist: nowLive.item.artists,
                    albumArt: nowLive.item.albumArt,
                  }
                : (now || null) // fallback sinu olemasolevale now-playing andmele
            }
          />

          {/* progress ribana + ajad (kui live item olemas) */}
          {nowLive?.item && (
            <PlaybackProgress
              isPlaying={nowLive.is_playing}
              startedAt={nowLive.startedAt}
              durationMs={nowLive.duration_ms}
            />
          )}

          {nextSong ? (
            <div className="bg-black/40 border border-gray-800 rounded-2xl p-4 mb-2">
              <div className="text-xs uppercase tracking-wider text-gray-400 mb-2">Next up</div>
              <div className="flex items-center gap-3">
                {nextSong.albumArt ? (
                  <img src={nextSong.albumArt} width={48} height={48} className="rounded-md" />
                ) : null}
                <div className="min-w-0">
                  <div className="text-white font-medium truncate">{nextSong.title}</div>
                  <div className="text-sm text-gray-400 truncate">{nextSong.artist}</div>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-sm text-gray-500">Järgnevat lugu pole järjekorras.</div>
          )}

          <div className="mt-4 text-sm text-gray-400">
            <div>
              see link jaga rahvale kui qr ei toota:{" "}
              <a href={audienceUrl} className="text-[#1DB954] underline">
                {audienceUrl || "—"}
              </a>
            </div>
          </div>
        </Card>
      <AddSongSheet
        open={isAddOpen}
        onOpenChange={setIsAddOpen}
        onAddSong={(s) => adminAddSong(s)}
        cooldownMinutes={cooldownMinutes}
      />
    </div>
    </div>
  );
}
