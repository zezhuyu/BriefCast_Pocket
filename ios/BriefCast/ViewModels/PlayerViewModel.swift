//
//  PlayerViewModel.swift
//  BriefCast
//
//  Created by Zezhu Yu on 2025-06-09.
//

import Foundation
import AVFoundation
import Combine
import MediaPlayer
import UIKit

class PlayerViewModel: ObservableObject {
    @Published var currentPodcast: Podcast?
    @Published var isPlaying = false
    @Published var currentTime: TimeInterval = 0
    @Published var duration: TimeInterval = 0
    @Published var isLoading = false
    @Published var errorMessage: String?
    @Published var shouldNavigateToPlayer = false
    // UI properties for current media (podcast or transition)
    @Published var currentImageUrl: String = ""
    @Published var currentTranscriptUrl: String = ""
    @Published var currentTitle: String = ""
    @Published var currentHost: String = ""
    
    // Image caching for lock screen artwork
    private var imageCache: [String: UIImage] = [:]
    
    // New properties for enhanced functionality
    @Published var currentQueue: [PodcastCard] = []
    @Published var currentIndex: Int = 0
    @Published var isLiked: Bool = false
    @Published var isDisliked: Bool = false
    @Published var isDownloading: Bool = false
    @Published var downloadProgress: Double = 0
    @Published var isDownloaded: Bool = false
    
    // New properties for queue management
    @Published var isFromExternalSelection = false // Track if podcast was selected from outside player
    @Published var persistentRecommendations: [PodcastCard] = [] // Keep recommendations persistent
    
    private var player: AVPlayer?
    private var timeObserver: Any?
    private var cancellables = Set<AnyCancellable>()
    private let graphQLService = GraphQLService.shared
    private var pollingTimer: Timer?
    private var positionLogTimer: Timer? // Timer for logging position every 3 seconds
    private var transitionPollingTimer: Timer? // Timer for polling transition audio
    private var nextPodcast: Podcast? // Store the prefetched next podcast
    private var currentTransition: Transition? // Store the current transition audio
    @Published private(set) var isPlayingTransition = false // Flag to track if we're playing transition audio that views may observe
    
    // Flag to avoid overlapping additional-recommendation fetches
    private var isFetchingMoreRecommendations = false
    
    // User Action Logging
    private var currentSessionActions: [UserAction] = []
    private var currentSessionPositionLog: [PositionLog] = []
    private var sessionStartTime: Date?
    private var totalListenTime: TimeInterval = 0
    private var listenedPositions: Set<Int> = []
    private var lastLoggedPosition: Double = 0
    // Track if the current podcast started via automatic playback (not user initiated)
    private var isAutoPlayCurrentSession: Bool = false
    
    init() {
        setupAudioSession()
        setupRemoteTransportControls()
        setupAppLifecycleObservers()
    }
    
    deinit {
        if let observer = timeObserver {
            player?.removeTimeObserver(observer)
        }
        pollingTimer?.invalidate()
        positionLogTimer?.invalidate()
        
        // Send final session log before deallocation
        endCurrentSession()
    }
    
    // MARK: - Audio Session Setup
    private func setupAudioSession() {
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {}
    }
    
    // MARK: - Remote Control Setup
    private func setupRemoteTransportControls() {
        let commandCenter = MPRemoteCommandCenter.shared()
        
        commandCenter.playCommand.addTarget { [weak self] _ in
            self?.play()
            return .success
        }
        
        commandCenter.pauseCommand.addTarget { [weak self] _ in
            self?.pause()
            return .success
        }
        
        commandCenter.skipForwardCommand.preferredIntervals = [NSNumber(value: 30)]
        commandCenter.skipForwardCommand.addTarget { [weak self] _ in
            self?.skipForward(30)
            return .success
        }
        
        commandCenter.skipBackwardCommand.preferredIntervals = [NSNumber(value: 15)]
        commandCenter.skipBackwardCommand.addTarget { [weak self] _ in
            self?.skipBackward(15)
            return .success
        }
    }
    
    // MARK: - App Lifecycle Setup
    private func setupAppLifecycleObservers() {
        // Send session log when app goes to background
        NotificationCenter.default.addObserver(
            forName: NSNotification.Name("UIApplicationWillResignActiveNotification"),
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.endCurrentSession()
        }
        
        // Send session log when app terminates
        NotificationCenter.default.addObserver(
            forName: NSNotification.Name("UIApplicationWillTerminateNotification"),
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.endCurrentSession()
        }
    }
    
