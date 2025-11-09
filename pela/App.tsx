import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Button } from './components/ui/button';
import { QueueItem } from './components/QueueItem';
import { AddSongSheet } from './components/AddSongSheet';
import { PlaybackProgress } from "./components/PlaybackProgress";
import { NowPlayingCard } from './components/NowPlayingCard';
import { Plus, Sparkles } from 'lucide-react';

import { 
  fetchQueue, 
  fetchNowPlaying, 
  voteForSong, 
  addSongToQueue,
  initDemoVenue,
  fetchSkipStatus,
  sendSkipVote
} from './utils/api';
import { createClient } from './utils/supabase/client';

interface Song {
  id: string;
  title: string;
  artist: string;
  albumArt: string;
  hype: number;
}

interface NowPlayingData {
  title: string;
  artist: string;
  albumArt: string;
}


export default function App() {
  const [venueId] = useState(getVenueId());
  const [queue, setQueue] = useState<Song[]>([]);
  const [nowPlaying, setNowPlaying] = useState<NowPlayingData | null>(null);
  const [votedSongs, setVotedSongs] = useState<Set<string>>(new Set());
  const [isAddSheetOpen, setIsAddSheetOpen] = useState(false);
  const [cooldownMinutes, setCooldownMinutes] = useState<number | undefined>(undefined);
  const [isLiveAnimating, setIsLiveAnimating] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [sessionId] = useState(getSessionId());
  const [skip, setSkip] = useState<{trackId: string|null; votes: number; threshold: number}>({trackId: null, votes: 0, threshold: 5});
  const [skipVotedForTrack, setSkipVotedForTrack] = useState<string|null>(null);


  const [nowLive, setNowLive] = useState<{
  startedAt: number | null;
  duration_ms: number;
  is_playing: boolean;
  item: { name: string; artists: string; albumArt: string; uri: string; id: string } | null;
} | null>(null);
  const BASE = import.meta.env.VITE_EDGE_BASE as string;


  useEffect(() => {
  if (!venueId) return;
  let alive = true;

  const loadSkip = async () => {
    try {
      const s = await fetchSkipStatus(venueId);
      if (!alive) return;
      setSkip(s);
      // kui lugu vahetus, tühista kohaliku nupu “already voted” märge
      if (skipVotedForTrack && s.trackId && s.trackId !== skipVotedForTrack) {
        setSkipVotedForTrack(null);
      }
    } catch {}
  };

  const id = setInterval(loadSkip, 3000);
  loadSkip();
  return () => { alive = false; clearInterval(id); };
}, [venueId, skipVotedForTrack]);

function onSkipVote() {
  if (!venueId) return;
  if (!skip.trackId) return;

  if (skipVotedForTrack === skip.trackId) return;

  sendSkipVote(venueId, sessionId)
    .then((res) => {
      setSkip((s) => ({ ...s, votes: res.votes, threshold: res.threshold }));
      setSkipVotedForTrack(skip.trackId!);
    })
    .catch((e) => alert(e.message));
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


  const goAdmin = () => {
    if (!hasAdminToken(venueId)) {
      alert("DJ PIN on nõutud. Logi sisse DJ vaates.");
      return;
    }
    const u = new URL(window.location.href);
    u.pathname = "/dj";
    u.searchParams.set("venue", venueId);
    u.searchParams.delete("admin");
    window.location.href = u.toString();
  };

  function goAudience() {
    if (!venueId) { alert("Genereeri kõigepealt venue ID."); return; }
    const u = new URL(window.location.href);
    u.pathname = "/";
    u.searchParams.set("venue", venueId);
    window.location.href = u.toString();
  }

  // Get venue ID from URL parameter, or use demo
function getVenueId(): string {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get('venue') || 'demo-venue';
}

// Generate or retrieve session ID
function getSessionId(): string {
  let sessionId = localStorage.getItem('hype-queue-session');
  if (!sessionId) {
    sessionId = `session-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    localStorage.setItem('hype-queue-session', sessionId);
  }
  return sessionId;
}

// Initialize demo data and load queue
useEffect(() => {
  async function init() {
    try {
      // Initialize demo venue with sample data (only for demo-venue)
        if (venueId === 'demo-venue') {
          await initDemoVenue(venueId);
        }
        
        // Load queue and now playing
        const [queueData, nowPlayingData] = await Promise.all([
          fetchQueue(venueId),
          fetchNowPlaying(venueId),
        ]);
        
        setQueue(queueData);
        setNowPlaying(nowPlayingData);
        
        // Load voted songs from localStorage
        const voted = localStorage.getItem(`voted-${venueId}`);
        if (voted) {
          setVotedSongs(new Set(JSON.parse(voted)));
        }
      } catch (error) {
        console.error('Failed to initialize:', error);
      } finally {
        setIsLoading(false);
      }
    }

    init();
  }, [venueId]);

  // Set up realtime subscription to queue changes
  useEffect(() => {
    const supabase = createClient();
    
    // Subscribe to KV store changes
    const channel = supabase
      .channel('queue-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'kv_store_d5eddf57',
          filter: `key=like.queue:${venueId}:%`
        },
        async (payload: any) => {
          console.log('Queue updated:', payload);
          // Refresh queue when changes detected
          try {
            const queueData = await fetchQueue(venueId);
            setQueue(queueData);
            setIsLiveAnimating(true);
            setTimeout(() => setIsLiveAnimating(false), 1000);
          } catch (error) {
            console.error('Failed to refresh queue:', error);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [venueId]);

  // Poll for updates every 5 seconds as fallback
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const queueData = await fetchQueue(venueId);
        setQueue(queueData);
        setIsLiveAnimating(true);
        setTimeout(() => setIsLiveAnimating(false), 1000);
      } catch (error) {
        console.error('Failed to poll queue:', error);
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [venueId]);

  const handleVote = async (songId: string) => {
    if (votedSongs.has(songId)) return;

    try {
      const result = await voteForSong(venueId, songId, sessionId);
      
      // Update local state optimistically
      setQueue(prevQueue =>
        prevQueue.map(song =>
          song.id === songId ? { ...song, hype: result.hype } : song
        )
      );
      
      // Mark as voted
      const newVoted = new Set(votedSongs).add(songId);
      setVotedSongs(newVoted);
      localStorage.setItem(`voted-${venueId}`, JSON.stringify([...newVoted]));
    } catch (error) {
      console.error('Failed to vote:', error);
    }
  };

  const handleAddSong = async (newSong: { id: string; title: string; artist: string; albumArt: string }) => {
    try {
      const result = await addSongToQueue(venueId, sessionId, {
        title: newSong.title,
        artist: newSong.artist,
        albumArt: newSong.albumArt,
      });

      if (result.cooldownMinutes) {
        setCooldownMinutes(result.cooldownMinutes);
        // Don't close the sheet, show cooldown message
      } else if (result.song) {
        // Song added successfully
        setQueue(prevQueue => [...prevQueue, result.song!]);
        setIsAddSheetOpen(false);
        setCooldownMinutes(undefined);
      }
    } catch (error) {
      console.error('Failed to add song:', error);
      alert('Vabandust, laulu lisamine ebaõnnestus. Proovi uuesti.');
    }
  };

  const handleOpenAddSheet = () => {
    setCooldownMinutes(undefined); // Reset cooldown when opening
    setIsAddSheetOpen(true);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#0e0e0e] flex items-center justify-center">
        <div className="text-center">
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
            className="w-12 h-12 border-4 border-[#1DB954] border-t-transparent rounded-full mx-auto mb-4"
          />
          <p className="text-gray-400">Loading the queue...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0e0e0e] text-white">
      {/* Background gradient effects */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <motion.div
          className="absolute top-0 left-0 w-96 h-96 bg-[#1DB954]/10 rounded-full blur-[120px]"
          animate={{
            x: [0, 100, 0],
            y: [0, 50, 0],
          }}
          transition={{
            duration: 20,
            repeat: Infinity,
            ease: "easeInOut"
          }}
        />
        <motion.div
          className="absolute bottom-0 right-0 w-96 h-96 bg-[#8ec5fc]/10 rounded-full blur-[120px]"
          animate={{
            x: [0, -100, 0],
            y: [0, -50, 0],
          }}
          transition={{
            duration: 15,
            repeat: Infinity,
            ease: "easeInOut"
          }}
        />
      </div>

      {/* Main content */}
      <div className="relative max-w-2xl mx-auto px-4 py-8 pb-32">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-8"
        >
          <div className="flex items-center justify-center gap-2 mb-2">
            <h1 className="text-3xl bg-gradient-to-r from-[#e0c3fc] to-[#8ec5fc] bg-clip-text text-transparent">
              pela
            </h1>
            <motion.div
              animate={{
                rotate: isLiveAnimating ? 360 : 0,
              }}
              transition={{ duration: 1 }}
              className="w-2 h-2 bg-[#1DB954] rounded-full"
            />
          </div>
          <p className="text-gray-400 text-sm">lugude järjekord h22letustega</p>
          
        </motion.div>

        {/* Now Playing */}
        <NowPlayingCard
          song={
            nowLive?.item
              ? {
                  title:  nowLive.item.name,
                  artist: nowLive.item.artists,
                  albumArt: nowLive.item.albumArt,
                }
              : (nowPlaying || null) // ← Fallback sinu olemasolevast fetchNowPlaying() tulemist
          }
        />

        {nowLive?.item && (
          <PlaybackProgress
            isPlaying={nowLive.is_playing}
            startedAt={nowLive.startedAt}
            durationMs={nowLive.duration_ms}
          />
        )}

        {skip.trackId && (
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={onSkipVote}
              disabled={skipVotedForTrack === skip.trackId}
              className={`px-3 py-1 rounded-full text-sm border ${
                skipVotedForTrack === skip.trackId
                  ? "opacity-50 cursor-not-allowed border-gray-700 text-gray-400"
                  : "border-[#1DB954] text-[#1DB954] hover:bg-[#1DB954]/10"
              }`}
            >
              {skipVotedForTrack === skip.trackId ? "Voted to skip" : "Vote to skip"}
            </button>
            <div className="text-xs text-gray-400">
              {skip.votes} / {skip.threshold}
            </div>
          </div>
        )}


        {/* Queue */}
        <div className="space-y-3 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-gray-400 text-sm uppercase tracking-wider">next up</h2>
            <div className="flex items-center gap-2 text-gray-500 text-sm">
              <Sparkles className="w-4 h-4" />
              <span>Live</span>
            </div>
          </div>

          {queue.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              <p>jarjekord on tuhi</p>
              <p className="text-sm mt-2">ole esimene, kes lisab laulu</p>
            </div>
          ) : (
            <AnimatePresence mode="popLayout">
              {queue.map((song, index) => (
                <QueueItem
                  key={song.id}
                  song={song}
                  index={index}
                  onVote={handleVote}
                  hasVoted={votedSongs.has(song.id)}
                />
              ))}
            </AnimatePresence>
          )}
        </div>

        {/* Footer */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5 }}
          className="text-center text-gray-600 text-xs mt-8"
        >
          <p>pela powered by Spotify</p>
        </motion.div>
      </div>

      {/* Floating Add Button */}
      <motion.div
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ delay: 0.3, type: "spring", stiffness: 260, damping: 20 }}
        className="fixed bottom-8 left-1/2 -translate-x-1/2"
      >
        <Button
          onClick={handleOpenAddSheet}
          className="h-16 px-8 bg-gradient-to-r from-[#1DB954] to-[#1ed760] hover:from-[#1ed760] hover:to-[#1DB954] hover:rotate-180 hover:scale-110 text-white rounded-full shadow-2xl shadow-[#1DB954]/50 relative overflow-hidden group cursor-pointer"
        >
          <motion.div
            className="absolute inset-0 bg-white/20"
            animate={{
              scale: [1, 1.5, 1],
              opacity: [0, 0.5, 0],
            }}
            transition={{
              duration: 2,
              repeat: Infinity,
              ease: "easeInOut"
            }}
          />
          <span className="relative flex items-center gap-2">
            <Plus className="w-5 h-5" />
            <span>lisa laul</span>
          </span>
        </Button>
      </motion.div>

      {/* Add Song Sheet */}
      <AddSongSheet
        open={isAddSheetOpen}
        onOpenChange={setIsAddSheetOpen}
        onAddSong={handleAddSong}
        cooldownMinutes={cooldownMinutes}
      />
    </div>
  );
}
