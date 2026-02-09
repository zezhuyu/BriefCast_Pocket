import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { geolocationService, LocationData, GeolocationOptions } from '../utils/geolocation';

interface LocationContextType {
  location: LocationData | null;
  isLoading: boolean;
  error: string | null;
  getCurrentLocation: (options?: GeolocationOptions) => Promise<void>;
  watchLocation: (options?: GeolocationOptions) => void;
  stopWatching: () => void;
}

const LocationContext = createContext<LocationContextType | undefined>(undefined);

interface LocationProviderProps {
  children: ReactNode;
}

export const LocationProvider: React.FC<LocationProviderProps> = ({ children }) => {
  const [location, setLocation] = useState<LocationData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [watchId, setWatchId] = useState<number | null>(null);

  const getCurrentLocation = async (options?: GeolocationOptions) => {
    setIsLoading(true);
    setError(null);

    try {
      const currentLocation = await geolocationService.getCurrentPosition(options);
      setLocation(currentLocation);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get location');
    } finally {
      setIsLoading(false);
    }
  };

  const watchLocation = (options?: GeolocationOptions) => {
    if (watchId !== null) {
      geolocationService.clearWatch(watchId);
    }

    const id = geolocationService.watchPosition(
      (newLocation) => {
        setLocation(newLocation);
        setError(null);
      },
      (err) => {
        setError(err.message);
      },
      options
    );

    setWatchId(id);
  };

  const stopWatching = () => {
    if (watchId !== null) {
      geolocationService.clearWatch(watchId);
      setWatchId(null);
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (watchId !== null) {
        geolocationService.clearWatch(watchId);
      }
    };
  }, [watchId]);

  const value: LocationContextType = {
    location,
    isLoading,
    error,
    getCurrentLocation,
    watchLocation,
    stopWatching,
  };

  return (
    <LocationContext.Provider value={value}>
      {children}
    </LocationContext.Provider>
  );
};

export const useLocation = (): LocationContextType => {
  const context = useContext(LocationContext);
  if (context === undefined) {
    throw new Error('useLocation must be used within a LocationProvider');
  }
  return context;
};

// Hook for one-time location fetch
export const useCurrentLocation = (options?: GeolocationOptions) => {
  const { getCurrentLocation, location, isLoading, error } = useLocation();

  useEffect(() => {
    getCurrentLocation(options);
  }, []);

  return { location, isLoading, error };
};
