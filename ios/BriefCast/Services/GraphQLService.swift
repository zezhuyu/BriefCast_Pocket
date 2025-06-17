//
//  GraphQLService.swift
//  BriefCast
//
//  Created by Zezhu Yu on 2025-06-09.
//

import Foundation
import Combine
import SwiftUI

class GraphQLService: ObservableObject {
    static let shared = GraphQLService()
    
    @AppStorage("serverURL") private var serverURL: String = "http://localhost:5002"
    @AppStorage("authToken") private var authToken: String = ""
    private let session = URLSession.shared
    
    // Add public getter for serverURL
    var currentServerURL: String {
        return serverURL
    }
    
    private init() {}
    
    func updateConfiguration(serverURL: String, authToken: String) {
        // Ensure the server URL has the correct format
        var formattedURL = serverURL
        if !formattedURL.hasPrefix("http://") && !formattedURL.hasPrefix("https://") {
            formattedURL = "http://" + formattedURL
        }
        self.serverURL = formattedURL
        self.authToken = authToken
    }
    
    // MARK: - Generic GraphQL Request
    private func graphQLRequest<T: Codable>(
        query: String,
        variables: [String: Any]? = nil,
        responseType: T.Type
    ) -> AnyPublisher<T, Error> {
        
        let url = URL(string: "\(serverURL)/graphql")!
        
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 30 // Add 30 second timeout
        
        // Add authorization header if token exists
        if !authToken.isEmpty {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }
        
        let body: [String: Any] = [
            "query": query,
            "variables": variables ?? [:]
        ]
        
        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        } catch {
            return Fail(error: error).eraseToAnyPublisher()
        }
        
        return session.dataTaskPublisher(for: request)
            .tryMap { data, response -> Data in
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw GraphQLServiceError.networkError(NSError(domain: "", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid response type"]))
                }
                
                if !(200...299).contains(httpResponse.statusCode) {
                    if let errorString = String(data: data, encoding: .utf8) {
                    }
                    throw GraphQLServiceError.networkError(NSError(domain: "", code: httpResponse.statusCode, userInfo: [NSLocalizedDescriptionKey: "HTTP Error: \(httpResponse.statusCode)"]))
                }
                
                return data
            }
            .handleEvents(receiveSubscription: { _ in
            }, receiveOutput: { data in
                if let responseString = String(data: data, encoding: .utf8) {
                } else {
                }
            }, receiveCompletion: { completion in
                if case .failure(let error) = completion {
                } else {
                }
            })
            .decode(type: GraphQLResponse<T>.self, decoder: JSONDecoder())
            .tryMap { response in
                if let errors = response.errors, !errors.isEmpty {
                    throw GraphQLServiceError.graphQLError(errors.first?.message ?? "Unknown GraphQL error")
                }
                guard let data = response.data else {
                    throw GraphQLServiceError.noData
                }
                return data
            }
            .eraseToAnyPublisher()
    }
    
    // MARK: - Podcast Queries
    
    func findPodcast(id: String) -> AnyPublisher<Podcast, Error> {
        let query = """
        query FindPodcast($id: String!) {
            findPodcast(id: $id) {
                id
                title
                link
                publishedAt
                fetchedAt
                contentUrl
                imageUrl
                audioUrl
                transcriptUrl
                durationSeconds
            }
        }
        """
        
        return graphQLRequest(
            query: query,
            variables: ["id": id],
            responseType: FindPodcastData.self
        )
        .map(\.findPodcast)
        .eraseToAnyPublisher()
    }
    
    func generatePodcast(location: [Double]? = nil, force: Bool = false, summary: Bool = false) -> AnyPublisher<Podcast, Error> {
        let query = """
        query Generate($location: String, $force: Boolean, $summary: Boolean) {
            generate(location: $location, force: $force, summary: $summary) {
                id
                title
                link
                publishedAt
                fetchedAt
                contentUrl
                imageUrl
                audioUrl
                transcriptUrl
                durationSeconds
            }
        }
        """
        
        var variables: [String: Any] = [
            "force": force,
            "summary": summary
        ]
        
        if let location = location {
            variables["location"] = "\(location[0]),\(location[1])"
        }
        
        return graphQLRequest(
            query: query,
            variables: variables,
            responseType: GenerateData.self
        )
        .map(\.generate)
        .eraseToAnyPublisher()
    }
    
