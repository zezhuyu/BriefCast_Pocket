"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import axios from "axios";
import bcrypt from "bcryptjs";
import crypto from "crypto";

export default function LoginPage() {
  const [formData, setFormData] = useState({
    username: "",
    password: ""
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();

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
    }

    if (!formData.password) {
      newErrors.password = "Password is required";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  // Hash password using bcrypt (for secure transmission)
  const hashPassword = async (password: string): Promise<string> => {
    password = crypto.createHash('sha256').update(password).digest('hex');
    const saltRounds = 12;
    return await bcrypt.hash(password, saltRounds);
  };

  // Handle login form submission
  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!validateForm()) {
      return;
    }

    setIsLoading(true);
    try {
      // Hash the password before sending for security
      const hashedPassword = await hashPassword(formData.password);
      
      // Send login request
      const response = await axios.post(process.env.NEXT_PUBLIC_BACKEND_URL + "signin", {
        user_id: formData.username,
        password: hashedPassword
      });

      // Handle successful login
      if (response.status === 200) {
        if (response.data.token) {
          localStorage.setItem('authToken', response.data.token);
        }
        
        // Redirect to home page
        router.push("/");
      } else {
        setErrors({
          general: response.data.message || "Login failed"
        });
      }
    } catch (error: any) {
      setErrors({
        general: error.response?.data?.message || "Invalid username or password"
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Check if form is valid for button state
  const isFormValid = formData.username.trim().length > 0 && formData.password.length > 0;

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
          
          <h1 className="text-4xl font-bold mb-4 text-center">Welcome Back</h1>
          <p className="text-xl text-white/70 text-center mb-6">
            Sign in to access your personalized daily briefings
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

        {/* Right Side - Login Form */}
        <div className="w-full md:w-1/2 flex items-center justify-center">
          <div className="w-full max-w-md p-6">
            
            {/* Login Form */}
            <div className="bg-white/10 backdrop-blur-md p-8 rounded-xl shadow-2xl">
              <h1 className="text-3xl font-bold text-white mb-6 text-center">Sign In</h1>
              
              
              <form onSubmit={handleLoginSubmit} className="space-y-4">
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
                    autoComplete="username"
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
                    autoComplete="current-password"
                  />
                  {errors.password && (
                    <p className="text-red-400 text-xs mt-1">{errors.password}</p>
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
                      Signing In...
                    </>
                  ) : (
                    'Sign In'
                  )}
                </button>
              </form>

              {/* Sign Up Link */}
              <div className="mt-6 text-center">
                <p className="text-white/60 text-sm">
                  Don't have an account?{' '}
                  <a href="/signup" className="text-amber-400 hover:text-amber-300 font-medium">
                    Sign up
                  </a>
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}