    // MARK: - Now Playing Info
    private func updateNowPlayingInfo() {
        var nowPlayingInfo = [String: Any]()
        nowPlayingInfo[MPMediaItemPropertyTitle] = currentTitle
        nowPlayingInfo[MPMediaItemPropertyArtist] = currentHost
        nowPlayingInfo[MPMediaItemPropertyPlaybackDuration] = duration
        nowPlayingInfo[MPNowPlayingInfoPropertyElapsedPlaybackTime] = currentTime
        nowPlayingInfo[MPNowPlayingInfoPropertyPlaybackRate] = isPlaying ? 1.0 : 0.0
        
        // Load artwork if available
        loadArtworkForNowPlaying { [weak self] image in
            DispatchQueue.main.async {
                if let image = image {
                    let artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                    nowPlayingInfo[MPMediaItemPropertyArtwork] = artwork
                }
                MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlayingInfo
            }
        }
    }
    
    // MARK: - Artwork Loading
    private func loadArtworkForNowPlaying(completion: @escaping (UIImage?) -> Void) {
        guard !currentImageUrl.isEmpty else {
            completion(nil)
            return
        }
        
        // Check cache first
        if let cachedImage = imageCache[currentImageUrl] {
            completion(cachedImage)
            return
        }
        
        // Load image from URL
        guard let url = URL(string: currentImageUrl) else {
            completion(nil)
            return
        }
        
        URLSession.shared.dataTask(with: url) { [weak self] data, response, error in
            guard let data = data, 
                  error == nil, 
                  let image = UIImage(data: data) else {
                completion(nil)
                return
            }
            
            // Cache the image
            DispatchQueue.main.async {
                self?.imageCache[self?.currentImageUrl ?? ""] = image
            }
            
            completion(image)
        }.resume()
    }
    
    // MARK: - Cache Management
    private func clearImageCache() {
        imageCache.removeAll()
    }
    
    private func clearImageCache(for url: String) {
        imageCache.removeValue(forKey: url)
    }
    
    // MARK: - Artwork Preloading
    private func preloadArtwork(for imageUrl: String) {
        guard !imageUrl.isEmpty,
              imageCache[imageUrl] == nil,
              let url = URL(string: imageUrl) else { return }
        
        URLSession.shared.dataTask(with: url) { [weak self] data, response, error in
            guard let data = data,
                  error == nil,
                  let image = UIImage(data: data) else { return }
            
            DispatchQueue.main.async {
                self?.imageCache[imageUrl] = image
            }
        }.resume()
    }
    
    // MARK: - Podcast Loading
    func loadPodcast(id: String, external: Bool = false, autoPlay: Bool = false) {
        // End current session if there's an active podcast
        if currentPodcast != nil {
            // Preserve the current session's autoPlay status before changing it
            let currentSessionAutoPlay = isAutoPlayCurrentSession
            // End the current session with its original autoPlay status
            endCurrentSessionWithAutoPlay(autoPlay: currentSessionAutoPlay)
        }
        
        // Record how the new podcast session started
        isAutoPlayCurrentSession = autoPlay
        
        if external {
            // Treat as new selection from outside player
            persistentRecommendations = []
            isFromExternalSelection = true
        }
        
        isLoading = true
        errorMessage = nil
        shouldNavigateToPlayer = true
        
        pollingTimer?.invalidate()
        
        loadPodcastWithPolling(id: id)
    }
    
    private func loadPodcastWithPolling(id: String) {
        graphQLService.findPodcast(id: id)
            .receive(on: DispatchQueue.main)
            .sink(
                receiveCompletion: { [weak self] completion in
                    if case .failure(let error) = completion {
                        self?.errorMessage = error.localizedDescription
                        self?.isLoading = false
                    }
                },
                receiveValue: { [weak self] podcast in
                    self?.currentPodcast = podcast
                    
                    // Check if podcast is fully ready (has audioUrl and valid duration)
                    if podcast.audioUrl.isEmpty || podcast.durationSeconds <= 0 {
                        self?.startPolling(for: id)
                    } else {
                        self?.isLoading = false
                        self?.setupPlayer(with: podcast)
                        self?.play()
                    }
                }
            )
            .store(in: &cancellables)
    }
    
