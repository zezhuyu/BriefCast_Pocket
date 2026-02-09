#!/usr/bin/env python3
"""
Monitor and Restart Script for BriefCast Backend
This script monitors the backend health and can restart it if resource usage gets too high
"""
import requests
import time
import subprocess
import sys
import os
import signal
import logging
from typing import Dict, Any, Optional

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class BackendMonitor:
    """Monitors the BriefCast backend and restarts if necessary"""
    
    def __init__(self, backend_url="http://localhost:5000", check_interval=300):
        self.backend_url = backend_url
        self.check_interval = check_interval
        self.running = True
        self.restart_count = 0
        self.max_restarts = 5
        self.restart_window = 3600  # 1 hour
        
    def check_health(self) -> Dict[str, Any]:
        """Check backend health status"""
        try:
            response = requests.get(f"{self.backend_url}/health", timeout=30)
            if response.status_code == 200:
                return response.json()
            else:
                logger.warning(f"Backend returned status {response.status_code}")
                return {"status": "unhealthy", "error": f"HTTP {response.status_code}"}
        except requests.exceptions.RequestException as e:
            logger.error(f"Failed to connect to backend: {e}")
            return {"status": "unhealthy", "error": str(e)}
    
    def check_resource_usage(self, health_data: Dict[str, Any]) -> bool:
        """Check if resource usage is within acceptable limits"""
        if "resources" not in health_data:
            return True  # No resource data available
            
        resources = health_data["resources"]
        
        # Check file descriptor usage
        current_fds = resources.get("file_descriptors", 0)
        fd_increase = resources.get("fd_increase", 0)
        
        # Check memory usage
        current_memory = resources.get("memory_mb", 0)
        memory_increase = resources.get("memory_increase_mb", 0)
        
        logger.info(f"Resource usage: {current_fds} FDs (+{fd_increase}), {current_memory:.1f}MB RAM (+{memory_increase:.1f}MB)")
        
        # Alert thresholds
        if fd_increase > 200:
            logger.warning(f"High file descriptor increase: +{fd_increase} FDs")
            return False
            
        if memory_increase > 1000:  # 1GB increase
            logger.warning(f"High memory increase: +{memory_increase:.1f}MB")
            return False
            
        return True
    
    def restart_backend(self):
        """Restart the backend process"""
        logger.info("Attempting to restart backend...")
        
        try:
            # Try to find and kill existing backend processes
            result = subprocess.run(['pgrep', '-f', 'api.py'], capture_output=True, text=True)
            if result.returncode == 0:
                pids = result.stdout.strip().split('\n')
                for pid in pids:
                    if pid:
                        try:
                            os.kill(int(pid), signal.SIGTERM)
                            logger.info(f"Terminated backend process {pid}")
                        except ProcessLookupError:
                            pass  # Process already dead
                        except Exception as e:
                            logger.error(f"Error killing process {pid}: {e}")
            
            # Wait a moment for processes to terminate
            time.sleep(5)
            
            # Start the backend
            backend_dir = os.path.dirname(os.path.abspath(__file__))
            api_file = os.path.join(backend_dir, 'api.py')
            
            # Start in background
            subprocess.Popen([sys.executable, api_file], 
                           cwd=backend_dir,
                           stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL)
            
            logger.info("Backend restart initiated")
            
            # Wait for backend to start
            time.sleep(10)
            
            # Verify it's running
            for attempt in range(6):  # Try for 1 minute
                health = self.check_health()
                if health.get("status") == "healthy":
                    logger.info("Backend restart successful")
                    return True
                time.sleep(10)
                
            logger.error("Backend failed to start properly after restart")
            return False
            
        except Exception as e:
            logger.error(f"Error restarting backend: {e}")
            return False
    
    def run(self):
        """Main monitoring loop"""
        logger.info(f"Starting backend monitor for {self.backend_url}")
        last_restart_time = 0
        
        while self.running:
            try:
                # Check backend health
                health_data = self.check_health()
                
                if health_data.get("status") != "healthy":
                    logger.warning(f"Backend is unhealthy: {health_data}")
                    
                    # Check if we should restart
                    current_time = time.time()
                    if (current_time - last_restart_time) > self.restart_window:
                        self.restart_count = 0  # Reset counter after window
                    
                    if self.restart_count < self.max_restarts:
                        if self.restart_backend():
                            self.restart_count += 1
                            last_restart_time = current_time
                        else:
                            logger.error("Failed to restart backend")
                    else:
                        logger.error(f"Max restart attempts ({self.max_restarts}) reached in {self.restart_window}s window")
                        logger.error("Manual intervention required")
                        break
                        
                else:
                    # Backend is healthy, check resource usage
                    if not self.check_resource_usage(health_data):
                        logger.warning("Resource usage is high, considering restart...")
                        
                        # Only restart for resource issues if it's been a while
                        current_time = time.time()
                        if (current_time - last_restart_time) > 1800:  # 30 minutes
                            if self.restart_backend():
                                self.restart_count += 1
                                last_restart_time = current_time
                
                # Wait before next check
                time.sleep(self.check_interval)
                
            except KeyboardInterrupt:
                logger.info("Monitor stopped by user")
                break
            except Exception as e:
                logger.error(f"Error in monitoring loop: {e}")
                time.sleep(60)  # Wait 1 minute before retrying
        
        logger.info("Backend monitor stopped")

def main():
    """Main entry point"""
    import argparse
    
    parser = argparse.ArgumentParser(description="Monitor BriefCast Backend")
    parser.add_argument("--url", default="http://localhost:5000", help="Backend URL")
    parser.add_argument("--interval", type=int, default=300, help="Check interval in seconds")
    parser.add_argument("--max-restarts", type=int, default=5, help="Max restarts per hour")
    
    args = parser.parse_args()
    
    monitor = BackendMonitor(
        backend_url=args.url,
        check_interval=args.interval
    )
    monitor.max_restarts = args.max_restarts
    
    try:
        monitor.run()
    except KeyboardInterrupt:
        logger.info("Monitor stopped by user")

if __name__ == "__main__":
    main()

