//
//  PodcastModels.swift
//  BriefCast
//
//  Created by Zezhu Yu on 2025-06-09.
//

import Foundation

// MARK: - URL Processing Extension
extension String {
    func processedURL() -> String {
        if self.hasPrefix("http") {
            return self
        }

        let serverURL = UserDefaults.standard.string(forKey: "serverURL") ?? "http://localhost:5002"
        return "\(serverURL)/files/" + self
    }
}

struct Podcast: Codable, Identifiable {
    let id: String
    let title: String
    let link: String
    let publishedAt: String
    let fetchedAt: String
    let contentUrl: String
    private let _imageUrl: String
    private let _audioUrl: String
    private let _transcriptUrl: String
    let durationSeconds: Double
    
    // Computed properties that process URLs
    var imageUrl: String {
        return _imageUrl.processedURL()
    }
    
    var audioUrl: String {
        return _audioUrl.processedURL()
    }
    
    var transcriptUrl: String {
        return _transcriptUrl.processedURL()
    }
    
    enum CodingKeys: String, CodingKey {
        case id
        case title
        case link
        case publishedAt = "publishedAt"
        case fetchedAt = "fetchedAt"
        case contentUrl = "contentUrl"
        case _imageUrl = "imageUrl"
        case _audioUrl = "audioUrl"
        case _transcriptUrl = "transcriptUrl" 
        case durationSeconds = "durationSeconds"
    }
}

struct PodcastCard: Codable, Identifiable, Equatable {
    let id: String
    let title: String
    private let _imageUrl: String
    let publishedAt: String
    let durationSeconds: Double
    
    // Custom initializer for manual creation
    init(id: String, title: String, imageUrl: String, publishedAt: String = "", durationSeconds: Double) {
        self.id = id
        self.title = title
        self._imageUrl = imageUrl
        self.publishedAt = publishedAt
        self.durationSeconds = durationSeconds
    }
    
    // Computed property that processes URL
    var imageUrl: String {
        return _imageUrl.processedURL()
    }
    
    enum CodingKeys: String, CodingKey {
        case id
        case title
        case _imageUrl = "imageUrl"
        case publishedAt = "publishedAt"
        case durationSeconds = "durationSeconds"
    }
}

struct PodcastHistory: Codable, Identifiable {
    let podcastId: String
    let title: String
    private let _imageUrl: String
    let listenedAt: String
    let durationSeconds: Double
    let completed: Bool
    let listenDurationSeconds: Double
    let stopPositionSeconds: Double
    let playCount: Int
    let rate: Double
    
    var id: String { podcastId }
    
    // Computed property that processes URL
    var imageUrl: String {
        return _imageUrl.processedURL()
    }
    
    enum CodingKeys: String, CodingKey {
        case podcastId = "podcastId"
        case title
        case _imageUrl = "imageUrl"
        case listenedAt = "listenedAt"
        case durationSeconds = "durationSeconds"
        case completed
        case listenDurationSeconds = "listenDurationSeconds"
        case stopPositionSeconds = "stopPositionSeconds"
        case playCount = "playCount"
        case rate
    }
}

// MARK: - Playlist structures
struct Playlist: Codable, Identifiable {
    let playlistId: String
    let name: String
    let description: String
    let createdAt: String
    
    var id: String { playlistId }
    
    enum CodingKeys: String, CodingKey {
        case playlistId = "playlistId"
        case name
        case description
        case createdAt = "createdAt"
    }
}

struct PlaylistItem: Codable, Identifiable {
    let podcastId: String
    let title: String
    private let _imageUrl: String
    let addedAt: String
    let durationSeconds: Double
    
    var id: String { podcastId }    
    
    // Computed property that processes URL
    var imageUrl: String {
        return _imageUrl.processedURL()
    }
    
    enum CodingKeys: String, CodingKey {
        case podcastId = "id"
        case title
        case _imageUrl = "imageUrl"
        case addedAt = "addedAt"
        case durationSeconds = "durationSeconds"
    }
}

// GraphQL Response wrappers
struct GraphQLResponse<T: Codable>: Codable {
    let data: T?
    let errors: [GraphQLError]?
}

struct GraphQLError: Codable {
    let message: String
    let path: [String]?
}

// Query data structures
struct FindPodcastData: Codable {
    let findPodcast: Podcast
}

struct GenerateData: Codable {
    let generate: Podcast
}

struct HistoryData: Codable {
    let history: [PodcastHistory]
}

struct TrendingData: Codable {
    let trending: [PodcastCard]
}

struct RecommendationsData: Codable {
    let recommendations: [PodcastCard]
}

struct SearchData: Codable {
    let search: [PodcastCard]
}

struct SummaryData: Codable {
    let summary: Podcast
}

struct PlaylistsData: Codable {
    let playlists: [Playlist]
}

struct PlaylistItemsData: Codable {
    let playlist: [PlaylistItem]
}

struct MutationResult: Codable {
    let addToPlaylist: String?
    let createPlaylist: String?
    let deletePlaylist: String?
    
    enum CodingKeys: String, CodingKey {
        case addToPlaylist
        case createPlaylist
        case deletePlaylist
    }
}

struct RemoveMutationResult: Codable {
    let removeFromPlaylist: String
}

struct PlayingResult: Codable {
    let playing: String
}

// MARK: - User Action Logging Models

struct UserActionDetails: Codable {
    let from: Double?
    let to: Double?
    let playlistId: String?
    
    enum CodingKeys: String, CodingKey {
        case from = "from"
        case to
        case playlistId
    }
}

struct UserAction: Codable {
    let timestamp: Int
    let action: String
    let podcastId: String
    let details: UserActionDetails?
    
    enum CodingKeys: String, CodingKey {
        case timestamp
        case action
        case podcastId = "podcastId"
        case details
    }
}

struct PositionLog: Codable {
    let time: Int
    let position: Double
}

struct UserLog: Codable {
    let podcastId: String
    let actions: [UserAction]
    let listenedSeconds: [Int]
    let listenDurationSeconds: Double
    let totalDurationSeconds: Double
    let coveragePercentage: Double
    let lastPosition: Double
    let positionLog: [PositionLog]
    let listeningTime: Int
    let autoPlay: Bool
    
    enum CodingKeys: String, CodingKey {
        case podcastId = "podcastId"
        case actions
        case listenedSeconds = "listenedSeconds"
        case listenDurationSeconds = "listenDurationSeconds"
        case totalDurationSeconds = "totalDurationSeconds"
        case coveragePercentage = "coveragePercentage"
        case lastPosition = "lastPosition"
        case positionLog = "positionLog"
        case listeningTime = "listeningTime"
        case autoPlay = "autoPlay"
    }
}

struct MarkAsPlayedData: Codable {
    let markAsPlayed: String
    
    enum CodingKeys: String, CodingKey {
        case markAsPlayed = "mark_as_played"
    }
}

struct Transition: Codable {
    private let _imageUrl: String
    private let _audioUrl: String
    private let _transcriptUrl: String
    let secs: Double
    
    // Computed properties that process URLs
    var imageUrl: String {
        return _imageUrl.processedURL()
    }
    
    var audioUrl: String {
        return _audioUrl.processedURL()
    }
    
    var transcriptUrl: String {
        return _transcriptUrl.processedURL()
    }
    
    enum CodingKeys: String, CodingKey {
        case _imageUrl = "imageUrl"
        case _audioUrl = "audioUrl"
        case _transcriptUrl = "transcriptUrl"
        case secs
    }
}

struct TransitionData: Codable {
    let transition: Transition
} 