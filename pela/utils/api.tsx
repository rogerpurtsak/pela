import { SUPABASE_URL, SUPABASE_ANON_KEY, projectId } from './supabase/info';

const publicAnonKey = SUPABASE_ANON_KEY;
const API_BASE = `https://${projectId}.supabase.co/functions/v1/make-server-d5eddf57`;

interface Song {
  id: string;
  title: string;
  artist: string;
  albumArt: string;
  hype: number;
}

interface NowPlaying {
  title: string;
  artist: string;
  albumArt: string;
}

export async function fetchQueue(venueId: string): Promise<Song[]> {
  const response = await fetch(`${API_BASE}/queue/${venueId}`, {
    headers: {
      'Authorization': `Bearer ${publicAnonKey}`,
    },
  });

  if (!response.ok) {
    throw new Error('Failed to fetch queue');
  }

  const data = await response.json();
  return data.queue;
}

export async function fetchSkipStatus(venueId: string) {
  const r = await fetch(`${import.meta.env.VITE_EDGE_BASE}/skip/status/${encodeURIComponent(venueId)}`, { cache: "no-store" });
  if (!r.ok) throw new Error("skip status failed");
  return r.json() as Promise<{ trackId: string|null; votes: number; threshold: number }>;
}

export async function sendSkipVote(venueId: string, sessionId: string) {
  const r = await fetch(`${import.meta.env.VITE_EDGE_BASE}/skip/vote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ venueId, sessionId }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "skip vote failed");
  return j as { ok: true; votes: number; threshold: number };
}


export async function fetchNowPlaying(venueId: string): Promise<NowPlaying | null> {
  const response = await fetch(`${API_BASE}/now-playing/${venueId}`, {
    headers: {
      'Authorization': `Bearer ${publicAnonKey}`,
    },
  });

  if (!response.ok) {
    throw new Error('Failed to fetch now playing');
  }

  const data = await response.json();
  return data.nowPlaying;
}

export async function voteForSong(venueId: string, songId: string, sessionId: string): Promise<{ hype: number }> {
  const response = await fetch(`${API_BASE}/vote`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${publicAnonKey}`,
    },
    body: JSON.stringify({ venueId, songId, sessionId }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to vote');
  }

  return await response.json();
}

export async function addSongToQueue(
  venueId: string,
  sessionId: string,
  song: { title: string; artist: string; albumArt: string }
): Promise<{ song?: Song; cooldownMinutes?: number }> {
  const response = await fetch(`${API_BASE}/add-song`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${publicAnonKey}`,
    },
    body: JSON.stringify({ venueId, sessionId, song }),
  });

  const data = await response.json();

  if (!response.ok) {
    if (response.status === 429 && data.cooldownMinutes) {
      return { cooldownMinutes: data.cooldownMinutes };
    }
    throw new Error(data.error || 'Failed to add song');
  }

  return data;
}

export async function searchSpotify(query: string): Promise<Song[]> {
  const response = await fetch(`${API_BASE}/search-spotify?q=${encodeURIComponent(query)}`, {
    headers: {
      'Authorization': `Bearer ${publicAnonKey}`,
    },
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to search Spotify');
  }

  const data = await response.json();
  return data.results;
}

export async function initDemoVenue(venueId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/init-demo/${venueId}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${publicAnonKey}`,
    },
  });

  if (!response.ok) {
    throw new Error('Failed to initialize demo venue');
  }
}
