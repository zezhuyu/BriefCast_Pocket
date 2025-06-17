"use client";
import { useState, useEffect, useMemo } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import axios from "axios";
import bcrypt from "bcryptjs";
import { SUBTOPICS } from "./subtopics";
import crypto from "crypto";
import { getName } from "@tauri-apps/api/app";
// Define the list of available topics
const TOPICS = [
  "Politics", "Economy", "Sports", "Technology", "Health", 
  "Science", "Entertainment", "Business", "Education", 
  "Environment", "Culture", "Lifestyle", "Travel", 
  "Automotive", "Crime", "Law", "World News", "Local News"
];

export default function AuthPage() {
  const [view, setView] = useState<"signUp" | "topicSelection" | "subtopicSelection">("signUp");
  const [selectedTopics, setSelectedTopics] = useState<string[]>([]);
  const [selectedSubtopics, setSelectedSubtopics] = useState<Record<string, string[]>>({});
  const [formData, setFormData] = useState({
    username: "",
    password: "",
    confirmPassword: ""
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();
  const [isTauri, setIsTauri] = useState<boolean>(false);

  useEffect(() => {
    const TauriAvailable = async () => {
      try {
        await getName();
        return true;
      } catch {
        return false; 
      }
    }

    TauriAvailable().then((tauri) => {
      if (tauri) {
        setIsTauri(true)
      }
    })
  }, []);

  // Handle form input changes
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));
    // Clear error when user starts typing
    if (errors[name]) {
      setErrors(prev => ({
        ...prev,
        [name]: ""
      }));
    }
  };

  // Validate form
  const validateForm = () => {
    const newErrors: Record<string, string> = {};

    if (!formData.username.trim()) {
      newErrors.username = "Username is required";
    } else if (formData.username.length < 3) {
      newErrors.username = "Username must be at least 3 characters";
    }

    if (!formData.password) {
      newErrors.password = "Password is required";
    } else if (formData.password.length < 6) {
      newErrors.password = "Password must be at least 6 characters";
    }

    if (formData.password !== formData.confirmPassword) {
      newErrors.confirmPassword = "Passwords do not match";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  // Hash password using bcrypt
  const hashPassword = async (password: string): Promise<string> => {
    // const saltRounds = 12; // Higher number = more secure but slower
    // return await bcrypt.hash(password, saltRounds);
    return crypto.createHash('sha256').update(password).digest('hex');
  };

  // Handle signup form submission
  const handleSignUpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setView("topicSelection");
  };

  // Handle topic selection
  const toggleTopic = (topic: string) => {
    setSelectedTopics(prev => 
      prev.includes(topic)
        ? prev.filter(t => t !== topic)
        : [...prev, topic]
    );
    
    // If we're removing a topic, also remove its subtopics
    if (selectedTopics.includes(topic)) {
      setSelectedSubtopics(prev => {
        const updated = { ...prev };
        delete updated[topic];
        return updated;
      });
    }
  };

  // Handle subtopic selection
  const toggleSubtopic = (topic: string, subtopic: string) => {
    setSelectedSubtopics(prev => {
      const currentTopicSubtopics = prev[topic] || [];
      const updatedTopicSubtopics = currentTopicSubtopics.includes(subtopic)
        ? currentTopicSubtopics.filter(st => st !== subtopic)
        : [...currentTopicSubtopics, subtopic];
      
      return {
        ...prev,
        [topic]: updatedTopicSubtopics
      };
    });
  };

  // Move to subtopic selection
  const handleContinueToSubtopics = () => {
    if (selectedTopics.length > 0) {
      setView("subtopicSelection");
    }
  };

  // Save topics and redirect to home page
  const handleTopicSubmit = async () => {
    try {
      // Format the data to include both topics and subtopics
      const topicsData = {
        mainTopics: selectedTopics,
        subtopics: selectedSubtopics
      };
      
      // Hash password again for the final submission
      const hashedPassword = await hashPassword(formData.password);
      
      const response = await axios.post(process.env.NEXT_PUBLIC_BACKEND_URL + "signup", 
        {
          user_id: formData.username,
          password: hashedPassword,
          preference: topicsData
        },
        {
          headers: {
            "Content-Type": "application/json", 
          },
        }
      );

      if (response.status === 200) {
        if (response.data.token) {
          localStorage.setItem('authToken', response.data.token);
        }
      }


      // Redirect to home page
      router.push("/");
    } catch (error) {
      console.error("Error saving topics:", error);
    }
  };

  // Check if form is valid for button state
  const isFormValid = formData.username.length >= 3 && 
                     formData.password.length >= 6 && 
                     formData.confirmPassword === formData.password;

  // First, let's randomize the order of topics
  const shuffledTopics = useMemo(() => {
    return [...TOPICS].sort(() => Math.random() - 0.5);
  }, []);

  // Create a shuffled array of all subtopics from selected topics
  const shuffledSubtopics = useMemo(() => {
    // Gather all subtopics from selected topics
    const allSubtopics = selectedTopics.flatMap(topic => 
      SUBTOPICS[topic].map(subtopic => ({ topic, subtopic }))
    );
    
    // Shuffle the array
    return [...allSubtopics].sort(() => Math.random() - 0.5);
  }, [selectedTopics]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-indigo-900/90 to-purple-900/90">
      <div className="flex w-full max-w-5xl">
        {/* Left Side - Welcome and Icon */}
        <div className="hidden md:flex md:w-1/2 flex-col justify-center items-center p-8 text-white">
          {/* Premium Headphones Icon */}
          <div className="mb-8 rounded-full bg-gradient-to-br from-zinc-800 to-zinc-900 shadow-lg shadow-amber-600/20 border border-amber-400/20 flex items-center justify-center relative overflow-hidden w-80 h-80">
            {/* Glow effect */}
            <div className="absolute inset-0 bg-gradient-to-r from-amber-500 to-amber-700 rounded-full blur-md"></div>
            
            {/* Premium rim */}
            <div className="absolute inset-2 rounded-full border-2 border-amber-400/20"></div>
            
            {/* Headphones Image */}
            <div className="relative z-10 w-full h-full flex items-center justify-center">
              <Image 
                src="/headphone.png" 
                alt="Premium Headphones"
                width={440}
                height={440}
                className="object-contain scale-110"
                priority
              />
              
              {/* Animated Sound Waves */}
              <div className="absolute left-1/2 top-1/2 transform -translate-x-1/2 -translate-y-1/2 -z-10">
                <div className="w-48 h-48 rounded-full border-2 border-amber-400/20 animate-ping opacity-30"></div>
                <div className="w-64 h-64 rounded-full border-2 border-amber-400/10 animate-ping opacity-20 animation-delay-300"></div>
              </div>
            </div>
          </div>
          
          <h1 className="text-4xl font-bold mb-4 text-center">Welcome to BriefCast</h1>
          <p className="text-xl text-white/70 text-center mb-6">
            Your personal daily presidential briefing on the web
          </p>
          <div className="space-y-4 text-white/80">
            <div className="flex items-center">
              <svg className="w-5 h-5 mr-2 text-amber-400" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              <span>Daily executive summaries</span>
            </div>
            <div className="flex items-center">
              <svg className="w-5 h-5 mr-2 text-amber-400" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              <span>Concise policy updates</span>
            </div>
            <div className="flex items-center">
              <svg className="w-5 h-5 mr-2 text-amber-400" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              <span>Listen on any device</span>
            </div>
          </div>
        </div>

        {/* Right Side - Auth Forms */}
        <div className="w-full md:w-1/2 flex items-center justify-center">
          <div className="w-full max-w-md p-6">
            {!isTauri && (
              <div className="bg-white/10 backdrop-blur-md p-8 rounded-xl shadow-2xl">
                <h1 className="text-3xl font-bold text-white mb-6 text-center">Sign up not available on web</h1>
                <p className="text-white/80 mb-6 text-center text-sm">
                  Please sign up on BriefCast Desktop
                </p>
                <div className="mt-6 text-center">
                  <p className="text-white/60 text-sm">
                    Already have an account?{' '}
                    <a href="/signin" className="text-amber-400 hover:text-amber-300 font-medium">
                      Sign in
                    </a>
                  </p>
                </div>
              </div>
            )}
            {/* Sign Up Form */}
            {isTauri && view === "signUp" && (
              <div className="bg-white/10 backdrop-blur-md p-8 rounded-xl shadow-2xl">
                <h1 className="text-3xl font-bold text-white mb-6 text-center">Create Account</h1>
                <p className="text-white/80 mb-6 text-center text-sm">
                  Join BriefCast to get personalized daily briefings
                </p>
                
                <form onSubmit={handleSignUpSubmit} className="space-y-4">
                  {/* General Error */}
                  {errors.general && (
                    <div className="bg-red-500/20 border border-red-500/50 rounded-lg p-3 text-red-200 text-sm">
                      {errors.general}
                    </div>
                  )}
                  
                  {/* Username Field */}
                  <div>
                    <label htmlFor="username" className="block text-white/80 text-sm font-medium mb-2">
                      Username
                    </label>
                    <input
                      type="text"
                      id="username"
                      name="username"
                      value={formData.username}
                      onChange={handleInputChange}
                      className={`w-full px-4 py-3 bg-white/10 border rounded-lg text-white placeholder-white/50 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent ${
                        errors.username ? 'border-red-500' : 'border-white/20'
                      }`}
                      placeholder="Enter your username"
                    />
                    {errors.username && (
                      <p className="text-red-400 text-xs mt-1">{errors.username}</p>
                    )}
                  </div>

                  {/* Password Field */}
                  <div>
                    <label htmlFor="password" className="block text-white/80 text-sm font-medium mb-2">
                      Password
                    </label>
                    <input
                      type="password"
                      id="password"
                      name="password"
                      value={formData.password}
                      onChange={handleInputChange}
                      className={`w-full px-4 py-3 bg-white/10 border rounded-lg text-white placeholder-white/50 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent ${
                        errors.password ? 'border-red-500' : 'border-white/20'
                      }`}
                      placeholder="Enter your password"
                    />
                    {errors.password && (
                      <p className="text-red-400 text-xs mt-1">{errors.password}</p>
                    )}
                  </div>

                  {/* Confirm Password Field */}
                  <div>
                    <label htmlFor="confirmPassword" className="block text-white/80 text-sm font-medium mb-2">
                      Confirm Password
                    </label>
                    <input
                      type="password"
                      id="confirmPassword"
                      name="confirmPassword"
                      value={formData.confirmPassword}
                      onChange={handleInputChange}
                      className={`w-full px-4 py-3 bg-white/10 border rounded-lg text-white placeholder-white/50 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent ${
                        errors.confirmPassword ? 'border-red-500' : 'border-white/20'
                      }`}
                      placeholder="Confirm your password"
                    />
                    {errors.confirmPassword && (
                      <p className="text-red-400 text-xs mt-1">{errors.confirmPassword}</p>
                    )}
                  </div>

                  {/* Submit Button */}
                  <button
                    type="submit"
                    disabled={isLoading || !isFormValid}
                    className="w-full bg-amber-500 hover:bg-amber-600 disabled:bg-amber-500/50 text-white font-semibold py-3 px-4 rounded-lg transition-colors duration-200 flex items-center justify-center"
                  >
                    {isLoading ? (
                      <>
                        <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        Creating Account...
                      </>
                    ) : (
                      'Create Account'
                    )}
                  </button>
                </form>

                {/* Sign In Link */}
                <div className="mt-6 text-center">
                  <p className="text-white/60 text-sm">
                    Already have an account?{' '}
                    <a href="/signin" className="text-amber-400 hover:text-amber-300 font-medium">
                      Sign in
                    </a>
                  </p>
                </div>
              </div>
            )}
            
            {/* Topic Selection */}
            {isTauri && view === "topicSelection" && (
              <div className="bg-white/10 backdrop-blur-md p-6 rounded-xl shadow-2xl max-h-[80vh] overflow-y-auto mt-4">
                <h1 className="text-2xl font-bold text-white mb-4 text-center">Select Your Interests</h1>
                <p className="text-white/80 mb-4 text-center text-sm">
                  Choose topics you're interested in to personalize your experience.
                </p>
                
                <div className="flex flex-wrap justify-center gap-2 mb-6 max-h-[50vh] overflow-y-auto p-2">
                  {shuffledTopics.map(topic => (
                    <button
                      key={topic}
                      onClick={() => toggleTopic(topic)}
                      className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all transform hover:scale-105 ${
                        selectedTopics.includes(topic)
                          ? 'bg-amber-500 text-white shadow-lg'
                          : 'bg-white/20 text-white hover:bg-white/30'
                      }`}
                      style={{
                        fontSize: `${Math.random() * 0.1 + 0.8}rem`,
                        transform: Math.random() > 0.7 ? `rotate(${Math.random() * 3 - 1.5}deg)` : 'none'
                      }}
                    >
                      {topic}
                    </button>
                  ))}
                </div>

                <div className="flex justify-between items-center">
                  <span className="text-white/70 text-xs">
                    {selectedTopics.length} topics selected
                  </span>
                  <button
                    onClick={handleContinueToSubtopics}
                    disabled={selectedTopics.length === 0}
                    className={`px-4 py-1.5 rounded-lg text-sm font-medium ${
                      selectedTopics.length > 0
                        ? 'bg-amber-500 hover:bg-amber-600 text-white'
                        : 'bg-white/20 text-white/50 cursor-not-allowed'
                    }`}
                  >
                    Continue
                  </button>
                </div>
              </div>
            )}

            {/* Subtopic Selection */}
            {isTauri && view === "subtopicSelection" && (
              <div className="bg-white/10 backdrop-blur-md p-6 rounded-xl shadow-2xl max-h-[80vh] overflow-y-auto mt-4">
                <h1 className="text-2xl font-bold text-white mb-4 text-center">Refine Your Interests</h1>
                <p className="text-white/80 mb-4 text-center text-sm">
                  Select specific subtopics that interest you.
                </p>
                
                <div className="flex flex-wrap justify-center gap-2 mb-6 max-h-[50vh] overflow-y-auto p-2">
                  {shuffledSubtopics.map(({ topic, subtopic }) => (
                    <button
                      key={`${topic}-${subtopic}`}
                      onClick={() => toggleSubtopic(topic, subtopic)}
                      className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all transform hover:scale-105 ${
                        (selectedSubtopics[topic] || []).includes(subtopic)
                          ? 'bg-amber-500 text-white shadow-lg'
                          : 'bg-white/20 text-white hover:bg-white/30'
                      }`}
                      style={{
                        fontSize: `${Math.random() * 0.1 + 0.8}rem`,
                        transform: Math.random() > 0.7 ? `rotate(${Math.random() * 3 - 1.5}deg)` : 'none'
                      }}
                    >
                      {subtopic}
                    </button>
                  ))}
                </div>

                <div className="flex justify-between items-center">
                  <button
                    onClick={() => setView("topicSelection")}
                    className="px-4 py-1.5 rounded-lg text-sm font-medium bg-white/10 text-white hover:bg-white/20"
                  >
                    Back
                  </button>
                  <button
                    onClick={handleTopicSubmit}
                    className="px-4 py-1.5 rounded-lg text-sm font-medium bg-amber-500 hover:bg-amber-600 text-white"
                  >
                    Complete
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}