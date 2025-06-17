"use client";
import { useState, useEffect } from "react";
import axios from "axios";

interface RSSLink {
  id: number;
  link: string;
  country: string;
  category: string;
  lastCheck: number | null;
  available: boolean;
}

interface FormData {
  link: string;
  country: string;
  category: string;
}

interface EnvVariable {
  key: string;
  value: string;
}

const COUNTRIES = [
  "GLOBAL", "US", "UK", "CA", "AU", "DE", "FR", "JP", "CN", "IN", "BR", "RU", "MX", "IT", "ES"
];

const CATEGORIES = [
  "GENERAL", "TECHNOLOGY", "BUSINESS", "POLITICS", "SPORTS", "ENTERTAINMENT", 
  "HEALTH", "SCIENCE", "WORLD", "LOCAL", "OPINION", "LIFESTYLE"
];

export default function ServerConfigPage( {isTauri}: {isTauri: boolean} ) {
  const [activeTab, setActiveTab] = useState<'rss' | 'env'>('rss');
  const [rssLinks, setRssLinks] = useState<RSSLink[]>([]);
  const [envVariables, setEnvVariables] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [envLoading, setEnvLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [showEnvForm, setShowEnvForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingEnvKey, setEditingEnvKey] = useState<string | null>(null);
  const [forceRefresh, setForceRefresh] = useState(false);
  const [formData, setFormData] = useState<FormData>({
    link: "",
    country: "GLOBAL",
    category: "GENERAL"
  });
  const [envFormData, setEnvFormData] = useState<EnvVariable>({
    key: "",
    value: ""
  });
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [envFormErrors, setEnvFormErrors] = useState<Record<string, string>>({});
  const [testingLinks, setTestingLinks] = useState<Set<number>>(new Set());
  const [refreshingLinks, setRefreshingLinks] = useState<Set<number>>(new Set());
  const [actionLoading, setActionLoading] = useState<Set<number>>(new Set());
  const [envSaving, setEnvSaving] = useState(false);

  useEffect(() => {
    if (activeTab === 'rss') {
      fetchRSSLinks();
    } else {
      fetchEnvVariables();
    }
  }, [activeTab]);

  const fetchRSSLinks = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await axios.get(`${process.env.NEXT_PUBLIC_BACKEND_URL}rss`, {
        headers: {
          "Authorization": `Bearer ${localStorage.getItem('authToken')}`
        }
      });
      setRssLinks(response.data);
    } catch (err: any) {
      console.error("Error fetching RSS links:", err);
      setError(err.response?.data?.error || "Failed to load RSS links");
    } finally {
      setLoading(false);
    }
  };

  const fetchEnvVariables = async () => {
    try {
      setEnvLoading(true);
      setError(null);
      const response = await axios.get(`${process.env.NEXT_PUBLIC_BACKEND_URL}config`, {
        headers: {
          "Authorization": `Bearer ${localStorage.getItem('authToken')}`
        }
      });
      setEnvVariables(response.data);
    } catch (err: any) {
      console.error("Error fetching environment variables:", err);
      setError(err.response?.data?.error || "Failed to load environment variables");
    } finally {
      setEnvLoading(false);
    }
  };

  const validateForm = () => {
    const errors: Record<string, string> = {};
    
    if (!formData.link.trim()) {
      errors.link = "RSS link is required";
    } else if (!isValidUrl(formData.link)) {
      errors.link = "Please enter a valid URL";
    }
    
    if (!formData.country) {
      errors.country = "Country is required";
    }
    
    if (!formData.category) {
      errors.category = "Category is required";
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const validateEnvForm = () => {
    const errors: Record<string, string> = {};
    
    if (!envFormData.key.trim()) {
      errors.key = "Environment variable key is required";
    } else if (!/^[A-Z_][A-Z0-9_]*$/i.test(envFormData.key)) {
      errors.key = "Key must contain only letters, numbers, and underscores";
    }
    
    if (!envFormData.value.trim()) {
      errors.value = "Environment variable value is required";
    }

    setEnvFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const isValidUrl = (string: string) => {
    try {
      new URL(string);
      return true;
    } catch (_) {
      return false;
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));
    // Clear error when user starts typing
    if (formErrors[name]) {
      setFormErrors(prev => ({
        ...prev,
        [name]: ""
      }));
    }
  };

  const handleLinksRefresh = async () => {
    try {
      const response = await axios.get(`${process.env.NEXT_PUBLIC_BACKEND_URL}rss/refresh`, {
        headers: {
          "Authorization": `Bearer ${localStorage.getItem('authToken')}`
        }
      });
      if (response.status === 200) {
        setForceRefresh(true);
      }
    } catch (err: any) {
      console.error("Error refreshing RSS links:", err);
    }
  };

  const handleEnvInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setEnvFormData(prev => ({
      ...prev,
      [name]: value
    }));
    // Clear error when user starts typing
    if (envFormErrors[name]) {
      setEnvFormErrors(prev => ({
        ...prev,
        [name]: ""
      }));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!validateForm()) {
      return;
    }

    try {
      if (editingId) {
        // Update existing RSS link
        await axios.put(`${process.env.NEXT_PUBLIC_BACKEND_URL}rss/${editingId}`, formData, {
          headers: {
            "Authorization": `Bearer ${localStorage.getItem('authToken')}`
          }
        } );
      } else {
        // Add new RSS link
        await axios.post(`${process.env.NEXT_PUBLIC_BACKEND_URL}rss`, formData, {
          headers: {
            "Authorization": `Bearer ${localStorage.getItem('authToken')}`
          }
        });
      }
      
      await fetchRSSLinks();
      resetForm();
    } catch (err: any) {
      console.error("Error saving RSS link:", err);
      setFormErrors({
        general: err.response?.data?.error || "Failed to save RSS link"
      });
    }
  };

  const handleEnvSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!validateEnvForm()) {
      return;
    }

    try {
      setEnvSaving(true);
      const configData = { [envFormData.key]: envFormData.value };
      await axios.post(`${process.env.NEXT_PUBLIC_BACKEND_URL}config`, configData, {
        headers: {
          "Authorization": `Bearer ${localStorage.getItem('authToken')}`
        }
      });
      
      await fetchEnvVariables();
      resetEnvForm();
    } catch (err: any) {
      console.error("Error saving environment variable:", err);
      setEnvFormErrors({
        general: err.response?.data?.error || "Failed to save environment variable"
      });
    } finally {
      setEnvSaving(false);
    }
  };

  const handleEdit = (link: RSSLink) => {
    setEditingId(link.id);
    setFormData({
      link: link.link,
      country: link.country,
      category: link.category
    });
    setShowAddForm(true);
  };

  const handleEnvEdit = (key: string, value: string) => {
    setEditingEnvKey(key);
    setEnvFormData({
      key: key,
      value: value
    });
    setShowEnvForm(true);
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Are you sure you want to delete this RSS link?")) {
      return;
    }

    try {
      setActionLoading(prev => new Set(prev).add(id));
      await axios.delete(`${process.env.NEXT_PUBLIC_BACKEND_URL}rss/${id}`, {
        headers: {
          "Authorization": `Bearer ${localStorage.getItem('authToken')}`
        }
      });
      await fetchRSSLinks();
    } catch (err: any) {
      console.error("Error deleting RSS link:", err);
      alert(err.response?.data?.error || "Failed to delete RSS link");
    } finally {
      setActionLoading(prev => {
        const newSet = new Set(prev);
        newSet.delete(id);
        return newSet;
      });
    }
  };

  const handleTestLink = async (id: number) => {
    try {
      setTestingLinks(prev => new Set(prev).add(id));
      const response = await axios.get(`${process.env.NEXT_PUBLIC_BACKEND_URL}rss/${id}/check`, {
        headers: {
          "Authorization": `Bearer ${localStorage.getItem('authToken')}`
        }
      });
      
      // Refresh the specific link status after test
      await refreshLinkStatus(id);
    } catch (err: any) {
    } finally {
      setTestingLinks(prev => {
        const newSet = new Set(prev);
        newSet.delete(id);
        return newSet;
      });
    }
  };

  const refreshLinkStatus = async (id: number) => {
    try {
      setRefreshingLinks(prev => new Set(prev).add(id));
      const response = await axios.get(`${process.env.NEXT_PUBLIC_BACKEND_URL}rss/${id}`, {
        headers: {
          "Authorization": `Bearer ${localStorage.getItem('authToken')}`
        }
      });
      
      // Update the specific link in the state
      setRssLinks(prev => prev.map(link => 
        link.id === id ? { ...link, ...response.data } : link
      ));
    } catch (err: any) {
      console.error("Error refreshing RSS link status:", err);
      alert(err.response?.data?.error || "Failed to refresh RSS link status");
    } finally {
      setRefreshingLinks(prev => {
        const newSet = new Set(prev);
        newSet.delete(id);
        return newSet;
      });
    }
  };

  const resetForm = () => {
    setFormData({
      link: "",
      country: "GLOBAL",
      category: "GENERAL"
    });
    setFormErrors({});
    setShowAddForm(false);
    setEditingId(null);
  };

  const resetEnvForm = () => {
    setEnvFormData({
      key: "",
      value: ""
    });
    setEnvFormErrors({});
    setShowEnvForm(false);
    setEditingEnvKey(null);
  };

  const formatLastCheck = (timestamp: number | null) => {
    if (!timestamp) return "Never";
    const date = new Date(timestamp * 1000);
    return date.toLocaleString();
  };

  const getStatusBadge = (available: boolean, lastCheck: number | null) => {
    if (!lastCheck) {
      return (
        <span className="px-2 py-1 rounded-full text-xs bg-gray-500/20 text-gray-300 border border-gray-500/30">
          Unknown
        </span>
      );
    }
    
    return available ? (
      <span className="px-2 py-1 rounded-full text-xs bg-green-500/20 text-green-300 border border-green-500/30">
        Available
      </span>
    ) : (
      <span className="px-2 py-1 rounded-full text-xs bg-red-500/20 text-red-300 border border-red-500/30">
        Unavailable
      </span>
    );
  };

  if (loading || envLoading) {
    return (
      <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-amber-400 mx-auto mb-3"></div>
          <p className="text-white/80 text-sm">Loading server configuration...</p>
        </div>
    );
  }

  if (error) {
    return (
      <div className="text-center">
          <div className="bg-red-500/20 border border-red-500/50 rounded-lg p-4 max-w-md">
            <h2 className="text-red-200 text-base font-semibold mb-2">Error Loading Configuration</h2>
            <p className="text-red-300 text-sm mb-3">{error}</p>
            <button
              onClick={() => activeTab === 'rss' ? fetchRSSLinks() : fetchEnvVariables()}
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
          <h1 className="text-2xl font-bold text-white mb-1">Server Configuration</h1>
          <p className="text-white/70 text-sm">Manage RSS feeds, environment variables, and server settings</p>
        </div>

        {/* Tab Navigation */}
        <div className="flex justify-center mb-4">
          <div className="bg-white/10 backdrop-blur-md rounded-lg p-1">
            <button
              onClick={() => setActiveTab('rss')}
              className={`px-4 py-2 text-sm rounded-md transition-colors ${
                activeTab === 'rss'
                  ? 'bg-amber-500 text-white'
                  : 'text-white/70 hover:text-white hover:bg-white/10'
              }`}
            >
              RSS Links
            </button>
            <button
              onClick={() => setActiveTab('env')}
              className={`px-4 py-2 text-sm rounded-md transition-colors ${
                activeTab === 'env'
                  ? 'bg-amber-500 text-white'
                  : 'text-white/70 hover:text-white hover:bg-white/10'
              }`}
            >
              Environment Variables
            </button>
          </div>
        </div>

        {/* RSS Links Tab */}
        {activeTab === 'rss' && (
          <>
            {/* Actions Bar */}
            <div className="flex justify-between items-center mb-4">
              <div className="flex items-center space-x-3 text-sm">
                <span className="text-white/80">
                  Total: <span className="font-semibold text-amber-400">{rssLinks.length}</span>
                </span>
                <span className="text-white/80">
                  Available: <span className="font-semibold text-green-400">
                    {rssLinks.filter(link => link.available).length}
                  </span>
                </span>
              </div>
              <div className="flex space-x-2">
                <button
                  onClick={handleLinksRefresh}
                  className="bg-red-500 hover:bg-red-600 text-white px-3 py-1.5 text-sm rounded-md transition-colors flex items-center space-x-1.5"
                >
                  {forceRefresh ? <svg className="w-3 h-3 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg> : <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>}
                  <span>Force Refresh</span>
                </button>
                <button
                  onClick={fetchRSSLinks}
                  className="bg-blue-500 hover:bg-blue-600 text-white px-3 py-1.5 text-sm rounded-md transition-colors flex items-center space-x-1.5"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  <span>Refresh</span>
                </button>
                <button
                  onClick={() => setShowAddForm(true)}
                  className="bg-amber-500 hover:bg-amber-600 text-white px-3 py-1.5 text-sm rounded-md transition-colors flex items-center space-x-1.5"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  <span>Add RSS</span>
                </button>
              </div>
            </div>

            {/* Add/Edit RSS Form */}
            {showAddForm && (
              <div className="bg-white/10 backdrop-blur-md rounded-lg p-4 mb-4 shadow-xl">
                <h2 className="text-lg font-bold text-white mb-3">
                  {editingId ? "Edit RSS Link" : "Add New RSS Link"}
                </h2>
                
                <form onSubmit={handleSubmit} className="space-y-3">
                  {formErrors.general && (
                    <div className="bg-red-500/20 border border-red-500/50 rounded-md p-2 text-red-200 text-sm">
                      {formErrors.general}
                    </div>
                  )}
                  
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    {/* RSS Link */}
                    <div className="md:col-span-2">
                      <label htmlFor="link" className="block text-white/80 text-xs font-medium mb-1">
                        RSS Link *
                      </label>
                      <input
                        type="url"
                        id="link"
                        name="link"
                        value={formData.link}
                        onChange={handleInputChange}
                        className={`w-full px-3 py-2 text-sm bg-white/10 border rounded-md text-white placeholder-white/50 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent ${
                          formErrors.link ? 'border-red-500' : 'border-white/20'
                        }`}
                        placeholder="https://example.com/rss"
                      />
                      {formErrors.link && (
                        <p className="text-red-400 text-xs mt-1">{formErrors.link}</p>
                      )}
                    </div>

                    {/* Country */}
                    <div>
                      <label htmlFor="country" className="block text-white/80 text-xs font-medium mb-1">
                        Country *
                      </label>
                      <select
                        id="country"
                        name="country"
                        value={formData.country}
                        onChange={handleInputChange}
                        className={`w-full px-3 py-2 text-sm bg-white/10 border rounded-md text-white focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent ${
                          formErrors.country ? 'border-red-500' : 'border-white/20'
                        }`}
                      >
                        {COUNTRIES.map(country => (
                          <option key={country} value={country} className="bg-gray-800">
                            {country}
                          </option>
                        ))}
                      </select>
                      {formErrors.country && (
                        <p className="text-red-400 text-xs mt-1">{formErrors.country}</p>
                      )}
                    </div>
                  </div>

                  {/* Category */}
                  <div>
                    <label htmlFor="category" className="block text-white/80 text-xs font-medium mb-1">
                      Category *
                    </label>
                    <select
                      id="category"
                      name="category"
                      value={formData.category}
                      onChange={handleInputChange}
                      className={`w-full px-3 py-2 text-sm bg-white/10 border rounded-md text-white focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent ${
                        formErrors.category ? 'border-red-500' : 'border-white/20'
                      }`}
                    >
                      {CATEGORIES.map(category => (
                        <option key={category} value={category} className="bg-gray-800">
                          {category}
                        </option>
                      ))}
                    </select>
                    {formErrors.category && (
                      <p className="text-red-400 text-xs mt-1">{formErrors.category}</p>
                    )}
                  </div>

                  {/* Form Actions */}
                  <div className="flex justify-end space-x-2">
                    <button
                      type="button"
                      onClick={resetForm}
                      className="px-3 py-1.5 text-sm text-white/70 hover:text-white border border-white/20 hover:border-white/40 rounded-md transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="bg-amber-500 hover:bg-amber-600 text-white px-4 py-1.5 text-sm rounded-md transition-colors"
                    >
                      {editingId ? "Update" : "Add"} RSS Link
                    </button>
                  </div>
                </form>
              </div>
            )}

            {/* RSS Links Table */}
            <div className="bg-white/10 backdrop-blur-md rounded-lg shadow-xl overflow-hidden">
              <div className="h-96 overflow-y-auto scrollbar-thin scrollbar-thumb-white/20 scrollbar-track-transparent hover:scrollbar-thumb-white/30">
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-white/5 sticky top-0">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-medium text-white/80 uppercase tracking-wider">
                          RSS Link
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-white/80 uppercase tracking-wider">
                          Country
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-white/80 uppercase tracking-wider">
                          Category
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-white/80 uppercase tracking-wider">
                          Status
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-white/80 uppercase tracking-wider">
                          Last Check
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-white/80 uppercase tracking-wider">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/10">
                      {rssLinks.length > 0 ? (
                        rssLinks.map((link) => (
                          <tr key={link.id} className="hover:bg-white/5 transition-colors">
                            <td className="px-3 py-2">
                              <div className="text-white text-sm font-medium truncate max-w-xs" title={link.link}>
                                {link.link}
                              </div>
                            </td>
                            <td className="px-3 py-2">
                              <span className="px-1.5 py-0.5 rounded-full text-xs bg-blue-500/20 text-blue-300 border border-blue-500/30">
                                {link.country}
                              </span>
                            </td>
                            <td className="px-3 py-2">
                              <span className="px-1.5 py-0.5 rounded-full text-xs bg-purple-500/20 text-purple-300 border border-purple-500/30">
                                {link.category}
                              </span>
                            </td>
                            <td className="px-3 py-2">
                              {getStatusBadge(link.available, link.lastCheck)}
                            </td>
                            <td className="px-3 py-2 text-white/60 text-xs">
                              {formatLastCheck(link.lastCheck)}
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex space-x-1">
                                {/* Test Link Button */}
                                <button
                                  onClick={() => handleTestLink(link.id)}
                                  disabled={testingLinks.has(link.id)}
                                  className="p-1 rounded text-xs bg-green-500/20 text-green-300 border border-green-500/30 hover:bg-green-500/30 disabled:opacity-50 transition-colors"
                                  title="Test RSS link availability"
                                >
                                  {testingLinks.has(link.id) ? (
                                    <svg className="w-3 h-3 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                    </svg>
                                  ) : (
                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                    </svg>
                                  )}
                                </button>
                                
                                {/* Refresh Status Button */}
                                <button
                                  onClick={() => refreshLinkStatus(link.id)}
                                  disabled={refreshingLinks.has(link.id)}
                                  className="p-1 rounded text-xs bg-blue-500/20 text-blue-300 border border-blue-500/30 hover:bg-blue-500/30 disabled:opacity-50 transition-colors"
                                  title="Refresh status"
                                >
                                  {refreshingLinks.has(link.id) ? (
                                    <svg className="w-3 h-3 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                    </svg>
                                  ) : (
                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                    </svg>
                                  )}
                                </button>
                                
                                {/* Edit Button */}
                                <button
                                  onClick={() => handleEdit(link)}
                                  className="p-1 rounded text-xs bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-amber-500/30 transition-colors"
                                  title="Edit"
                                >
                                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                  </svg>
                                </button>
                                
                                {/* Delete Button */}
                                <button
                                  onClick={() => handleDelete(link.id)}
                                  disabled={actionLoading.has(link.id)}
                                  className="p-1 rounded text-xs bg-red-500/20 text-red-300 border border-red-500/30 hover:bg-red-500/30 disabled:opacity-50 transition-colors"
                                  title="Delete"
                                >
                                  {actionLoading.has(link.id) ? (
                                    <svg className="w-3 h-3 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                    </svg>
                                  ) : (
                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                    </svg>
                                  )}
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={6} className="px-3 py-8 text-center">
                            <div className="text-white/60">
                              <div className="text-3xl mb-3">📡</div>
                              <p className="text-base mb-1">No RSS links configured</p>
                              <p className="text-xs">Add your first RSS feed to get started</p>
                            </div>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Environment Variables Tab */}
        {activeTab === 'env' && (
          <>
            {/* Actions Bar */}
            <div className="flex justify-between items-center mb-4">
              <div className="flex items-center space-x-3 text-sm">
                <span className="text-white/80">
                  Total Variables: <span className="font-semibold text-amber-400">{Object.keys(envVariables).length}</span>
                </span>
              </div>
              <div className="flex space-x-2">
                <button
                  onClick={fetchEnvVariables}
                  className="bg-blue-500 hover:bg-blue-600 text-white px-3 py-1.5 text-sm rounded-md transition-colors flex items-center space-x-1.5"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  <span>Refresh</span>
                </button>
                <button
                  onClick={() => setShowEnvForm(true)}
                  className="bg-amber-500 hover:bg-amber-600 text-white px-3 py-1.5 text-sm rounded-md transition-colors flex items-center space-x-1.5"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  <span>Add Variable</span>
                </button>
              </div>
            </div>

            {/* Add/Edit Environment Variable Form */}
            {showEnvForm && (
              <div className="bg-white/10 backdrop-blur-md rounded-lg p-4 mb-4 shadow-xl">
                <h2 className="text-lg font-bold text-white mb-3">
                  {editingEnvKey ? "Edit Environment Variable" : "Add New Environment Variable"}
                </h2>
                
                <form onSubmit={handleEnvSubmit} className="space-y-3">
                  {envFormErrors.general && (
                    <div className="bg-red-500/20 border border-red-500/50 rounded-md p-2 text-red-200 text-sm">
                      {envFormErrors.general}
                    </div>
                  )}
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {/* Variable Key */}
                    <div>
                      <label htmlFor="key" className="block text-white/80 text-xs font-medium mb-1">
                        Variable Key *
                      </label>
                      <input
                        type="text"
                        id="key"
                        name="key"
                        value={envFormData.key}
                        onChange={handleEnvInputChange}
                        disabled={!!editingEnvKey}
                        className={`w-full px-3 py-2 text-sm bg-white/10 border rounded-md text-white placeholder-white/50 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent ${
                          envFormErrors.key ? 'border-red-500' : 'border-white/20'
                        } ${editingEnvKey ? 'opacity-50 cursor-not-allowed' : ''}`}
                        placeholder="VARIABLE_NAME"
                      />
                      {envFormErrors.key && (
                        <p className="text-red-400 text-xs mt-1">{envFormErrors.key}</p>
                      )}
                    </div>

                    {/* Variable Value */}
                    <div>
                      <label htmlFor="value" className="block text-white/80 text-xs font-medium mb-1">
                        Variable Value *
                      </label>
                      <textarea
                        id="value"
                        name="value"
                        value={envFormData.value}
                        onChange={handleEnvInputChange}
                        rows={3}
                        className={`w-full px-3 py-2 text-sm bg-white/10 border rounded-md text-white placeholder-white/50 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent resize-none ${
                          envFormErrors.value ? 'border-red-500' : 'border-white/20'
                        }`}
                        placeholder="Variable value..."
                      />
                      {envFormErrors.value && (
                        <p className="text-red-400 text-xs mt-1">{envFormErrors.value}</p>
                      )}
                    </div>
                  </div>

                  {/* Form Actions */}
                  <div className="flex justify-end space-x-2">
                    <button
                      type="button"
                      onClick={resetEnvForm}
                      className="px-3 py-1.5 text-sm text-white/70 hover:text-white border border-white/20 hover:border-white/40 rounded-md transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={envSaving}
                      className="bg-amber-500 hover:bg-amber-600 text-white px-4 py-1.5 text-sm rounded-md transition-colors"
                    >
                      {envSaving && (
                        <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                      )}
                      <span>{editingEnvKey ? "Update" : "Add"} Variable</span>
                    </button>
                  </div>
                </form>
              </div>
            )}

            {/* Environment Variables Table */}
            <div className="bg-white/10 backdrop-blur-md rounded-lg shadow-xl overflow-hidden">
              <div className="h-96 overflow-y-auto scrollbar-thin scrollbar-thumb-white/20 scrollbar-track-transparent hover:scrollbar-thumb-white/30">
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-white/5 sticky top-0">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-medium text-white/80 uppercase tracking-wider">
                          Variable Key
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-white/80 uppercase tracking-wider">
                          Variable Value
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-white/80 uppercase tracking-wider">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/10">
                      {Object.keys(envVariables).length > 0 ? (
                        Object.entries(envVariables).map(([key, value]) => (
                          <tr key={key} className="hover:bg-white/5 transition-colors">
                            <td className="px-3 py-2">
                              <div className="text-white font-medium font-mono">
                                {key}
                              </div>
                            </td>
                            <td className="px-3 py-2">
                              <div className="text-white/80 font-mono text-sm max-w-md truncate" title={value}>
                                {value || <span className="text-white/40 italic">empty</span>}
                              </div>
                            </td>
                            <td className="px-3 py-2">
                              <button
                                onClick={() => handleEnvEdit(key, value)}
                                className="p-1 rounded text-xs bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-amber-500/30 transition-colors"
                                title="Edit"
                              >
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                </svg>
                              </button>
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={3} className="px-3 py-12 text-center">
                            <div className="text-white/60">
                              <div className="text-3xl mb-3">⚙️</div>
                              <p className="text-base mb-1">No environment variables configured</p>
                              <p className="text-xs">Add your first environment variable to get started</p>
                            </div>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
  );
}