    private func startPolling(for podcastId: String) {
        pollingTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            self?.checkForPodcastReadiness(podcastId: podcastId)
        }
    }
    
    private func checkForPodcastReadiness(podcastId: String) {
        graphQLService.findPodcast(id: podcastId)
            .receive(on: DispatchQueue.main)
            .sink(
                receiveCompletion: { completion in
                    // Keep polling even if there's an error
                    if case .failure(let error) = completion {
                    }
                },
                receiveValue: { [weak self] podcast in
                    // Check if podcast is now fully ready
                    if !podcast.audioUrl.isEmpty && podcast.durationSeconds > 0 {
                        self?.pollingTimer?.invalidate()
                        self?.pollingTimer = nil
                        self?.currentPodcast = podcast
                        self?.isLoading = false
                        self?.setupPlayer(with: podcast)
                        self?.play()
                    } else {
                        // Keep polling if podcast is not ready
                    }
                }
            )
            .store(in: &cancellables)
    }
    
    func generatePodcast(location: [Double]? = nil, force: Bool = false, summary: Bool = false) {
        isLoading = true
        errorMessage = nil
        
        // Start the retry mechanism
        retryGeneratePodcast(location: location, force: force, summary: summary, attempt: 1)
    }
    
    private func retryGeneratePodcast(location: [Double]? = nil, force: Bool = false, summary: Bool = false, attempt: Int) {
        let maxAttempts = 30 // Maximum attempts to prevent infinite loop
        let delaySeconds: Double = 3.0 // Delay between retries
        
        graphQLService.generatePodcast(location: location)
            .receive(on: DispatchQueue.main)
            .sink(
                receiveCompletion: { [weak self] completion in
                    if case .failure(let error) = completion {
                        
                        if attempt < maxAttempts {
                            // Retry after delay
                            DispatchQueue.main.asyncAfter(deadline: .now() + delaySeconds) {
                                self?.retryGeneratePodcast(location: location, force: force, summary: summary, attempt: attempt + 1)
                            }
                        } else {
                            // Max attempts reached, stop loading and show error
                            self?.isLoading = false
                            self?.errorMessage = error.localizedDescription
                        }
                    }
                },
                receiveValue: { [weak self] podcast in
                    
                    if podcast.durationSeconds > 0 {
                        // Success! We have a valid duration
                        self?.currentPodcast = podcast
                        self?.setupPlayer(with: podcast)
                    } else {
                        // Duration is 0, retry if we haven't exceeded max attempts
                        
                        if attempt < maxAttempts {
                            // Retry after delay
                            DispatchQueue.main.asyncAfter(deadline: .now() + delaySeconds) {
                                self?.retryGeneratePodcast(location: location, force: force, summary: summary, attempt: attempt + 1)
                            }
                        } else {
                            // Max attempts reached, stop loading and show error
                            self?.isLoading = false
                            self?.errorMessage = "Podcast generation is taking longer than expected. Please try again later."
                        }
                    }
                }
            )
            .store(in: &cancellables)
    }
    
    // MARK: - Player Setup
    private func setupPlayer(with podcast: Podcast) {
        // Validate audioUrl is not empty
        guard !podcast.audioUrl.isEmpty else {
            errorMessage = "Audio not ready yet, please wait..."
            return
        }
        
        // Clean up previous player state
        cleanupCurrentPlayer()
        
        // Set UI properties for podcast
        currentImageUrl = podcast.imageUrl
        currentTranscriptUrl = podcast.transcriptUrl
        currentTitle = podcast.title
        currentHost = "BriefCast" // or use podcast.host if available
        duration = podcast.durationSeconds
        currentTime = 0
        
        // Preload artwork for current podcast
        preloadArtwork(for: podcast.imageUrl)
        
        guard let url = URL(string: podcast.audioUrl) else {
            errorMessage = "Invalid audio URL"
            return
        }
        
        let playerItem = AVPlayerItem(url: url)
        player = AVPlayer(playerItem: playerItem)
        
        // Observe duration
        playerItem.publisher(for: \.duration)
            .compactMap { $0.isNumeric ? CMTimeGetSeconds($0) : nil }
            .assign(to: \.duration, on: self)
            .store(in: &cancellables)
        
        // Observe status
        playerItem.publisher(for: \.status)
            .sink { [weak self] status in
                switch status {
                case .readyToPlay:
                    self?.isLoading = false
                    // Prefetch only if we already know what the next podcast is (i.e., queue has a next item)
                    if let strongSelf = self {
                        if strongSelf.hasNext {
                            strongSelf.prefetchNextPodcast()
                        }
                        strongSelf.checkAndFetchMoreRecommendationsIfNeeded()
                    }
                case .failed:
                    self?.errorMessage = playerItem.error?.localizedDescription ?? "Failed to load audio"
                    self?.isLoading = false
                default:
                    break
                }
            }
            .store(in: &cancellables)
        
        // Observe playback completion
        NotificationCenter.default.publisher(for: .AVPlayerItemDidPlayToEndTime, object: playerItem)
            .sink { [weak self] _ in
                self?.handlePlaybackCompletion()
            }
            .store(in: &cancellables)
        
        // Add time observer
        setupTimeObserver()
        updateNowPlayingInfo()
        
        // Start new user session for this podcast
        startNewSession()
        
        // Check download status and like status for the new podcast
        checkDownloadStatus()
        checkLikeStatus()
        
        // If we don't have cached recommendations yet (first podcast after user selection), fetch now
        if persistentRecommendations.isEmpty {
            refreshRecommendations()
        }
    }
    
    // MARK: - Player Cleanup
    private func cleanupCurrentPlayer() {
        // Remove time observer
        if let observer = timeObserver {
            player?.removeTimeObserver(observer)
            timeObserver = nil
        }
        
        // Stop position logging
        stopPositionLogging()
        
        // Pause current player
        player?.pause()
        
        // Clear player reference
        player = nil
    }
    
    private func setupTimeObserver() {
        // Remove existing time observer before adding a new one
        if let observer = timeObserver {
            player?.removeTimeObserver(observer)
            timeObserver = nil
        }
        
        let interval = CMTime(seconds: 0.5, preferredTimescale: CMTimeScale(NSEC_PER_SEC))
        timeObserver = player?.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] time in
            self?.currentTime = CMTimeGetSeconds(time)
            self?.updateNowPlayingInfo()
        }
    }
    
    // MARK: - Playback Controls
    func togglePlayPause() {
        if isPlaying {
            pause()
        } else {
            play()
        }
    }
    
    func play() {
        // Don't log play action for transition audio
        if !isPlayingTransition {
            logUserAction("play", details: UserActionDetails(
                from: currentTime,
                to: nil,
                playlistId: nil
            ))
        }
        
        player?.play()
        isPlaying = true
        updateNowPlayingInfo()
        startPositionLogging()
    }
    
    func pause() {
        // Don't log pause action for transition audio
        if !isPlayingTransition {
            logUserAction("pause", details: UserActionDetails(
                from: currentTime,
                to: nil,
                playlistId: nil
            ))
        }
        
        player?.pause()
        isPlaying = false
        updateNowPlayingInfo()
        stopPositionLogging()
    }
    
    func seek(to time: TimeInterval) {
        let previousTime = currentTime
        let cmTime = CMTime(seconds: time, preferredTimescale: CMTimeScale(NSEC_PER_SEC))
        player?.seek(to: cmTime)
        currentTime = time
        updateNowPlayingInfo()
        
        // Log user action
        logUserAction("seek", details: UserActionDetails(
            from: previousTime,
            to: time,
            playlistId: nil
        ))
    }
    
    func skipForward(_ seconds: TimeInterval) {
        let previousTime = currentTime
        let newTime = min(currentTime + seconds, duration)
        seek(to: newTime)
        
        // Log user action
        logUserAction("skip_forward", details: UserActionDetails(
            from: previousTime,
            to: newTime,
            playlistId: nil
        ))
    }
    
    func skipBackward(_ seconds: TimeInterval) {
        let previousTime = currentTime
        let newTime = max(currentTime - seconds, 0)
        seek(to: newTime)
        
        // Log user action
        logUserAction("skip_backward", details: UserActionDetails(
            from: previousTime,
            to: newTime,
            playlistId: nil
        ))
    }
    
    // MARK: - Position Logging
    private func startPositionLogging() {
        // Stop any existing timer
        stopPositionLogging()
        
        guard let podcast = currentPodcast, isPlaying, !isPlayingTransition else {
            return
        }
        
        // Start new timer that fires every 3 seconds
        positionLogTimer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.logCurrentPosition()
        }
        
    }
    
    private func stopPositionLogging() {
        positionLogTimer?.invalidate()
        positionLogTimer = nil
    }
    
    private func logCurrentPosition() {
        guard let podcast = currentPodcast, isPlaying, !isPlayingTransition else {
            return
        }
        
        let positionSeconds = Int(currentTime)
        
        // Log position for session tracking
        logPositionForSession()
        
        // Update total listen time
        totalListenTime += 3.0 // 3 seconds since last log
        
        graphQLService.logPlayingPosition(podcastId: podcast.id, position: positionSeconds)
            .receive(on: DispatchQueue.main)
            .sink(
                receiveCompletion: { completion in
//                    if case .failure(let error) = completion {
//                    }
                },
                receiveValue: { result in
                }
            )
            .store(in: &cancellables)
    }
    
    // MARK: - Utilities
    func formatTime(_ time: TimeInterval) -> String {
        let minutes = Int(time) / 60
        let seconds = Int(time) % 60
        return String(format: "%02d:%02d", minutes, seconds)
    }
    
    var progress: Double {
        guard duration > 0 else { return 0 }
        return currentTime / duration
    }
    
    // MARK: - Queue Management
    func setQueue(_ queue: [PodcastCard], startingAt index: Int = 0, fromExternalSelection: Bool = false, autoPlay: Bool = false) {
        currentQueue = queue
        currentIndex = index
        isFromExternalSelection = fromExternalSelection
        
        // Clear and refetch recommendations if user selected from outside player
        if fromExternalSelection {
            persistentRecommendations = []
            refreshRecommendations() // pre-fetch for upcoming autoplay
        }
        
        if !queue.isEmpty && index < queue.count {
            let selectedPodcast = queue[index]
            loadPodcast(id: selectedPodcast.id, autoPlay: autoPlay)
        }
    }
    
    func playNext(autoPlay: Bool = false) {
        // Skip transition audio if it's playing
        if isPlayingTransition {
            handleTransitionCompletion()
            return
        }
        
        guard hasNext else { return }
        currentIndex += 1
        
        let nextPodcast = currentQueue[currentIndex]
        loadPodcast(id: nextPodcast.id, autoPlay: autoPlay)
        
        // If we just advanced to the last item in recommendations, trigger fetch
        checkAndFetchMoreRecommendationsIfNeeded()
    }
    
    func playPrevious() {
        // Skip transition audio if it's playing
        if isPlayingTransition {
            handleTransitionCompletion()
            return
        }
        
        guard hasPrevious else { return }
        currentIndex -= 1
        
        let previousPodcast = currentQueue[currentIndex]
        loadPodcast(id: previousPodcast.id)
    }
    
    var hasNext: Bool {
        return currentIndex < currentQueue.count - 1
    }
    
    var hasPrevious: Bool {
        return currentIndex > 0
    }
    
    // MARK: - Like/Dislike Functionality
    func toggleLike() {
        guard let podcast = currentPodcast else { return }
        
        if isLiked {
            // Remove like
            isLiked = false
            removeFromPlaylist(playlistId: "like", podcastId: podcast.id)
            logUserAction("unlike")
        } else {
            // Add like
            isLiked = true
            isDisliked = false
            addToLikePlaylist(podcast: podcast)
            logUserAction("like")
        }
        
        updateRating()
    }
    
    func toggleDislike() {
        guard let podcast = currentPodcast else { return }
        
        if isDisliked {
            isDisliked = false
            logUserAction("remove_dislike")
        } else {
            isDisliked = true
            isLiked = false
            // Remove from like playlist if it was liked
            removeFromPlaylist(playlistId: "like", podcastId: podcast.id)
            logUserAction("dislike")
        }
        
        updateRating()
    }
    
    private func updateRating() {
        // This could send rating to backend if there's an API for it
        // For now, we'll just track the state locally
    }
    
    private func addToLikePlaylist(podcast: Podcast) {
        graphQLService.addToPlaylist(playlistId: "like", podcastId: podcast.id)
            .receive(on: DispatchQueue.main)
            .sink(
                receiveCompletion: { completion in
                    if case .failure(_) = completion {
                    }
                },
                receiveValue: { _ in
                }
            )
            .store(in: &cancellables)
    }
    
    private func removeFromPlaylist(playlistId: String, podcastId: String) {
        graphQLService.removeFromPlaylist(playlistId: playlistId, podcastId: podcastId)
            .receive(on: DispatchQueue.main)
            .sink(
                receiveCompletion: { completion in
                    if case .failure(_) = completion {
                    }
                },
                receiveValue: { _ in
                }
            )
            .store(in: &cancellables)
    }
    
    // MARK: - Download Functionality
    func toggleDownload() {
        // guard let podcast = currentPodcast else { return }
        
        if isDownloaded {
            deleteDownload()
        } else if !isDownloading {
            downloadPodcast()
        }
    }
    
    private func downloadPodcast() {
        guard let podcast = currentPodcast,
              let url = URL(string: podcast.audioUrl) else { return }
        
        isDownloading = true
        downloadProgress = 0
        
        let documentsPath = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let downloadPath = documentsPath.appendingPathComponent("\(podcast.id).mp3")
        
        let task = URLSession.shared.downloadTask(with: url) { [weak self] localURL, response, error in
            DispatchQueue.main.async {
                self?.isDownloading = false
                
                if error != nil {
                    return
                }
                
                guard let localURL = localURL else { return }
                
                do {
                    // Remove existing file if it exists
                    if FileManager.default.fileExists(atPath: downloadPath.path) {
                        try FileManager.default.removeItem(at: downloadPath)
                    }
                    
                    try FileManager.default.moveItem(at: localURL, to: downloadPath)
                    self?.isDownloaded = true
                } catch {
                }
            }
        }
        
        task.resume()
    }
    
    private func deleteDownload() {
        guard let podcast = currentPodcast else { return }
        
        let documentsPath = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let downloadPath = documentsPath.appendingPathComponent("\(podcast.id).mp3")
        
        do {
            try FileManager.default.removeItem(at: downloadPath)
            isDownloaded = false
        } catch {
        }
    }
    
    // MARK: - Check Download Status
    private func checkDownloadStatus() {
        guard let podcast = currentPodcast else {
            isDownloaded = false
            return
        }
        
        let documentsPath = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let downloadPath = documentsPath.appendingPathComponent("\(podcast.id).mp3")
        isDownloaded = FileManager.default.fileExists(atPath: downloadPath.path)
    }
    
    // MARK: - Add to Playlist
    func addCurrentPodcastToPlaylist(playlistId: String) {
        guard let podcast = currentPodcast else { return }
        
        // Log user action
        logUserAction("add_to_playlist", details: UserActionDetails(
            from: nil,
            to: nil,
            playlistId: playlistId
        ))
        
        graphQLService.addToPlaylist(playlistId: playlistId, podcastId: podcast.id)
            .receive(on: DispatchQueue.main)
            .sink(
                receiveCompletion: { completion in
                    if case .failure(_) = completion {
                    }
                },
                receiveValue: { _ in
                }
            )
            .store(in: &cancellables)
    }
    
    private func checkLikeStatus() {
        // Check if current podcast is liked
        // This would require querying the like playlist or podcast rating
        // For now, we'll reset the state
        isLiked = false
        isDisliked = false
    }
    
    // MARK: - Playback Completion
    private func handlePlaybackCompletion() {
        isPlaying = false
        stopPositionLogging()
        
        // Log completion action
        logUserAction("completed", details: UserActionDetails(
            from: nil,
            to: currentTime,
            playlistId: nil
        ))
        
        // Decide on next action: transition vs. move to recommendations
        if nextPodcast != nil {
            // We have a prefetched next podcast (e.g., from recommendations) ➜ start transition polling
            startTransitionPolling()
            return
        }

        if hasNext {
            // Standard queue case
            startTransitionPolling()
        } else {
            // Queue exhausted – proceed to recommendations (will fetch and then trigger prefetch logic)
            proceedToRecommendationsIfNeeded()
        }
    }
    
    // MARK: - Proceed to Recommendations
    private func proceedToRecommendationsIfNeeded() {
        // Determine if current queue is already the recommendations queue
        let isCurrentQueueRecommendations = !persistentRecommendations.isEmpty && currentQueue.map { $0.id } == persistentRecommendations.map { $0.id }
        
        if !persistentRecommendations.isEmpty {
            if !isCurrentQueueRecommendations {
                // We have recs but not playing them yet → switch
                setQueue(persistentRecommendations, startingAt: 0, fromExternalSelection: false, autoPlay: true)
            } else if currentIndex == currentQueue.count - 1 {
                // We are at the last recommendation → fetch more and append
                fetchAdditionalRecommendations()
            }
            return
        }

        // No recommendations cached yet – fetch initial set
        guard let currentPodcast = currentPodcast else { return }
        refreshRecommendations(maxAttempts: 5)
    }
    
    // Fetch another page of recommendations and append (deduplicated)
    private func fetchAdditionalRecommendations() {
        guard let currentPodcast = currentPodcast else { return }
        fetchRecommendations(podcastId: currentPodcast.id, attempt: 1, maxAttempts: 5, append: true)
    }
    
    // MARK: - Recommendation fetch with retry
    private func refreshRecommendations(maxAttempts: Int = 5) {
        guard let currentPodcast = currentPodcast else { return }
        fetchRecommendations(podcastId: currentPodcast.id, attempt: 1, maxAttempts: maxAttempts, append: false)
    }
    
    private func fetchRecommendations(podcastId: String, attempt: Int, maxAttempts: Int, append: Bool) {
        graphQLService.getRecommendations(podcastId: podcastId)
            .receive(on: DispatchQueue.main)
            .sink(
                receiveCompletion: { [weak self] completion in
                    if case .failure(let error) = completion {
                        if attempt < maxAttempts {
                            DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                                self?.fetchRecommendations(podcastId: podcastId, attempt: attempt + 1, maxAttempts: maxAttempts, append: append)
                            }
                        }
                    }
                },
                receiveValue: { [weak self] recommendations in
                    guard let self = self else { return }
                    if append {
                        self.appendRecommendations(recommendations)
                    } else {
                        self.persistentRecommendations = recommendations
                    }
                    self.prefetchNextRecommendationIfNeeded()
                }
            )
            .store(in: &cancellables)
    }
    
    private func appendRecommendations(_ newRecs: [PodcastCard]) {
        // deduplicate by id
        let existingIds = Set(persistentRecommendations.map { $0.id })
        let unique = newRecs.filter { !existingIds.contains($0.id) }
        guard !unique.isEmpty else { 
            isFetchingMoreRecommendations = false
            return 
        }
        persistentRecommendations.append(contentsOf: unique)
        // If current queue is playing recommendations (i.e., it is a prefix of the new persistent list), extend it too
        let currentIds = currentQueue.map { $0.id }
        let prefixedIds = persistentRecommendations.prefix(currentIds.count).map { $0.id }
        if currentIds == prefixedIds {
            currentQueue.append(contentsOf: unique)
            prefetchNextPodcast()
        }
        isFetchingMoreRecommendations = false
    }
    
    // MARK: - User Action Logging
    
    private func logUserAction(_ action: String, details: UserActionDetails? = nil) {
        guard let podcast = currentPodcast else { return }
        
        let userAction = UserAction(
            timestamp: Int(Date().timeIntervalSince1970),
            action: action,
            podcastId: podcast.id,
            details: details
        )
        
        currentSessionActions.append(userAction)
    }
    
    private func logPositionForSession() {
        let positionLog = PositionLog(
            time: Int(Date().timeIntervalSince1970),
            position: currentTime
        )
        currentSessionPositionLog.append(positionLog)
        
        // Track listened seconds (in 1-second intervals)
        let currentSecond = Int(currentTime)
        listenedPositions.insert(currentSecond)
        lastLoggedPosition = currentTime
    }
    
    private func startNewSession() {
        // Send previous session data if exists
        sendCurrentSessionLogWithAutoPlay(autoPlay: isAutoPlayCurrentSession)
        
        // Reset session data
        currentSessionActions = []
        currentSessionPositionLog = []
        sessionStartTime = Date()
        totalListenTime = 0
        listenedPositions = []
        lastLoggedPosition = 0
        
        // Log session start
        logUserAction("session_start")
    }
    
    private func endCurrentSession() {
        guard currentPodcast != nil else { return }
        
        // Log session end
        logUserAction("session_end", details: UserActionDetails(
            from: nil,
            to: currentTime,
            playlistId: nil
        ))
        
        // Send session data with the provided autoPlay flag
        sendCurrentSessionLogWithAutoPlay(autoPlay: isAutoPlayCurrentSession)
    }
    
    private func endCurrentSessionWithAutoPlay(autoPlay: Bool) {
        guard currentPodcast != nil else { return }
        
        // Log session end
        logUserAction("session_end", details: UserActionDetails(
            from: nil,
            to: currentTime,
            playlistId: nil
        ))
        
        // Send session data with the provided autoPlay flag
        sendCurrentSessionLogWithAutoPlay(autoPlay: autoPlay)
    }
    
    private func sendCurrentSessionLogWithAutoPlay(autoPlay: Bool) {
        guard let podcast = currentPodcast, !currentSessionActions.isEmpty else {
            return
        }
        
        // Calculate session metrics
        let sessionDuration = sessionStartTime?.timeIntervalSinceNow.magnitude ?? 0
        let coveragePercentage = duration > 0 ? (Double(listenedPositions.count) / duration) * 100 : 0
        let listenedSecondsArray = Array(listenedPositions).sorted()
        
        let userLog = UserLog(
            podcastId: podcast.id,
            actions: currentSessionActions,
            listenedSeconds: listenedSecondsArray,
            listenDurationSeconds: totalListenTime,
            totalDurationSeconds: duration,
            coveragePercentage: min(coveragePercentage, 100.0),
            lastPosition: lastLoggedPosition,
            positionLog: currentSessionPositionLog,
            listeningTime: Int(sessionDuration),
            autoPlay: autoPlay
        )
        
        graphQLService.markAsPlayed(userLog: userLog)
            .receive(on: DispatchQueue.main)
            .sink(
                receiveCompletion: { completion in
                    if case .failure(_) = completion {
                    }
                },
                receiveValue: { result in
                }
            )
            .store(in: &cancellables)
        
        // Clear session data after sending
        currentSessionActions = []
        currentSessionPositionLog = []
    }
    
    // MARK: - Prefetch Functionality
    private func prefetchNextPodcast() {
        guard hasNext else { return }
        
        let nextPodcastId = currentQueue[currentIndex + 1].id
        
        // Fetch next podcast
        graphQLService.findPodcast(id: nextPodcastId)
            .receive(on: DispatchQueue.main)
            .sink(
                receiveCompletion: { completion in
                    if case .failure(let error) = completion {
                    }
                },
                receiveValue: { [weak self] podcast in
                    self?.nextPodcast = podcast
                    // Preload artwork for the next podcast
                    self?.preloadArtwork(for: podcast.imageUrl)
                    // Start preparing transition audio
                    self?.prepareTransitionAudio()
                }
            )
            .store(in: &cancellables)
    }
    
    private func prepareTransitionAudio() {
        guard let currentPodcast = currentPodcast,
              let nextPodcast = nextPodcast else { return }
        
        // Just make one request to start the transition audio preparation
        graphQLService.getTransition(from: currentPodcast.id, to: nextPodcast.id)
            .receive(on: DispatchQueue.main)
            .sink(
                receiveCompletion: { completion in
                    if case .failure(let error) = completion {
                    }
                },
                receiveValue: { transition in
                }
            )
            .store(in: &cancellables)
    }
    
    private func startTransitionPolling() {
        guard let currentPodcast = currentPodcast,
              let nextPodcast = nextPodcast else { return }
        // Start polling for transition audio
        transitionPollingTimer?.invalidate()
        transitionPollingTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            self?.checkTransitionAudio(from: currentPodcast.id, to: nextPodcast.id)
        }
    }
    
    private func checkTransitionAudio(from currentId: String, to nextId: String) {
        graphQLService.getTransition(from: currentId, to: nextId)
            .receive(on: DispatchQueue.main)
            .sink(
                receiveCompletion: { completion in
                    if case .failure(let error) = completion {
                    }
                },
                receiveValue: { [weak self] transition in
                    if transition.secs > 0 {
                        self?.transitionPollingTimer?.invalidate()
                        self?.transitionPollingTimer = nil
                        self?.currentTransition = transition
                        self?.playTransitionAudio()
                    } else {
                    }
                }
            )
            .store(in: &cancellables)
    }
    
    private func playTransitionAudio() {
        guard let transition = currentTransition,
              let url = URL(string: transition.audioUrl) else { return }
        
        isPlayingTransition = true
        
        // Clean up previous player state
        cleanupCurrentPlayer()
        
        // Set UI properties for transition audio
        currentImageUrl = transition.imageUrl
        currentTranscriptUrl = transition.transcriptUrl
        currentTitle = "BriefCast Host"
        currentHost = "Sofia Lane"
        duration = transition.secs
        currentTime = 0
        
        // Create a new player item for the transition audio
        let playerItem = AVPlayerItem(url: url)
        player = AVPlayer(playerItem: playerItem)
        
        // Add periodic time observer so UI (progress bar, transcript) updates during transition playback
        setupTimeObserver()
        
        // Observe transition audio completion
        NotificationCenter.default.publisher(for: .AVPlayerItemDidPlayToEndTime, object: playerItem)
            .sink { [weak self] _ in
                self?.handleTransitionCompletion()
            }
            .store(in: &cancellables)
        
        // Start playing
        player?.play()
        isPlaying = true
        updateNowPlayingInfo()
    }
    
    private func handleTransitionCompletion() {
        isPlayingTransition = false
        currentTransition = nil
        // UI properties will be set by setupPlayer(with:) for the next podcast
        
        // Auto-play next podcast if available in queue
        if hasNext {
            if let next = nextPodcast {
                currentIndex += 1
                // Use standard loading routine to guarantee audio and transcript readiness
                loadPodcast(id: next.id, autoPlay: true)
            } else {
                playNext(autoPlay: true)
            }
        } else {
            // Only act when queue is exhausted
            proceedToRecommendationsIfNeeded()
        }
    }
    
    // MARK: - Prefetch based on recommendations readiness
    private func prefetchNextRecommendationIfNeeded() {
        // Only prefetch if we currently do not have a next item in the queue and no prefetch is in flight
        guard !hasNext, nextPodcast == nil, let firstRec = persistentRecommendations.first else { return }


        graphQLService.findPodcast(id: firstRec.id)
            .receive(on: DispatchQueue.main)
            .sink(
                receiveCompletion: { completion in
                    if case .failure(let error) = completion {
                    }
                },
                receiveValue: { [weak self] podcast in
                    self?.nextPodcast = podcast
                    // Prepare transition audio now that we have both current and next podcasts.
                    self?.prepareTransitionAudio()
                }
            )
            .store(in: &cancellables)
    }
    
    // MARK: - Auto-extend Recommendations Queue
    private func checkAndFetchMoreRecommendationsIfNeeded() {
        // Only when current queue is recommendations list
        guard !persistentRecommendations.isEmpty else { return }
        let isRecommendationsQueue = currentQueue.map { $0.id } == persistentRecommendations.map { $0.id }
        guard isRecommendationsQueue else { return }
        guard currentIndex == currentQueue.count - 1 else { return }
        guard !isFetchingMoreRecommendations else { return }

        isFetchingMoreRecommendations = true
        fetchRecommendations(podcastId: currentPodcast?.id ?? "", attempt: 1, maxAttempts: 5, append: true)
    }
} 
 
