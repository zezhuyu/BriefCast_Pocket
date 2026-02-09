"""
Resource Monitor for tracking file descriptors and system resources
"""
import os
import psutil
import time
import logging
import threading
from typing import Dict, Any

logger = logging.getLogger(__name__)

class ResourceMonitor:
    """Monitors system resources to detect potential leaks"""
    
    def __init__(self, check_interval=300):  # 5 minutes
        self.check_interval = check_interval
        self.running = False
        self.monitor_thread = None
        self.baseline_fds = 0
        self.baseline_memory = 0
        
    def start(self):
        """Start resource monitoring"""
        if self.running:
            return
            
        self.running = True
        self._establish_baseline()
        self.monitor_thread = threading.Thread(target=self._monitor_loop, daemon=True)
        self.monitor_thread.start()
        logger.info("ResourceMonitor started")
        
    def stop(self):
        """Stop resource monitoring"""
        self.running = False
        if self.monitor_thread:
            self.monitor_thread.join(timeout=5)
        logger.info("ResourceMonitor stopped")
        
    def _establish_baseline(self):
        """Establish baseline resource usage"""
        try:
            process = psutil.Process()
            self.baseline_fds = process.num_fds() if hasattr(process, 'num_fds') else 0
            self.baseline_memory = process.memory_info().rss / 1024 / 1024  # MB
            logger.info(f"Resource baseline: {self.baseline_fds} FDs, {self.baseline_memory:.1f}MB RAM")
        except Exception as e:
            logger.error(f"Failed to establish resource baseline: {e}")
            
    def _monitor_loop(self):
        """Main monitoring loop"""
        while self.running:
            try:
                self._check_resources()
                time.sleep(self.check_interval)
            except Exception as e:
                logger.error(f"Error in resource monitoring: {e}")
                time.sleep(60)  # Wait 1 minute before retrying
                
    def _check_resources(self):
        """Check current resource usage"""
        try:
            process = psutil.Process()
            current_fds = process.num_fds() if hasattr(process, 'num_fds') else 0
            current_memory = process.memory_info().rss / 1024 / 1024  # MB
            
            fd_increase = current_fds - self.baseline_fds
            memory_increase = current_memory - self.baseline_memory
            
            # Log resource usage
            logger.info(f"Resource usage: {current_fds} FDs (+{fd_increase}), {current_memory:.1f}MB RAM (+{memory_increase:.1f}MB)")
            
            # Warn about potential leaks
            if fd_increase > 100:
                logger.warning(f"High file descriptor increase: +{fd_increase} FDs since startup")
                
            if memory_increase > 500:  # 500MB increase
                logger.warning(f"High memory increase: +{memory_increase:.1f}MB since startup")
                
            # Check system-wide limits
            try:
                soft_limit, hard_limit = process.rlimit(psutil.RLIMIT_NOFILE)
                if current_fds > soft_limit * 0.8:  # 80% of soft limit
                    logger.warning(f"Approaching file descriptor limit: {current_fds}/{soft_limit}")
            except Exception:
                pass
                
        except Exception as e:
            logger.error(f"Failed to check resources: {e}")
            
    def get_resource_stats(self) -> Dict[str, Any]:
        """Get current resource statistics"""
        try:
            process = psutil.Process()
            current_fds = process.num_fds() if hasattr(process, 'num_fds') else 0
            current_memory = process.memory_info().rss / 1024 / 1024  # MB
            
            return {
                "file_descriptors": current_fds,
                "memory_mb": current_memory,
                "fd_increase": current_fds - self.baseline_fds,
                "memory_increase_mb": current_memory - self.baseline_memory,
                "baseline_fds": self.baseline_fds,
                "baseline_memory_mb": self.baseline_memory
            }
        except Exception as e:
            logger.error(f"Failed to get resource stats: {e}")
            return {}

# Global instance
resource_monitor = ResourceMonitor()

# Start monitoring when module is imported
resource_monitor.start()

# Cleanup on module exit
import atexit
atexit.register(resource_monitor.stop)

