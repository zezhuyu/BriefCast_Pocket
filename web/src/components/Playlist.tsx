"use client";
import { usePlayer } from '@/context/PlayerContext';
import Image from 'next/image';
import { useEffect, useState } from 'react';

interface PlaylistProps {
  onSelect?: () => void;
}

const toDate = (timestamp: number) => {
  var date = new Date(timestamp * 1000);
  if (isNaN(date.getTime())) {
    date = new Date(timestamp);
  }
  const now = new Date();
  const diffTime = Math.abs(now.getTime() - date.getTime());
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  if (diffTime < 60) {
    return 'just now'; 
  }
  if (diffTime < 60 * 60) {
    return `${Math.ceil(diffTime / 60)} minutes ago`;
  }
  if (diffTime < 60 * 60 * 24) {
    return `${Math.ceil(diffTime / (60 * 60))} hours ago`;
  }
  if (diffDays < 30) {
    return `${diffDays} days ago`;
  }
  if (diffDays < 365) {
    return `${Math.ceil(diffDays / 30)} months ago`;
  }
  return `${Math.ceil(diffDays / 365)} years ago`;
}

const Playlist: React.FC<PlaylistProps> = ({ onSelect }) => {
  const { 
    playlists, 
    currentPlaylist, 
    setCurrentPlaylist, 
    currentPodcast, 
    setCurrentPodcast,
    removeFromPlaylist,
    deletePlaylist,
    createPlaylist,
    setAutoPlay
  } = usePlayer();
  
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [isCreatingPlaylist, setIsCreatingPlaylist] = useState(false);
  
  useEffect(() => {
    if(currentPlaylist && !currentPlaylist.hasOwnProperty("podcasts")) {
      const getPlaylists = async () => {
        const response = await fetch(process.env.NEXT_PUBLIC_BACKEND_URL + "playlist/" + currentPlaylist.id, {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${localStorage.getItem('authToken')}`
          }
        });
        const data = await response.json();

        setCurrentPlaylist({
          ...currentPlaylist,
          podcasts: data
        });
      }
      getPlaylists();
    }
  }, [currentPlaylist])

  
  const handleCreatePlaylist = async () => {
    if (newPlaylistName.trim()) {
      await createPlaylist(newPlaylistName.trim());
      setNewPlaylistName('');
      setIsCreatingPlaylist(false);
    }
  };
  
  const handleItemClick = (podcastId: string) => {
    // Existing click handling logic
    
    // Call onSelect if provided
    if (onSelect) {
      onSelect();
    }
  };
  
  return (
    <div className="bg-white/10 backdrop-blur-sm rounded-xl p-6 shadow-lg">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-xl font-bold text-white">Your Playlists</h3>
        
        {isCreatingPlaylist ? (
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newPlaylistName}
              onChange={(e) => setNewPlaylistName(e.target.value)}
              placeholder="Playlist name"
              className="px-3 py-1 rounded-md text-sm bg-white/20 text-white placeholder-white/50 focus:outline-none focus:ring-2 focus:ring-amber-500"
            />
            <button 
              onClick={handleCreatePlaylist}
              className="text-amber-500 hover:text-amber-400"
            >
              Save
            </button>
            <button 
              onClick={() => setIsCreatingPlaylist(false)}
              className="text-gray-400 hover:text-white"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button 
            onClick={() => setIsCreatingPlaylist(true)}
            className="text-amber-500 hover:text-amber-400 flex items-center gap-1"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New Playlist
          </button>
        )}
      </div>
      
      {/* Playlist selector */}
      <div className="flex gap-2 mb-4 overflow-x-auto pb-2">
        {playlists?.map(playlist => (
          <button
            key={playlist.id}
            onClick={() => setCurrentPlaylist(playlist)}
            className={`px-3 py-1 rounded-full text-sm whitespace-nowrap flex items-center gap-1 ${
              currentPlaylist?.id === playlist.id
                ? 'bg-amber-500 text-white'
                : 'bg-white/20 text-white hover:bg-white/30'
            }`}
          >
            {playlist.name} {/* ({playlist.podcasts.length}) */}
            {playlist.id !== 'favorite' && playlist.id !== 'like' && 
            (
              <span 
                className="text-gray-400 hover:text-red-500 cursor-pointer ml-1"
                onClick={async (e) => {
                  e.stopPropagation();
                  await deletePlaylist(playlist.id);
                }}
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </span>
            )}
          </button>
        ))}
      </div>
      
      {/* Current playlist items */}
      {currentPlaylist && (
        <div className="space-y-2 max-h-60 overflow-y-auto pr-2">
          {currentPlaylist.podcasts?.length === 0 ? (
            <p className="text-gray-400 text-center py-4">
              No podcasts in this playlist yet
            </p>
          ) : (
            currentPlaylist.podcasts?.map(podcast => (
              <div 
                key={podcast.podcast_id || podcast.id}
                className={`flex items-center gap-3 p-2 rounded-lg cursor-pointer ${
                  currentPodcast?.id === (podcast.id || podcast.podcast_id)
                    ? 'bg-amber-500/30 border border-amber-500/50'
                    : 'hover:bg-white/10'
                }`}
                onClick={() => {
                  setAutoPlay(false);
                  setCurrentPodcast(podcast);
                  // handleItemClick(podcast.id);
                }}
              >
                <div className="relative w-10 h-10 rounded-md overflow-hidden flex-shrink-0">
                  <Image
                    src={(podcast.image_url.startsWith('http') || podcast.image_url.startsWith('/api/') || podcast.image_url.startsWith('blob:') || podcast.image_url.startsWith('data:image')) ? podcast.image_url : process.env.NEXT_PUBLIC_BACKEND_URL + 'files/' + podcast.image_url}
                    alt={podcast.title}
                    fill
                    className="object-cover"
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <h4 className="text-white text-sm font-medium truncate">{podcast.title}</h4>
                  <p className="text-gray-300 text-xs truncate">{toDate(Number(podcast.added_at))}</p>
                </div>
                <button 
                  className="text-gray-400 hover:text-red-500 p-1"
                  onClick={async (e) => {
                    e.stopPropagation();
                    await removeFromPlaylist(currentPlaylist.id, podcast.podcast_id || podcast.id);
                  }}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};

export default Playlist; 

