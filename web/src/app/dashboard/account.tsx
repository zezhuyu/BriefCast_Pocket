"use client";
import { useState, useEffect } from "react";
import axios from "axios";

interface UserInfo {
  id: string;
  preference: Record<string, string[]>;
  location: [number, number];
  tokens: string[];
}

interface HistoryItem {
  id: string;
  title: string;
  image_url: string;
  duration_seconds: number;
  published_at: string;
  stop_position_seconds?: number;
  listened_at?: string;
}

interface Playlist {
  id: string;
  name: string;
  description: string;
  created_at: string;
}

interface Token {
  token: string;
  device_type: string;
  created_at: string;
}

export default function AccountPage( {username, setUsername, isTauri}: {username: string, setUsername: (username: string) => void, isTauri: boolean } ) {
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [loading, setLoading] = useState(true);
  const [tokenLoading, setTokenLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'profile' | 'history' | 'playlists' | 'tokens'>('profile');
  const [issuingToken, setIssuingToken] = useState(false);
  const [revokingTokens, setRevokingTokens] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetchUserData();
  }, []);

  useEffect(() => {
    if (activeTab === 'tokens') {
      fetchTokens();
    }
  }, [activeTab]);

  const fetchUserData = async () => {
    try {
      setLoading(true);
      setError(null);

      // Fetch user info, history, and playlists in parallel
      const [userResponse, historyResponse, playlistsResponse] = await Promise.all([
        axios.get(`${process.env.NEXT_PUBLIC_BACKEND_URL}user`, {
          headers: {
            "Authorization": `Bearer ${localStorage.getItem('authToken')}`
          }
        }),
        axios.get(`${process.env.NEXT_PUBLIC_BACKEND_URL}history`, {
          headers: {
            "Authorization": `Bearer ${localStorage.getItem('authToken')}`
          }
        }),
        axios.get(`${process.env.NEXT_PUBLIC_BACKEND_URL}playlists`, {
          headers: {
            "Authorization": `Bearer ${localStorage.getItem('authToken')}`
          }
        })
      ]);

      setUserInfo(userResponse.data);
      setUsername(userResponse.data.id);
      setHistory(historyResponse.data);
      setPlaylists(playlistsResponse.data);
    } catch (err: any) {
      console.error("Error fetching user data:", err);
      setError(err.response?.data?.error || "Failed to load user data");
    } finally {
      setLoading(false);
    }
  };

  const fetchTokens = async () => {
    try {
      setTokenLoading(true);
      const response = await axios.get(`${process.env.NEXT_PUBLIC_BACKEND_URL}token`, {
        headers: {
          "Authorization": `Bearer ${localStorage.getItem('authToken')}`
        }
      });
      setTokens(response.data);
    } catch (err: any) {
      console.error("Error fetching tokens:", err);
      setError(err.response?.data?.error || "Failed to load tokens");
    } finally {
      setTokenLoading(false);
    }
  };

  const issueNewToken = async () => {
    if (!userInfo) return;
    
    try {
      setIssuingToken(true);
      const response = await axios.post(`${process.env.NEXT_PUBLIC_BACKEND_URL}token`, {
        user_id: userInfo.id
      }, {
        headers: {
          "Authorization": `Bearer ${localStorage.getItem('authToken')}`
        }
      });
      
      // Refresh token list after issuing
      await fetchTokens();
    } catch (err: any) {
      console.error("Error issuing token:", err);
      alert(err.response?.data?.error || "Failed to issue new token");
    } finally {
      setIssuingToken(false);
    }
  };

  const revokeToken = async (token: string) => {
    if (!userInfo) return;

    try {
      setRevokingTokens(prev => new Set(prev).add(token));
      await axios.delete(`${process.env.NEXT_PUBLIC_BACKEND_URL}token`, {
        data: {
          user_id: userInfo.id,
          token: token
        },
        headers: {
          "Authorization": `Bearer ${localStorage.getItem('authToken')}`
        }
      });
      
      // Refresh token list after revoking
      await fetchTokens();
    } catch (err: any) {
      console.error("Error revoking token:", err);
      alert(err.response?.data?.error || "Failed to revoke token");
    } finally {
      setRevokingTokens(prev => {
        const newSet = new Set(prev);
        newSet.delete(token);
        return newSet;
      });
    }
  };

  const formatDuration = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  };

  const getProgressPercentage = (stopPosition: number, duration: number) => {
    return Math.min((stopPosition / duration) * 100, 100);
  };

  const truncateToken = (token: string) => {
    if (token.length <= 16) return token;
    return `${token.substring(0, 8)}...${token.substring(token.length - 8)}`;
  };

  if (loading) {
    return (
      <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-amber-400 mx-auto mb-3"></div>
          <p className="text-white/80 text-sm">Loading your account...</p>
        </div>
    );
  }

  if (error) {
    return (
      <div className="text-center">
          <div className="bg-red-500/20 border border-red-500/50 rounded-lg p-4 max-w-md">
            <h2 className="text-red-200 text-base font-semibold mb-2">Error Loading Account</h2>
            <p className="text-red-300 text-sm mb-3">{error}</p>
            <button
              onClick={fetchUserData}
              className="bg-red-500 hover:bg-red-600 text-white px-3 py-1.5 text-sm rounded-md transition-colors"
            >
              Try Again
            </button>
          </div>
        </div>
    );
  }

  return (
    <div className="container mx-auto px-3 py-4">
        {/* Header */}
        <div className="text-center mb-4">
          <h1 className="text-2xl font-bold text-white mb-1">My Account</h1>
          <p className="text-white/70 text-sm">Manage your profile and preferences</p>
        </div>

        {/* Navigation Tabs */}
        <div className="flex justify-center mb-4">
          <div className="bg-white/10 backdrop-blur-md rounded-lg p-1 flex space-x-1">
            {[
              { key: 'profile', label: 'Profile', icon: '👤' },
              { key: 'tokens', label: 'Tokens', icon: '🔑' },
              { key: 'playlists', label: 'Playlists', icon: '🎵' }
            ].map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key as any)}
                className={`px-3 py-2 text-sm rounded-md font-medium transition-all duration-200 flex items-center space-x-1.5 ${
                  activeTab === tab.key
                    ? 'bg-amber-500 text-white shadow-lg'
                    : 'text-white/70 hover:text-white hover:bg-white/10'
                }`}
              >
                <span className="text-xs">{tab.icon}</span>
                <span>{tab.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="max-w-4xl mx-auto">
          {activeTab === 'profile' && (
            <div className="bg-white/10 backdrop-blur-md rounded-lg p-4 shadow-xl">
              <h2 className="text-lg font-bold text-white mb-4 flex items-center">
                <span className="mr-2 text-sm">👤</span>
                Profile Information
              </h2>
              
              {userInfo && (
                <div className="h-96 overflow-y-auto pr-2 scrollbar-thin scrollbar-thumb-white/20 scrollbar-track-transparent hover:scrollbar-thumb-white/30">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* User ID */}
                    <div>
                      <label className="block text-white/80 text-xs font-medium mb-1">User ID</label>
                      <div className="bg-white/5 border border-white/20 rounded-md p-2 text-white text-sm">
                        {userInfo.id}
                      </div>
                    </div>

                    {/* Location */}
                    <div>
                      <label className="block text-white/80 text-xs font-medium mb-1">Location</label>
                      <div className="bg-white/5 border border-white/20 rounded-md p-2 text-white text-sm">
                        {userInfo.location[0] === 0 && userInfo.location[1] === 0 
                          ? 'Not set' 
                          : `${userInfo.location[0]}, ${userInfo.location[1]}`
                        }
                      </div>
                    </div>

                    

                    {/* Preferences - Full Width */}
                    <div className="md:col-span-2">
                      <label className="block text-white/80 text-xs font-medium mb-1">Topics of Interest</label>
                      <div className="bg-white/5 border border-white/20 rounded-md p-3">
                          {userInfo.preference && Object.keys(userInfo.preference).length > 0 ? (
                          <div className="space-y-2">
                            {Object.entries(userInfo.preference.subtopics).map(([topic, subtopics]) => (
                              <div key={topic}>
                                <div className="flex items-center flex-wrap gap-2">
                                  <span className="bg-amber-500/20 text-amber-200 px-2 py-1 rounded-full text-xs border border-amber-500/30">
                                    {topic}
                                  </span>
                                  {subtopics.length > 0 && (
                                    <span className="text-white/60 text-xs">
                                      {subtopics.length} subtopic{subtopics.length !== 1 ? 's' : ''}
                                    </span>
                                  )}
                                </div>
                                {Array.isArray(subtopics) && subtopics.length > 0 && (
                                  <div className="flex flex-wrap gap-1 mt-1 ml-2">
                                    {subtopics.map((subtopic: string, index: number) => (
                                      <span
                                        key={index}
                                        className="bg-blue-500/20 text-blue-200 px-1.5 py-0.5 rounded text-xs border border-blue-500/30"
                                      >
                                        {subtopic}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-white/60 text-sm">No topics selected</p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'tokens' && (
            <div className="bg-white/10 backdrop-blur-md rounded-lg p-4 shadow-xl">
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-lg font-bold text-white flex items-center">
                  <span className="mr-2 text-sm">🔑</span>
                  API Tokens
                </h2>
                <div className="flex space-x-2">
                  <button
                    onClick={fetchTokens}
                    disabled={tokenLoading}
                    className="bg-blue-500 hover:bg-blue-600 text-white px-3 py-1.5 text-sm rounded-md transition-colors flex items-center space-x-1.5 disabled:opacity-50"
                  >
                    {tokenLoading ? (
                      <svg className="w-3 h-3 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                    ) : (
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                    )}
                    <span>Refresh</span>
                  </button>
                  <button
                    onClick={issueNewToken}
                    disabled={issuingToken}
                    className="bg-amber-500 hover:bg-amber-600 text-white px-3 py-1.5 text-sm rounded-md transition-colors flex items-center space-x-1.5 disabled:opacity-50"
                  >
                    {issuingToken ? (
                      <svg className="w-3 h-3 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                    ) : (
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                      </svg>
                    )}
                    <span>Issue Token</span>
                  </button>
                </div>
              </div>
              
              {tokenLoading ? (
                <div className="text-center py-8">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-amber-400 mx-auto mb-3"></div>
                  <p className="text-white/80 text-sm">Loading tokens...</p>
                </div>
              ) : tokens.length > 0 ? (
                <div className="h-96 overflow-y-auto pr-2 scrollbar-thin scrollbar-thumb-white/20 scrollbar-track-transparent hover:scrollbar-thumb-white/30">
                  <div className="space-y-3">
                    {tokens.map((tokenData, index) => (
                      <div key={index} className="bg-white/5 border border-white/20 rounded-md p-3 hover:bg-white/10 transition-colors">
                        <div className="flex items-center justify-between">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center space-x-2 mb-2">
                              <span className="bg-green-500/20 text-green-300 px-2 py-1 rounded-full text-xs border border-green-500/30">
                                {tokenData.device_type}
                              </span>
                              <span className="text-white/60 text-xs">
                                Created: {formatDate(tokenData.created_at)}
                              </span>
                            </div>
                            <div className="bg-gray-800/50 rounded-md p-2 font-mono text-xs">
                              <div className="flex items-center justify-between">
                                <span className="text-white/80 truncate">
                                  {truncateToken(tokenData.token)}
                                </span>
                                <button
                                  onClick={() => navigator.clipboard.writeText(tokenData.token)}
                                  className="ml-2 p-1 hover:bg-white/10 rounded text-white/60 hover:text-white transition-colors"
                                  title="Copy token"
                                >
                                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                  </svg>
                                </button>
                              </div>
                            </div>
                          </div>
                          <button
                            onClick={() => revokeToken(tokenData.token)}
                            disabled={revokingTokens.has(tokenData.token)}
                            className="ml-3 p-2 rounded text-xs bg-red-500/20 text-red-300 border border-red-500/30 hover:bg-red-500/30 disabled:opacity-50 transition-colors"
                            title="Revoke token"
                          >
                            {revokingTokens.has(tokenData.token) ? (
                              <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                              </svg>
                            ) : (
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            )}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="text-center py-8">
                  <div className="text-4xl mb-3">🔑</div>
                  <p className="text-white/60 text-base">No API tokens issued</p>
                  <p className="text-white/40 text-xs">Issue your first token to access the API</p>
                </div>
              )}
            </div>
          )}

         

          {activeTab === 'playlists' && (
            <div className="bg-white/10 backdrop-blur-md rounded-lg p-4 shadow-xl">
              <h2 className="text-lg font-bold text-white mb-4 flex items-center">
                <span className="mr-2 text-sm">🎵</span>
                My Playlists
              </h2>
              
              {playlists.length > 0 ? (
                <div className="h-96 overflow-y-auto pr-2 scrollbar-thin scrollbar-thumb-white/20 scrollbar-track-transparent hover:scrollbar-thumb-white/30">
                  <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                    {playlists.map((playlist) => (
                      <div key={playlist.id} className="bg-white/5 border border-white/20 rounded-md p-4 hover:bg-white/10 transition-colors">
                        <div className="text-center">
                          <div className="text-2xl mb-2">🎵</div>
                          <h3 className="text-white font-medium text-sm mb-1 truncate">{playlist.name}</h3>
                          {playlist.description && (
                            <p className="text-white/60 text-xs mb-2 line-clamp-2">{playlist.description}</p>
                          )}
                          <p className="text-white/40 text-xs">
                            Created: {formatDate(playlist.created_at)}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="text-center py-8">
                  <div className="text-4xl mb-3">🎵</div>
                  <p className="text-white/60 text-base">No playlists created yet</p>
                  <p className="text-white/40 text-xs">Create your first playlist to organize your favorite podcasts</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Refresh Button */}
        <div className="text-center mt-4">
          <button
            onClick={fetchUserData}
            className="bg-amber-500 hover:bg-amber-600 text-white font-semibold py-2 px-4 text-sm rounded-md transition-colors duration-200 flex items-center space-x-2 mx-auto"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            <span>Refresh Data</span>
          </button>
        </div>
      </div>
  );
}
