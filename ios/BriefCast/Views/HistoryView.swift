//
//  HistoryView.swift
//  BriefCast
//
//  Created by Zezhu Yu on 2025-06-09.
//

import SwiftUI
import Combine

struct HistoryView: View {
    @EnvironmentObject private var playerViewModel: PlayerViewModel
    @StateObject private var viewModel = HistoryViewModel()
    @State private var hasAppeared = false
    
    var body: some View {
            Group {
                if viewModel.isLoading && viewModel.historyItems.isEmpty {
                    ProgressView("Loading history...")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if viewModel.historyItems.isEmpty {
                    emptyStateView
                } else {
                    historyListView
                }
            }
            .navigationTitle("History")
            .refreshable {
                viewModel.loadHistory()
            }
            .onAppear {
                if !hasAppeared {
                    hasAppeared = true
                    viewModel.loadHistory()
                }
            }
    }
    
    private var emptyStateView: some View {
        VStack(spacing: 20) {
            Image(systemName: "clock")
                .font(.system(size: 60))
                .foregroundColor(.gray)
            
            Text("No listening history")
                .font(.title2)
                .fontWeight(.semibold)
            
            Text("Your podcast listening history will appear here")
                .font(.subheadline)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
    }
    
    private var historyListView: some View {
        List {
            ForEach(viewModel.historyItems) { item in
                HistoryRowView(historyItem: item) {
                    playerViewModel.loadPodcast(id: item.podcastId, external: true)
                }
            }
        }
        .listStyle(PlainListStyle())
    }
}

// MARK: - History Row View Component
struct HistoryRowView: View {
    let historyItem: PodcastHistory
    let onTap: () -> Void
    
    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 12) {
                // Podcast artwork
                AsyncImage(url: URL(string: historyItem.imageUrl)) { image in
                    image
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                } placeholder: {
                    RoundedRectangle(cornerRadius: 8)
                        .fill(Color.gray.opacity(0.3))
                        .overlay(
                            Image(systemName: "music.note")
                                .foregroundColor(.gray)
                        )
                }
                .frame(width: 60, height: 60)
                .clipShape(RoundedRectangle(cornerRadius: 8))

                // Podcast info
                VStack(alignment: .leading, spacing: 4) {
                    Text(historyItem.title)
                        .font(.headline)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    
                    HStack {
                        Text(formatDate(historyItem.listenedAt))
                            .font(.caption)
                            .foregroundColor(.secondary)
                        
                        Spacer()
                        
                        if historyItem.completed {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundColor(.green)
                                .font(.caption)
                        }
                    }
                    
                    // Progress bar
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(formatTime(historyItem.stopPositionSeconds))
                                .font(.caption2)
                                .foregroundColor(.secondary)
                            
                            Spacer()
                            
                            Text(formatTime(historyItem.durationSeconds))
                                .font(.caption2)
                                .foregroundColor(.secondary)
                        }
                        
                        ProgressView(value: min(max(historyItem.stopPositionSeconds / max(historyItem.durationSeconds, 1), 0), 1))
                            .progressViewStyle(LinearProgressViewStyle(tint: .blue))
                            .frame(height: 2)
                    }
                    
                    // Additional info
                    HStack {
                        Label("\(historyItem.playCount)", systemImage: "play.circle")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                        
                        Spacer()
                        
                        Label(String(format: "%.0f%%", min(max((historyItem.listenDurationSeconds / max(historyItem.durationSeconds, 1)) * 100, 0), 100)), systemImage: "chart.bar")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }
                }
                
                Spacer()
                
                Image(systemName: "chevron.right")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            .padding(.vertical, 4)
        }
        .buttonStyle(PlainButtonStyle())
    }
    
    private func formatDate(_ dateString: String) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        
        if let date = formatter.date(from: dateString) {
            let displayFormatter = DateFormatter()
            displayFormatter.dateStyle = .medium
            displayFormatter.timeStyle = .short
            return displayFormatter.string(from: date)
        }
        
        return dateString
    }
    
    private func formatTime(_ seconds: Double) -> String {
        let minutes = Int(seconds) / 60
        let remainingSeconds = Int(seconds) % 60
        return String(format: "%02d:%02d", minutes, remainingSeconds)
    }
}

// MARK: - History View Model
class HistoryViewModel: ObservableObject {
    @Published var historyItems: [PodcastHistory] = []
    @Published var isLoading = false
    @Published var errorMessage: String?
    
    private let graphQLService = GraphQLService.shared
    private var cancellables = Set<AnyCancellable>()
    
    init() {
        // Subscribe to server URL changes
        NotificationCenter.default.publisher(for: NSNotification.Name("ServerConfigurationChanged"))
            .sink { [weak self] _ in
                self?.clearAndReload()
            }
            .store(in: &cancellables)
    }
    
    func clearAndReload() {
        // Clear existing data and cancellables
        historyItems = []
        cancellables.removeAll()
        // Reload history
        loadHistory()
    }
    
    func loadHistory() {
        isLoading = true
        errorMessage = nil
        
        graphQLService.getHistory()
            .receive(on: DispatchQueue.main)
            .sink(
                receiveCompletion: { [weak self] completion in
                    if case .failure(let error) = completion {
                        self?.isLoading = false
                        self?.errorMessage = error.localizedDescription
                    } else {
                    }
                },
                receiveValue: { [weak self] history in
                    // Directly assign the history items without sorting to match LibraryView behavior
                    self?.historyItems = history
                    self?.isLoading = false  // Set loading to false after data is assigned
                }
            )
            .store(in: &cancellables)
    }
}

#Preview {
    HistoryView()
        .environmentObject(PlayerViewModel())
} 