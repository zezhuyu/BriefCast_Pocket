//
//  DownloadsView.swift
//  BriefCast
//
//  Created by Zezhu Yu on 2025-06-09.
//

import SwiftUI

struct DownloadsView: View {
    @EnvironmentObject private var playerViewModel: PlayerViewModel
    @StateObject private var viewModel = DownloadsViewModel()
    
    var body: some View {
            Group {
                if viewModel.isLoading {
                    ProgressView("Loading downloads...")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if viewModel.downloadedPodcasts.isEmpty {
                    emptyStateView
                } else {
                    downloadsListView
                }
            }
            .navigationTitle("Downloads")
            .navigationBarTitleDisplayMode(.large)
            .refreshable {
                viewModel.loadDownloads()
            }
            .onAppear {
                viewModel.loadDownloads()
            }
    }
    
    private var emptyStateView: some View {
        VStack(spacing: 20) {
            Image(systemName: "square.and.arrow.down")
                .font(.system(size: 60))
                .foregroundColor(.gray)
            
            Text("No downloads yet")
                .font(.title2)
                .fontWeight(.semibold)
            
            Text("Download podcasts for offline listening.\nDownloaded episodes will appear here.")
                .font(.subheadline)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
            
            VStack(spacing: 12) {
                Text("Features coming soon:")
                    .font(.headline)
                    .padding(.top)
                
                VStack(alignment: .leading, spacing: 8) {
                    FeatureRow(icon: "wifi.slash", text: "Offline listening")
                    FeatureRow(icon: "icloud.and.arrow.down", text: "Smart downloads")
                    FeatureRow(icon: "gear", text: "Download quality settings")
                }
                .padding()
                .background(Color.gray.opacity(0.1))
                .cornerRadius(12)
            }
        }
        .padding()
    }
    
    private var downloadsListView: some View {
        List {
            ForEach(viewModel.downloadedPodcasts) { podcast in
                DownloadRowView(podcast: podcast) {
                    playerViewModel.loadPodcast(id: podcast.id)
                }
            }
            .onDelete(perform: viewModel.deletePodcasts)
        }
        .listStyle(PlainListStyle())
    }
}

// MARK: - Feature Row Component
struct FeatureRow: View {
    let icon: String
    let text: String
    
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .foregroundColor(Color.accentColor)
                .frame(width: 20)
            
            Text(text)
                .font(.subheadline)
            
            Spacer()
        }
    }
}

// MARK: - Download Row View Component
struct DownloadRowView: View {
    let podcast: PodcastCard
    let onTap: () -> Void
    
    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 12) {
                // Podcast artwork
                AsyncImage(url: URL(string: podcast.imageUrl)) { image in
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
                .overlay(
                    // Downloaded indicator
                    VStack {
                        Spacer()
                        HStack {
                            Spacer()
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundColor(.green)
                                .background(Color.white)
                                .clipShape(Circle())
                                .font(.caption)
                        }
                    }
                    .padding(4)
                )
                
                // Podcast info
                VStack(alignment: .leading, spacing: 4) {
                    Text(podcast.title)
                        .font(.headline)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    
                    HStack {
                        Text(formatDuration(podcast.durationSeconds))
                            .font(.caption)
                            .foregroundColor(.secondary)
                        
                        Spacer()
                        
                        Label("Offline", systemImage: "wifi.slash")
                            .font(.caption2)
                            .foregroundColor(.green)
                    }
                    
                    Text(formatDate(podcast.publishedAt))
                        .font(.caption2)
                        .foregroundColor(.secondary)
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
    
    private func formatDuration(_ seconds: Double) -> String {
        let minutes = Int(seconds) / 60
        return "\(minutes) min"
    }
    
    private func formatDate(_ dateString: String) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSSSSS'Z'"
        
        if let date = formatter.date(from: dateString) {
            let displayFormatter = DateFormatter()
            displayFormatter.dateStyle = .medium
            return displayFormatter.string(from: date)
        }
        
        return dateString
    }
}

// MARK: - Downloads View Model
class DownloadsViewModel: ObservableObject {
    @Published var downloadedPodcasts: [PodcastCard] = []
    @Published var isLoading = false
    @Published var errorMessage: String?
    
    init() {
        // For now, we'll use mock data since the backend doesn't have download functionality yet
        loadMockData()
    }
    
    func loadDownloads() {
        isLoading = true
        
        // Simulate network delay
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            self.isLoading = false
            // In a real implementation, this would fetch downloaded podcasts from local storage
        }
    }
    
    func deletePodcasts(at offsets: IndexSet) {
        downloadedPodcasts.remove(atOffsets: offsets)
        // In a real implementation, this would also delete the files from local storage
    }
    
    private func loadMockData() {
        // Mock data to show what the downloads view would look like
        // In a real implementation, this would be replaced with actual local storage data
        downloadedPodcasts = []
    }
}

#Preview {
    DownloadsView()
        .environmentObject(PlayerViewModel())
} 