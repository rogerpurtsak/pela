import { SetStateAction, useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Copy, Check, Download, Music } from "lucide-react";
import { motion } from "motion/react";
import { AdminBar } from "./AdminBar";

interface VenueAdminProps {
  venueId?: string;
}

type Device = { id: string; name: string; type: string; is_active: boolean };

const BASE =
  "https://eahgekmtuyvclxegqolf.supabase.co/functions/v1/make-server-d5eddf57";

export function VenueAdmin({ venueId: initialVenueId }: VenueAdminProps) {
  const [venueId, setVenueId] = useState(initialVenueId || "");
  const [venueName, setVenueName] = useState("");
  const [copied, setCopied] = useState(false);

  // --- DJ flow state ---
  const [linked, setLinked] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [now, setNow] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  // Audience URL (QR jaoks)
  const venueUrl = venueId ? `${window.location.origin}/?venue=${venueId}` : "";
  const audienceUrl = useMemo(
    () => (venueId ? `${window.location.origin}/?venue=${venueId}` : ""),
    [venueId]
  );

  const [pin, setPin] = useState("");
  const [adminToken, setAdminToken] = useState<string | null>(null);

  // admin token localstoragest
  useEffect(() => {
    if (venueId) {
      const t = localStorage.getItem(`adminToken:${venueId}`);
      setAdminToken(t);
    } else {
      setAdminToken(null);
    }
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


  useEffect(() => {
    // Kui tuldi Spotify callbackist, URL saab ?linked=1
    const u = new URL(window.location.href);
    if (u.searchParams.get("linked") === "1") setLinked(true);
    loadNow();
  }, [venueId]);

  const generateVenueId = () => {
    const id = `venue-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    setVenueId(id);
    // uue venue puhul nulli DJ seaded
    setLinked(false);
    setDevices([]);
    setDeviceId("");
    setNow(null);
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
    window.location.href = `${BASE}/spotify/login?venueId=${venueId}`;
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
    if (!venueId) return alert("Venue ID puudub.");
    if (!adminToken) return alert("Logi adminina sisse.");
    setLoading(true);
    try {
      const r = await fetch(`${BASE}/play-next/${venueId}`, {
        method: "POST",
        headers: { "X-Venue-Admin": adminToken },
      });
      const j = await r.json();
      if (!r.ok) return alert(j.error || "Failed to play next");
      await loadNow();
    } finally {
      setLoading(false);
    }
  }

  async function loadNow() {
    if (!venueId) return;
    const r = await fetch(`${BASE}/now-playing/${venueId}`);
    const j = await r.json();
    setNow(j.nowPlaying || null);
  }

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
    <div className="max-w-2xl mx-auto px-4 py-8">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-center mb-8"
      >
        <h1 className="text-3xl mb-2 bg-gradient-to-r from-[#1DB954] to-purple-500 bg-clip-text text-transparent">
          Venue Admin
        </h1>
        <p className="text-gray-400">Loo QR-kood ja halda Spotify taasesitust</p>
      </motion.div>

      {/* admin login */}
      <AdminBar
        venueId={venueId}
        onGoAdmin={() => setShowAdmin(true)}
      />


      {/* 0) Venue seaded + QR */}
      <Card className="bg-[#1a1a1a] border-gray-800 p-6 mb-6">
        <div className="space-y-4">
          <div>
            <label className="text-sm text-gray-400 mb-2 block">
              Koha nimi (valikuline)
            </label>
            <Input
              value={venueName}
              onChange={(e) => setVenueName(e.target.value)}
              placeholder="nt. Club XYZ"
              className="bg-[#0e0e0e] border-gray-700"
            />
          </div>

          {!venueId ? (
            <Button
              onClick={generateVenueId}
              className="w-full bg-gradient-to-r from-[#1DB954] to-[#1ed760] hover:from-[#1ed760] hover:to-[#1DB954]"
            >
              <Music className="w-4 h-4 mr-2" />
              Genereeri uus venue ID
            </Button>
          ) : (
            <div className="space-y-4">
              <div>
                <label className="text-sm text-gray-400 mb-2 block">
                  Venue ID
                </label>
                <div className="bg-[#0e0e0e] border border-gray-700 rounded-lg p-3 font-mono text-sm break-all">
                  {venueId}
                </div>
              </div>

              <div>
                <label className="text-sm text-gray-400 mb-2 block">
                  Audience URL
                </label>
                <div className="flex gap-2">
                  <Input
                    value={venueUrl}
                    readOnly
                    className="bg-[#0e0e0e] border-gray-700 font-mono text-sm"
                  />
                  <Button onClick={handleCopy} variant="outline" className="border-gray-700">
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

              <Button onClick={handleDownloadQR} variant="outline" className="w-full border-gray-700">
                <Download className="w-4 h-4 mr-2" />
                Lae QR-kood alla (PNG)
              </Button>

              <div className="bg-[#0e0e0e] border border-gray-700 rounded-lg p-4">
                <h3 className="text-sm font-semibold mb-2 text-[#1DB954]">
                  📱 Kuidas kasutada:
                </h3>
                <ol className="text-sm text-gray-400 space-y-1 list-decimal list-inside">
                  <li>Prindi või kuva QR-kood oma baaris/klubis</li>
                  <li>Külastajad skaneerivad QR-koodi oma telefoniga</li>
                  <li>Avatakse Hype Queue sinu venue’ga</li>
                  <li>Külastajad saavad hääletada ja lisada lugusid</li>
                </ol>
              </div>

              <Button
                onClick={() => {
                  setVenueId("");
                  setVenueName("");
                  setLinked(false);
                  setDevices([]);
                  setDeviceId("");
                  setNow(null);
                }}
                variant="ghost"
                className="w-full text-gray-500"
              >
                Loo uus venue
              </Button>
            </div>
          )}
        </div>
      </Card>

      {/* 1) Spotify ühendus */}
      <Card className="bg-[#1a1a1a] border-gray-800 p-6 mb-6">
        <h2 className="text-lg font-semibold mb-2">1) Connect Spotify</h2>
        <p className="text-sm text-gray-400 mb-3">
          Staatus: {linked ? "✅ linked" : "❌ not linked yet"}
        </p>
        <Button
          onClick={connectSpotify}
          disabled={!venueId}
          className="bg-[#1DB954] text-black hover:opacity-90"
        >
          Connect Spotify
        </Button>
        {!venueId && (
          <p className="text-xs text-gray-500 mt-2">
            Genereeri kõigepealt venue ID.
          </p>
        )}
      </Card>

      {/* 2) Seadme valik */}
      <Card className="bg-[#1a1a1a] border-gray-800 p-6 mb-6">
        <h2 className="text-lg font-semibold mb-2">
          2) Playback device (desktop/mobiili Spotify)
        </h2>
        <div className="flex gap-2 mb-3">
          <Button onClick={refreshDevices} variant="outline" className="border-gray-700" disabled={!linked || !venueId || loading}>
            Refresh devices
          </Button>
          <select
            className="bg-black border border-gray-700 rounded-lg px-3 py-2"
            value={deviceId}
            onChange={(e) => setDeviceId(e.target.value)}
            disabled={!linked || devices.length === 0}
          >
            <option value="">-- vali seade --</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name || d.type}
                {d.is_active ? " (active)" : ""}
              </option>
            ))}
          </select>
          <Button onClick={selectPlaybackDevice} variant="outline" className="border-gray-700" disabled={!deviceId}>
            Use this device
          </Button>
        </div>
        <p className="text-xs text-gray-500">
          Ava Spotify äpp ja hoia seade online/active.
        </p>
      </Card>

      {/* 3) Kontroll (Play next + Now Playing) */}
      <Card className="bg-[#1a1a1a] border-gray-800 p-6">
        <h2 className="text-lg font-semibold mb-2">3) Control</h2>
        <div className="flex gap-2 mb-3">
          <Button onClick={playNext} className="bg-white text-black hover:opacity-90" disabled={loading || !venueId}>
            ▶ Play next
          </Button>
          <Button onClick={loadNow} variant="outline" className="border-gray-700">
            Reload Now Playing
          </Button>
        </div>
        <div className="flex items-center gap-3">
          {now?.albumArt ? (
            <img src={now.albumArt} width={56} height={56} className="rounded-md" />
          ) : null}
          <div>
            <div className="font-medium">{now?.title || "—"}</div>
            <div className="text-sm text-gray-400">{now?.artist}</div>
          </div>
        </div>

        <div className="mt-4 text-sm text-gray-400">
          <div>
            Audience link:{" "}
            <a href={audienceUrl} className="text-[#1DB954] underline">
              {audienceUrl || "—"}
            </a>
          </div>
        </div>
      </Card>
    </div>
  );
}
