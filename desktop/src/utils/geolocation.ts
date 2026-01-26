export interface LocationData {
  latitude: number;
  longitude: number;
  accuracy?: number;
  timestamp?: number;
}

export interface GeolocationOptions {
  enableHighAccuracy?: boolean;
  timeout?: number;
  maximumAge?: number;
}

export class GeolocationService {
  private static instance: GeolocationService;
  
  private constructor() {}
  
  public static getInstance(): GeolocationService {
    if (!GeolocationService.instance) {
      GeolocationService.instance = new GeolocationService();
    }
    return GeolocationService.instance;
  }

  public async getCurrentPosition(options: GeolocationOptions = {}): Promise<LocationData> {
    return new Promise((resolve, reject) => {
      // Check if geolocation is supported
      if (!navigator.geolocation) {
        reject(new Error('Geolocation is not supported by this browser.'));
        return;
      }

      const defaultOptions: GeolocationOptions = {
        enableHighAccuracy: false,
        timeout: 10000,
        maximumAge: 300000 // 5 minutes cache
      };

      const finalOptions = { ...defaultOptions, ...options };

      navigator.geolocation.getCurrentPosition(
        (position) => {
          resolve({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
            timestamp: position.timestamp
          });
        },
        (error) => {
          let errorMessage = 'Unknown error occurred';
          
          switch (error.code) {
            case error.PERMISSION_DENIED:
              errorMessage = 'Location access denied by user';
              break;
            case error.POSITION_UNAVAILABLE:
              errorMessage = 'Location information is unavailable';
              break;
            case error.TIMEOUT:
              errorMessage = 'Location request timed out';
              break;
          }
          
          reject(new Error(errorMessage));
        },
        finalOptions
      );
    });
  }

  public watchPosition(
    callback: (location: LocationData) => void,
    errorCallback: (error: Error) => void,
    options: GeolocationOptions = {}
  ): number {
    if (!navigator.geolocation) {
      errorCallback(new Error('Geolocation is not supported by this browser.'));
      return -1;
    }

    const defaultOptions: GeolocationOptions = {
      enableHighAccuracy: false,
      timeout: 10000,
      maximumAge: 300000
    };

    const finalOptions = { ...defaultOptions, ...options };

    return navigator.geolocation.watchPosition(
      (position) => {
        callback({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          timestamp: position.timestamp
        });
      },
      (error) => {
        let errorMessage = 'Unknown error occurred';
        
        switch (error.code) {
          case error.PERMISSION_DENIED:
            errorMessage = 'Location access denied by user';
            break;
          case error.POSITION_UNAVAILABLE:
            errorMessage = 'Location information is unavailable';
            break;
          case error.TIMEOUT:
            errorMessage = 'Location request timed out';
            break;
        }
        
        errorCallback(new Error(errorMessage));
      },
      finalOptions
    );
  }

  public clearWatch(watchId: number): void {
    navigator.geolocation.clearWatch(watchId);
  }

  // Alternative method for desktop apps that might have limited geolocation
  public async getLocationWithFallback(options: GeolocationOptions = {}): Promise<LocationData> {
    try {
      return await this.getCurrentPosition(options);
    } catch (error) {
      console.warn('Primary geolocation failed, trying fallback:', error);
      
      // Fallback: You could implement IP-based location or other methods here
      // For now, we'll just re-throw the error
      throw error;
    }
  }
}

// Export a default instance
export const geolocationService = GeolocationService.getInstance();
