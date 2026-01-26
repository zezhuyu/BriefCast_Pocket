"""
Async Task Manager for handling background tasks without creating new event loops
"""
import asyncio
import threading
import queue
import time
import logging
from typing import Callable, Any, Optional
from functools import wraps

logger = logging.getLogger(__name__)

class AsyncTaskManager:
    """Manages async tasks in a single event loop to prevent resource leaks"""
    
    def __init__(self):
        self._loop = None
        self._thread = None
        self._task_queue = queue.Queue()
        self._running = False
        self._shutdown_event = threading.Event()
        
    def start(self):
        """Start the async task manager"""
        if self._running:
            return
            
        self._running = True
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()
        logger.info("AsyncTaskManager started")
        
    def stop(self):
        """Stop the async task manager"""
        if not self._running:
            return
            
        self._running = False
        self._shutdown_event.set()
        
        # Put a sentinel task to wake up the loop
        self._task_queue.put(None)
        
        if self._thread:
            self._thread.join(timeout=5)
            
        logger.info("AsyncTaskManager stopped")
        
    def _run_loop(self):
        """Run the event loop in a separate thread"""
        try:
            # Create new event loop for this thread
            self._loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self._loop)
            
            # Run the loop until shutdown
            while self._running:
                try:
                    # Get task from queue with timeout
                    task = self._task_queue.get(timeout=1.0)
                    if task is None:  # Shutdown sentinel
                        break
                        
                    # Execute the task
                    if task:
                        coro, callback, error_callback = task
                        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
                        
                        # Add callbacks
                        if callback:
                            future.add_done_callback(lambda f: callback(f.result()) if f.exception() is None else None)
                        if error_callback:
                            future.add_done_callback(lambda f: error_callback(f.exception()) if f.exception() is not None else None)
                            
                except queue.Empty:
                    continue
                except Exception as e:
                    logger.error(f"Error in async task manager: {e}")
                    
        except Exception as e:
            logger.error(f"Failed to start async task manager: {e}")
        finally:
            if self._loop and not self._loop.is_closed():
                try:
                    # Cancel all remaining tasks
                    pending = asyncio.all_tasks(self._loop)
                    for task in pending:
                        task.cancel()
                    
                    if pending:
                        self._loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
                        
                    # Shutdown the loop properly
                    self._loop.run_until_complete(self._loop.shutdown_asyncgens())
                    self._loop.run_until_complete(self._loop.shutdown_default_executor())
                except Exception as e:
                    logger.error(f"Error during loop cleanup: {e}")
                finally:
                    self._loop.close()
                    
    def submit_task(self, coro, callback=None, error_callback=None):
        """Submit an async task to be executed"""
        if not self._running:
            logger.warning("AsyncTaskManager not running, starting it...")
            self.start()
            
        self._task_queue.put((coro, callback, error_callback))

# Global instance
task_manager = AsyncTaskManager()

def run_async_in_background(coro):
    """Decorator to run async functions in background without creating new event loops"""
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            def error_callback(exc):
                if exc:
                    logger.error(f"Background task error: {exc}")
                    
            task_manager.submit_task(coro(*args, **kwargs), error_callback=error_callback)
            
        return wrapper
    return decorator

def safe_async_run(coro, timeout=300):
    """Safely run an async coroutine in the background"""
    def error_callback(exc):
        if exc:
            logger.error(f"Async task error: {exc}")
            
    task_manager.submit_task(coro, error_callback=error_callback)

def run_async_sync(coro, timeout=300):
    """Run an async coroutine synchronously and return the result"""
    import concurrent.futures
    import asyncio
    
    def run_in_new_loop():
        """Run the coroutine in a new event loop"""
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            return loop.run_until_complete(coro)
        finally:
            try:
                # Clean up the loop
                pending = asyncio.all_tasks(loop)
                for task in pending:
                    task.cancel()
                if pending:
                    loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
                loop.run_until_complete(loop.shutdown_asyncgens())
                loop.run_until_complete(loop.shutdown_default_executor())
            except Exception as e:
                logger.error(f"Error during loop cleanup: {e}")
            finally:
                loop.close()
    
    with concurrent.futures.ThreadPoolExecutor() as executor:
        future = executor.submit(run_in_new_loop)
        return future.result(timeout=timeout)

# Initialize the task manager when module is imported
task_manager.start()

# Cleanup on module exit
import atexit
atexit.register(task_manager.stop)