    func getHistory() -> AnyPublisher<[PodcastHistory], Error> {
        let query = """
        query History {
            history {
                podcastId
                title
                imageUrl
                listenedAt
                durationSeconds
                completed
                listenDurationSeconds
                stopPositionSeconds
                playCount
                rate
            }
        }
        """
        
        return graphQLRequest(
            query: query,
            responseType: HistoryData.self
        )
        .map(\.history)
        .eraseToAnyPublisher()
    }
    
    func getTrending() -> AnyPublisher<[PodcastCard], Error> {
        let query = """
        query Trending {
            trending {
                id
                title
                imageUrl
                publishedAt
                durationSeconds
            }
        }
        """
        return graphQLRequest(
            query: query,
            responseType: TrendingData.self
        )
        .map(\.trending)
        .eraseToAnyPublisher()
    }
    
    func getRecommendations(podcastId: String? = nil) -> AnyPublisher<[PodcastCard], Error> {
        let query = """
        query Recommendations($podcastId: String) {
            recommendations(podcastId: $podcastId) {
                id
                title
                imageUrl
                publishedAt
                durationSeconds
            }
        }
        """
        
        var variables: [String: Any] = [:]
        if let podcastId = podcastId {
            variables["podcastId"] = podcastId
        }
        
        return graphQLRequest(
            query: query,
            variables: variables,
            responseType: RecommendationsData.self
        )
        .map(\.recommendations)
        .eraseToAnyPublisher()
    }
    
    func search(query: String) -> AnyPublisher<[PodcastCard], Error> {
        let searchQuery = """
        query Search($query: String!) {
            search(query: $query) {
                id
                title
                imageUrl
                publishedAt
                durationSeconds
            }
        }
        """
        
        return graphQLRequest(
            query: searchQuery,
            variables: ["query": query],
            responseType: SearchData.self
        )
        .map(\.search)
        .eraseToAnyPublisher()
    }
    
    // MARK: - Playlist Queries
    
    func getPlaylists() -> AnyPublisher<[Playlist], Error> {
        let query = """
        query Playlists {
            playlists {
                playlistId
                name
                description
                createdAt
            }
        }
        """
        
        return graphQLRequest(
            query: query,
            responseType: PlaylistsData.self
        )
        .map(\.playlists)
        .eraseToAnyPublisher()
    }
    
    func getPlaylistItems(playlistId: String) -> AnyPublisher<[PlaylistItem], Error> {
        let query = """
        query PlaylistItems($playlistId: String!) {
            playlist(playlistId: $playlistId) {
                id
                title
                imageUrl
                addedAt
                durationSeconds
            }
        }
        """
        
        return graphQLRequest(
            query: query,
            variables: ["playlistId": playlistId],
            responseType: PlaylistItemsData.self
        )
        .map(\.playlist)
        .eraseToAnyPublisher()
    }
    
    // MARK: - Playlist Mutations
    
    func addToPlaylist(playlistId: String, podcastId: String) -> AnyPublisher<String, Error> {
        let mutation = """
        mutation AddToPlaylist($playlistId: String!, $podcastId: String!) {
            addToPlaylist(playlistId: $playlistId, podcastId: $podcastId)
        }
        """
        
        return graphQLRequest(
            query: mutation,
            variables: ["playlistId": playlistId, "podcastId": podcastId],
            responseType: MutationResult.self
        )
        .map { $0.addToPlaylist ?? "Added to playlist" }
        .eraseToAnyPublisher()
    }
    
    func removeFromPlaylist(playlistId: String, podcastId: String) -> AnyPublisher<String, Error> {
        let mutation = """
        mutation removeFromPlaylist($playlistId: String!, $podcastId: String!) {
            removeFromPlaylist(playlistId: $playlistId, podcastId: $podcastId)
        }
        """
        
        return graphQLRequest(
            query: mutation,
            variables: ["playlistId": playlistId, "podcastId": podcastId],
            responseType: RemoveMutationResult.self
        )
        .map(\.removeFromPlaylist)
        .eraseToAnyPublisher()
    }
    
