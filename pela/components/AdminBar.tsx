import { useEffect, useState } from "react";

const BASE =
  "https://eahgekmtuyvclxegqolf.supabase.co/functions/v1/make-server-d5eddf57";

export default function AdminBar({
  venueId,
  onGoAdmin,
  allowSetPin = true, // switcher
}: {
  venueId: string;
  onGoAdmin: () => void;
  allowSetPin?: boolean;
}) {
  const [pin, setPin] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);


  useEffect(() => {
    const t = localStorage.getItem(`adminToken:${venueId}`);
    setToken(t);
  }, [venueId]);

  function saveToken(t: string | null) {
    if (t) localStorage.setItem(`adminToken:${venueId}`, t);
    else localStorage.removeItem(`adminToken:${venueId}`);
    setToken(t);
  }

  async function login() {
    if (!pin.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(`${BASE}/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, pin }),
      });
      const j = await r.json();
      if (!r.ok) {
        setMsg(j.error || "Login failed");
        return;
      }
      saveToken(j.token);
      setPin("");
      onGoAdmin?.();
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    if (!token) return;
    setBusy(true);
    setMsg(null);
    try {
      await fetch(`${BASE}/admin/logout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Venue-Admin": token,
        },
        body: JSON.stringify({ venueId }),
      });
    } finally {
      saveToken(null);
      setBusy(false);
    }
  }

  async function setPinFirstTime() {
    if (!allowSetPin) return; // turvalisuse pärast
    if (!pin.trim()) {
      setMsg("Sisesta PIN.");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(`${BASE}/admin/set-pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, pin }),
      });
      const j = await r.json();
      if (!r.ok) {
        setMsg(j.error || "Set PIN failed");
        return;
      }
      setMsg("PIN salvestatud. Võid nüüd sisse logida.");
      // ära logi automaatselt sisse; jäta kasutaja endiselt login-nuppu vajutama
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-4 flex flex-col items-center gap-2">
      {token ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-[#1DB954]">✅ DJ logged in</span>
          <button
            onClick={onGoAdmin}
            className="text-xs px-3 py-1 rounded bg-white text-black"
          >
            Ava admin
          </button>
          <button
            onClick={logout}
            disabled={busy}
            className="text-xs px-3 py-1 rounded border border-gray-700 text-white"
          >
            Logi välja
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <input
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="DJ PIN"
            className="text-xs bg-[#0e0e0e] border border-gray-700 rounded px-2 py-1"
          />
          <button
            onClick={login}
            disabled={busy}
            className="text-xs px-3 py-1 rounded bg-white text-black"
          >
            DJ login
          </button>
          {allowSetPin && (
            <button
              onClick={setPinFirstTime}
              disabled={busy}
              className="text-xs px-3 py-1 rounded border border-gray-700 text-white"
              title="Sea PIN esimest korda"
            >
              Set PIN
            </button>
          )}
        </div>
      )}
      {msg && <div className="text-xs text-gray-400">{msg}</div>}
    </div>
  );
}
