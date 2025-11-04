import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Plus, Sparkles, Settings } from 'lucide-react';
import { Button } from './components/ui/button';
import { NowPlaying } from './components/NowPlaying';
import { QueueItem } from './components/QueueItem';
import { AddSongSheet } from './components/AddSongSheet';
import { VenueAdmin } from './components/VenueAdmin';
import AdminBar from "./components/AdminBar";
import { 
  fetchQueue, 
  fetchNowPlaying, 
  voteForSong, 
  addSongToQueue,
  initDemoVenue 
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
  const [showAdmin, setShowAdmin] = useState(isAdminMode());
  const [queue, setQueue] = useState<Song[]>([]);
  const [nowPlaying, setNowPlaying] = useState<NowPlayingData | null>(null);
  const [votedSongs, setVotedSongs] = useState<Set<string>>(new Set());
  const [isAddSheetOpen, setIsAddSheetOpen] = useState(false);
  const [cooldownMinutes, setCooldownMinutes] = useState<number | undefined>(undefined);
  const [isLiveAnimating, setIsLiveAnimating] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [sessionId] = useState(getSessionId());


  // Get venue ID from URL parameter, or use demo
function getVenueId(): string {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get('venue') || 'demo-venue';
}

function hasAdminToken(vId: string) {
  try { return !!localStorage.getItem(`adminToken:${vId}`); } catch { return false; }
}

const [hasAdmin, setHasAdmin] = useState(hasAdminToken(venueId));


useEffect(() => {
  const params = new URLSearchParams(window.location.search);
  const wantsAdmin = params.get("admin") === "true";
  const hasToken = !!localStorage.getItem(`adminToken:${venueId}`);
  if (wantsAdmin && hasToken) {
    setShowAdmin(true);
  }
  if (wantsAdmin && !hasToken) {
    setShowAdmin(false);
  }
}, [venueId]);

// kui venueId muutub, loe token uuesti
useEffect(() => {
  setHasAdmin(hasAdminToken(venueId));
}, [venueId]);

// kui keegi proovib URL-iga admin=true, aga tokenit pole, jää avalehele
useEffect(() => {
  if (showAdmin && !hasAdmin) setShowAdmin(false);
}, [showAdmin, hasAdmin]);


// Check if admin mode is enabled
function isAdminMode(): boolean {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get('admin') === 'true';
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

  // Show admin panel if requested
  if (showAdmin) {
    return <VenueAdmin venueId={venueId !== 'demo-venue' ? venueId : undefined} />;
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#0e0e0e] flex items-center justify-center">
        <div className="text-center">
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
            className="w-12 h-12 border-4 border-[#1DB954] border-t-transparent rounded-full mx-auto mb-4"
          />
          <p className="text-gray-400">Laadin queue'd...</p>
        </div>
      </div>
    );
  }

  const goAdmin = () => {
    setShowAdmin(true);
    const u = new URL(window.location.href);
    u.searchParams.set("admin", "true");
    window.history.replaceState(null, "", u.toString());
  };

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
          className="absolute bottom-0 right-0 w-96 h-96 bg-purple-600/10 rounded-full blur-[120px]"
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
            <h1 className="text-3xl bg-gradient-to-r from-[#1DB954] to-purple-500 bg-clip-text text-transparent">
              Hype Queue
            </h1>
            <motion.div
              animate={{
                rotate: isLiveAnimating ? 360 : 0,
              }}
              transition={{ duration: 1 }}
              className="w-2 h-2 bg-[#1DB954] rounded-full"
            />
          </div>
          <p className="text-gray-400 text-sm">Hääletusaktiivsete lugude järjekord</p>
          
          {/* Admin link for venue owners */}
          {venueId === 'demo-venue' && (
            <button
              onClick={() => {
                if (hasAdmin) setShowAdmin(true);
                else alert("DJ PIN on nõutud. Logi sisse ülal asuva DJ login ribaga.");
              }}
              className="mt-2 text-xs text-gray-600 hover:text-[#1DB954] transition-colors flex items-center gap-1 mx-auto"
            >
              Loo oma venue
            </button>
          )}
        </motion.div>
        <AdminBar venueId={venueId} onGoAdmin={goAdmin} allowSetPin />

        {/* Now Playing */}
        {nowPlaying && <NowPlaying song={nowPlaying} />}

        {/* Queue */}
        <div className="space-y-3 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-gray-400 text-sm uppercase tracking-wider">Järgmisena</h2>
            <div className="flex items-center gap-2 text-gray-500 text-sm">
              <Sparkles className="w-4 h-4" />
              <span>Live</span>
            </div>
          </div>

          {queue.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              <p>Järjekord on tühi</p>
              <p className="text-sm mt-2">Ole esimene, kes lisab laulu!</p>
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
          <p>🎵 Hype Queue powered by Spotify</p>
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
          className="h-16 px-8 bg-gradient-to-r from-[#1DB954] to-[#1ed760] hover:from-[#1ed760] hover:to-[#1DB954] text-white rounded-full shadow-2xl shadow-[#1DB954]/50 relative overflow-hidden group"
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
            <span>Lisa lugu</span>
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