    func createPlaylist(name: String, description: String?) -> AnyPublisher<String, Error> {
        let mutation = """
        mutation CreatePlaylist($name: String!, $description: String!) {
            newPlaylist(name: $name, description: $description)
        }
        """
        
        var variables: [String: Any] = ["name": name]
        variables["description"] = description ?? ""
        
        return graphQLRequest(
            query: mutation,
            variables: variables,
            responseType: MutationResult.self
        )
        .map { $0.createPlaylist ?? "Playlist created" }
        .eraseToAnyPublisher()
    }
    
    func deletePlaylist(playlistId: String) -> AnyPublisher<String, Error> {
        let mutation = """
        mutation DeletePlaylist($playlistId: String!) {
            removePlaylist(playlistId: $playlistId)
        }
        """
        
        return graphQLRequest(
            query: mutation,
            variables: ["playlistId": playlistId],
            responseType: MutationResult.self
        )
        .map { $0.deletePlaylist ?? "Playlist deleted" }
        .eraseToAnyPublisher()
    }
    
    // MARK: - Position Logging
    
    func createSummary(podcastIds: [String]) -> AnyPublisher<Podcast, Error> {
        let query = """
        query Summary($pids: [String!]!) {
            summary(pids: $pids) {
                id
                title
                link
                publishedAt
                fetchedAt
                contentUrl
                imageUrl
                audioUrl
                transcriptUrl
                durationSeconds
            }
        }
        """
        
        return graphQLRequest(
            query: query,
            variables: ["pids": podcastIds],
            responseType: SummaryData.self
        )
        .map(\.summary)
        .eraseToAnyPublisher()
    }
    
    func logPlayingPosition(podcastId: String, position: Int) -> AnyPublisher<String, Error> {
        let mutation = """
        mutation Playing($podcastId: String!, $position: Int!) {
            playing(podcastId: $podcastId, position: $position)
        }
        """
        
        return graphQLRequest(
            query: mutation,
            variables: ["podcastId": podcastId, "position": position],
            responseType: PlayingResult.self
        )
        .map(\.playing)
        .eraseToAnyPublisher()
    }
    
    func markAsPlayed(userLog: UserLog) -> AnyPublisher<String, Error> {
        let mutation = """
        mutation MarkAsPlayed($actions: UserLogInput!) {
            markAsPlayed(actions: $actions)
        }
        """
        
        // Convert UserLog to dictionary for GraphQL variables
        let encoder = JSONEncoder()
        
        do {
            let data = try encoder.encode(userLog)
            let json = try JSONSerialization.jsonObject(with: data, options: [])
            
            return graphQLRequest(
                query: mutation,
                variables: ["actions": json],
                responseType: MarkAsPlayedData.self
            )
            .map(\.markAsPlayed)
            .eraseToAnyPublisher()
        } catch {
            return Fail(error: error).eraseToAnyPublisher()
        }
    }
    
    // MARK: - Transition Audio
    
    func getTransition(from: String, to: String) -> AnyPublisher<Transition, Error> {
        let query = """
        query Transition($id1: String!, $id2: String!) {
            transition(id1: $id1, id2: $id2) {
                imageUrl
                audioUrl
                transcriptUrl
                secs
            }
        }
        """
        
        return graphQLRequest(
            query: query,
            variables: ["id1": from, "id2": to],
            responseType: TransitionData.self
        )
        .map(\.transition)
        .eraseToAnyPublisher()
    }
}

// MARK: - Error Types
enum GraphQLServiceError: LocalizedError {
    case graphQLError(String)
    case noData
    case networkError(Error)
    
    var errorDescription: String? {
        switch self {
        case .graphQLError(let message):
            return "GraphQL Error: \(message)"
        case .noData:
            return "No data received"
        case .networkError(let error):
            return "Network Error: \(error.localizedDescription)"
        }
    }
} 