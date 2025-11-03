import { useEffect, useState } from "react";

const BASE = "https://eahgekmtuyvclxegqolf.supabase.co/functions/v1/make-server-d5eddf57";

export function AdminBar({
  venueId,
  onGoAdmin,
}: {
  venueId: string;
  onGoAdmin: () => void;
}) {
  const [pin, setPin] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    try {
      const r = await fetch(`${BASE}/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, pin }),
      });
      const j = await r.json();
      if (!r.ok) return alert(j.error || "Login failed");
      saveToken(j.token);
      setPin("");
      onGoAdmin();
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    if (!token) return;
    setBusy(true);
    try {
      await fetch(`${BASE}/admin/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Venue-Admin": token },
        body: JSON.stringify({ venueId }),
      });
    } finally {
      saveToken(null);
      setBusy(false);
    }
  }

  return (
    <div className="mb-4 flex items-center gap-2 justify-center">
      {token ? (
        <>
          <span className="text-xs text-[#1DB954]">✅ DJ logged in</span>
          <button onClick={onGoAdmin} className="text-xs px-3 py-1 rounded bg-white text-black">
            Ava admin
          </button>
          <button onClick={logout} disabled={busy} className="text-xs px-3 py-1 rounded border border-gray-700">
            Logi välja
          </button>
        </>
      ) : (
        <>
          <input
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="DJ PIN"
            className="text-xs bg-[#0e0e0e] border border-gray-700 rounded px-2 py-1"
          />
          <button onClick={login} disabled={busy} className="text-xs px-3 py-1 rounded bg-white text-black">
            DJ login
          </button>
        </>
      )}
    </div>
  );
}
export default AdminBar;
