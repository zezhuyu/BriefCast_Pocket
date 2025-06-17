import asyncio
import threading
import multiprocessing
import time


class HybridLock:
    def __init__(self):
        self._thread_lock = threading.Lock()
        self._async_lock = asyncio.Lock()

    def __enter__(self):
        self._thread_lock.acquire()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self._thread_lock.release()

    async def __aenter__(self):
        await self._async_lock.acquire()
        self._thread_lock.acquire()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        self._thread_lock.release()
        self._async_lock.release()

class SharedStore:
    _manager = multiprocessing.Manager()
    _data = _manager.dict()
    _sets = _manager.dict()
    _expirations = _manager.dict()
    _lock = HybridLock()
    _expire_thread_started = False
    _stop_event = threading.Event()

    _channels = {}

    def __init__(self):
        with SharedStore._lock:
            if not SharedStore._expire_thread_started:
                SharedStore._expire_thread_started = True
                t = threading.Thread(target=self._expire_worker, daemon=True)
                t.start()

    def exists(self, key):
        with SharedStore._lock:
            return key in SharedStore._data and not self._is_expired(key)

    def set(self, key, value, ttl=None):
        with SharedStore._lock:
            SharedStore._data[key] = value
            if ttl:
                SharedStore._expirations[key] = time.time() + ttl
            elif key in SharedStore._expirations:
                del SharedStore._expirations[key]

    def get(self, key):
        with SharedStore._lock:
            if key in SharedStore._data:
                if self._is_expired(key):
                    self._expire_key(key)
                    return None
                return SharedStore._data[key]
            return None

    def sadd(self, set_name, member):
        with SharedStore._lock:
            if set_name not in SharedStore._sets:
                SharedStore._sets[set_name] = SharedStore._manager.list()
            if member not in SharedStore._sets[set_name]:
                SharedStore._sets[set_name].append(member)

    def sismember(self, set_name, member):
        with SharedStore._lock:
            return member in SharedStore._sets.get(set_name, [])

    def srem(self, set_name, member):
        with SharedStore._lock:
            if set_name in SharedStore._sets and member in SharedStore._sets[set_name]:
                SharedStore._sets[set_name].remove(member)

    def subscribe(self, channel, callback):
        with SharedStore._lock:
            if channel not in SharedStore._channels:
                SharedStore._channels[channel] = []
            SharedStore._channels[channel].append(callback)

    def publish(self, channel, message):
        with SharedStore._lock:
            callbacks = SharedStore._channels.get(channel, [])
            for cb in callbacks:
                try:
                    cb(message)
                except Exception as e:
                    print(f"Error in pubsub callback: {e}")

    def _is_expired(self, key):
        return key in SharedStore._expirations and time.time() > SharedStore._expirations[key]

    def _expire_key(self, key):
        with SharedStore._lock:
            value = SharedStore._data.get(key)
            if key in SharedStore._data:
                del SharedStore._data[key]
            if key in SharedStore._expirations:
                del SharedStore._expirations[key]
            self.publish("expired", {"key": key, "value": value})

    def _expire_worker(self):
        while not SharedStore._stop_event.is_set():
            time.sleep(0.5)
            with SharedStore._lock:
                keys = list(SharedStore._expirations.keys())
                for key in keys:
                    if self._is_expired(key):
                        self._expire_key(key)

    @classmethod
    def stop(cls):
        cls._stop_event.set()

store = SharedStore()