//
//  LibraryView.swift
//  BriefCast
//
//  Created by Zezhu Yu on 2025-06-09.
//

import SwiftUI
import Combine

struct LibraryView: View {
    @EnvironmentObject private var playerViewModel: PlayerViewModel
    @StateObject private var viewModel = LibraryViewModel()
    @State private var searchText = ""
    @FocusState private var isSearchFocused: Bool
    @State private var showingPlaylistSheet = false
    @State private var selectedPodcastForPlaylist: PodcastCard?
    @State private var showingServerSettings = false
    @AppStorage("serverURL") private var serverURL: String = ""
    @State private var hasCheckedInitialSetup = false
    
    // Summary creation state
    @State private var selectedPodcastsForSummary: Set<String> = []
    @State private var isCreatingSummary = false
    
    var body: some View {
        NavigationView {
            // Main content
            ZStack {
                ScrollView {
                    LazyVStack(spacing: 24) {
                        // Search Bar
                        HStack {
                            HStack {
                                Image(systemName: "magnifyingglass")
                                    .foregroundColor(.gray)
                                
                                TextField("Search podcasts...", text: $searchText)
                                    .focused($isSearchFocused)
                                    .textFieldStyle(PlainTextFieldStyle())
                                    .onSubmit {
                                        if !searchText.isEmpty {
                                            viewModel.search(query: searchText)
                                        }
                                    }
                                
                                if !searchText.isEmpty {
                                    Button(action: {
                                        searchText = ""
                                        viewModel.clearSearch()
                                        isSearchFocused = false
                                    }) {
                                        Image(systemName: "xmark.circle.fill")
                                            .foregroundColor(.gray)
                                    }
                                }
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(Color.gray.opacity(0.1))
                            .cornerRadius(10)
                        }
                        .padding(.horizontal)
                        
                        // Search Results Section (show when searching)
                        if viewModel.isSearching {
                            GridSectionView(
                                title: "Search Results",
                                items: viewModel.searchResults,
                                isLoading: viewModel.isLoadingSearch,
                                selectedForSummary: $selectedPodcastsForSummary
                            ) { podcast in
                                playerViewModel.loadPodcast(id: podcast.id, external: true)
                            } onAddToPlaylist: { podcast in
                                selectedPodcastForPlaylist = podcast
                                viewModel.loadPlaylists()
                                showingPlaylistSheet = true
                            }
                        } else {
                            // Default Library Content (show when not searching)
                            // Recent History Section (10 items) - NO SUMMARY SELECTION
                            SectionView(
                                title: "Recent History",
                                items: Array(viewModel.recentHistory.prefix(10)).map { history in
                                    PodcastCard(
                                        id: history.podcastId,
                                        title: history.title,
                                        imageUrl: history.imageUrl,
                                        publishedAt: history.listenedAt,
                                        durationSeconds: history.durationSeconds
                                    )
                                },
                                isLoading: viewModel.isLoadingHistory,
                                showSummarySelection: false,
                                selectedForSummary: .constant(Set<String>())
                            ) { podcast in
                                playerViewModel.loadPodcast(id: podcast.id, external: true)
                            }
                            
                            // Hot & Trending Section - WITH SUMMARY SELECTION
                            SectionView(
                                title: "Hot & Trending",
                                items: viewModel.trendingPodcasts,
                                isLoading: viewModel.isLoadingTrending,
                                showSummarySelection: true,
                                selectedForSummary: $selectedPodcastsForSummary
                            ) { podcast in
                                playerViewModel.loadPodcast(id: podcast.id, external: true)
                            } onAddToPlaylist: { podcast in
                                selectedPodcastForPlaylist = podcast
                                viewModel.loadPlaylists()
                                showingPlaylistSheet = true
                            }
                            
                            // For You Section - Using Grid Layout - WITH SUMMARY SELECTION
                            GridSectionView(
                                title: "For You",
                                items: viewModel.recommendations,
                                isLoading: viewModel.isLoadingRecommendations,
                                selectedForSummary: $selectedPodcastsForSummary
                            ) { podcast in
                                playerViewModel.loadPodcast(id: podcast.id, external: true)
                            } onAddToPlaylist: { podcast in
                                selectedPodcastForPlaylist = podcast
                                viewModel.loadPlaylists()
                                showingPlaylistSheet = true
                            }
                        }
                    }
                    .padding()
                    .padding(.bottom, selectedPodcastsForSummary.isEmpty ? 0 : 100) // Add padding for floating button
                }
                
                // Floating Action Button for Summary Creation
                if !selectedPodcastsForSummary.isEmpty {
                    VStack {
                        Spacer()
                        HStack {
                            Spacer()
                            Button(action: {
                                createSummary()
                            }) {
                                HStack {
                                    if isCreatingSummary {
                                        ProgressView()
                                            .progressViewStyle(CircularProgressViewStyle(tint: .white))
                                            .scaleEffect(0.8)
                                    } else {
                                        Image(systemName: "doc.text.magnifyingglass")
                                            .font(.title2)
                                    }
                                    Text("Create Summary (\(selectedPodcastsForSummary.count))")
                                        .fontWeight(.semibold)
                                }
                                .foregroundColor(.white)
                                .padding(.horizontal, 20)
                                .padding(.vertical, 12)
                                .background(Color.blue)
                                .cornerRadius(25)
                                .shadow(radius: 4)
                            }
                            .disabled(isCreatingSummary)
                            Spacer()
                        }
                        .padding(.bottom, 30)
                    }
                }
            }
            .navigationTitle("Library")
            .navigationBarItems(trailing: Button(action: {
                showingServerSettings = true
            }) {
                Image(systemName: "gear")
            })
            .refreshable {
                viewModel.refreshAll()
            }
            .onAppear {
                if !hasCheckedInitialSetup {
                    hasCheckedInitialSetup = true
                    if serverURL.isEmpty {
                        showingServerSettings = true
                    }
                }
                viewModel.loadInitialData()
            }
            .sheet(isPresented: $showingPlaylistSheet) {
                PlaylistSelectionView(
                    podcast: selectedPodcastForPlaylist,
                    playlists: viewModel.playlists,
                    isLoading: viewModel.isLoadingPlaylists,
                    onAddToPlaylist: { playlistId, podcastId in
                        viewModel.addToPlaylist(playlistId: playlistId, podcastId: podcastId)
                    },
                    onCreatePlaylist: { name, description in
                        viewModel.createPlaylist(name: name, description: description)
                    }
                )
            }
            .sheet(isPresented: $showingServerSettings) {
                NavigationView {
                    ServerSettingsView(
                        isInitialSetup: serverURL.isEmpty,
                        onServerUpdated: {
                            // Clear any existing data
                            viewModel.clearAllForServerChange()
                            // Reload all data with new server configuration
                            viewModel.loadInitialData()
                        }
                    )
                }
                .navigationViewStyle(StackNavigationViewStyle())
            }
        }
        .navigationViewStyle(StackNavigationViewStyle())
    }
    
    private func createSummary() {
        guard !selectedPodcastsForSummary.isEmpty else { return }
        
        isCreatingSummary = true
        let podcastIds = Array(selectedPodcastsForSummary)
        
        viewModel.createSummary(podcastIds: podcastIds) { summaryId in
            DispatchQueue.main.async {
                isCreatingSummary = false
                selectedPodcastsForSummary.removeAll()
                // Only navigate to player if we got a valid summary ID
                if !summaryId.isEmpty {
                    playerViewModel.loadPodcast(id: summaryId, external: true)
                }
            }
        }
    }
}

// MARK: - Section View Component (Horizontal Scroll)
struct SectionView: View {
    let title: String
    let items: [PodcastCard]
    let isLoading: Bool
    let showSummarySelection: Bool
    let selectedForSummary: Binding<Set<String>>
    let onTap: (PodcastCard) -> Void
    let onAddToPlaylist: ((PodcastCard) -> Void)?
    
    init(title: String, items: [PodcastCard], isLoading: Bool, showSummarySelection: Bool, selectedForSummary: Binding<Set<String>>, onTap: @escaping (PodcastCard) -> Void, onAddToPlaylist: ((PodcastCard) -> Void)? = nil) {
        self.title = title
        self.items = items
        self.isLoading = isLoading
        self.showSummarySelection = showSummarySelection
        self.selectedForSummary = selectedForSummary
        self.onTap = onTap
        self.onAddToPlaylist = onAddToPlaylist
    }
    
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(title)
                    .font(.title2)
                    .fontWeight(.bold)
                
                Spacer()
                
                if isLoading {
                    ProgressView()
                        .scaleEffect(0.8)
                }
            }
            
            if items.isEmpty && !isLoading {
                EmptySection(title: title)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(spacing: 16) {
                        ForEach(items) { item in
                            PodcastCardView(podcast: item, showAddToPlaylist: onAddToPlaylist != nil, showSummarySelection: showSummarySelection, selectedForSummary: selectedForSummary) {
                                onTap(item)
                            } onAddToPlaylist: {
                                onAddToPlaylist?(item)
                            }
                        }
                    }
                    .padding(.horizontal)
                }
            }
        }
    }
}

// MARK: - Grid Section View Component (Responsive Grid)
struct GridSectionView: View {
    let title: String
    let items: [PodcastCard]
    let isLoading: Bool
    let selectedForSummary: Binding<Set<String>>
    let onTap: (PodcastCard) -> Void
    let onAddToPlaylist: (PodcastCard) -> Void
    
    // Adaptive grid layout that adjusts based on screen size
    private var gridColumns: [GridItem] {
        [
            GridItem(.adaptive(minimum: 200, maximum: 300), spacing: 24)
        ]
    }
    
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text(title)
                    .font(.title2)
                    .fontWeight(.bold)
                
                Spacer()
                
                if isLoading {
                    ProgressView()
                        .scaleEffect(0.8)
                }
            }
            
            if items.isEmpty && !isLoading {
                EmptySection(title: title)
            } else {
                LazyVGrid(columns: gridColumns, spacing: 24) {
                    ForEach(items) { item in
                        GridPodcastCardView(podcast: item, selectedForSummary: selectedForSummary) {
                            onTap(item)
                        } onAddToPlaylist: {
                            onAddToPlaylist(item)
                        }
                    }
                }
            }
        }
    }
}

// MARK: - Podcast Card View Component (Horizontal Layout)
struct PodcastCardView: View {
    let podcast: PodcastCard
    let showAddToPlaylist: Bool
    let showSummarySelection: Bool
    let selectedForSummary: Binding<Set<String>>
    let onTap: () -> Void
    let onAddToPlaylist: () -> Void
    
    init(podcast: PodcastCard, showAddToPlaylist: Bool = true, showSummarySelection: Bool = false, selectedForSummary: Binding<Set<String>> = .constant(Set<String>()), onTap: @escaping () -> Void, onAddToPlaylist: @escaping () -> Void) {
        self.podcast = podcast
        self.showAddToPlaylist = showAddToPlaylist
        self.showSummarySelection = showSummarySelection
        self.selectedForSummary = selectedForSummary
        self.onTap = onTap
        self.onAddToPlaylist = onAddToPlaylist
    }
    
    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 8) {
                // Podcast artwork with buttons
                ZStack {
                    AsyncImage(url: URL(string: podcast.imageUrl)) { image in
                        image
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                    } placeholder: {
                        RoundedRectangle(cornerRadius: 12)
                            .fill(Color.gray.opacity(0.3))
                            .overlay(
                                Image(systemName: "music.note")
                                    .foregroundColor(.gray)
                            )
                    }
                    .frame(width: 140, height: 140)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    
                    // Top left summary button
                    if showSummarySelection {
                        VStack {
                            HStack {
                                Button(action: toggleSummarySelection) {
                                    ZStack {
                                        Circle()
                                            .fill(Color.black.opacity(0.6))
                                            .frame(width: 28, height: 28) // Adjust size to fit background circle
                                        Image(systemName: "doc.text.magnifyingglass")
                                            .foregroundColor(selectedForSummary.wrappedValue.contains(podcast.id) ? .blue : .white)
                                            .font(.system(size: 14))
                                    }
                                }
                                .buttonStyle(PlainButtonStyle())
                                .padding(8)
                                Spacer()
                            }
                            Spacer()
                        }
                    }
                    
                    // Top right add to playlist button
                    if showAddToPlaylist {
                        VStack {
                            HStack {
                                Spacer()
                                Button(action: onAddToPlaylist) {
                                    ZStack {
                                        Circle()
                                            .fill(Color.black.opacity(0.6))
                                            .frame(width: 28, height: 28) // Adjust size to fit background circle
                                        Image(systemName: "text.badge.plus")
                                            .foregroundColor(.white)
                                            .font(.system(size: 14))
                                    }
                                }
                                .buttonStyle(PlainButtonStyle())
                                .padding(8)
                            }
                            Spacer()
                        }
                    }
                }
                
                // Podcast info
                VStack(alignment: .leading, spacing: 4) {
                    Text(podcast.title)
                        .font(.subheadline)
                        .fontWeight(.medium)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    
                    Text(formatDuration(podcast.durationSeconds))
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                .frame(width: 140, alignment: .leading)
            }
        }
        .buttonStyle(PlainButtonStyle())
    }
    
    private func toggleSummarySelection() {
        if selectedForSummary.wrappedValue.contains(podcast.id) {
            selectedForSummary.wrappedValue.remove(podcast.id)
        } else if selectedForSummary.wrappedValue.count < 10 {
            selectedForSummary.wrappedValue.insert(podcast.id)
        }
    }
    
    private func formatDuration(_ seconds: Double) -> String {
        let minutes = Int(seconds) / 60
        return "\(minutes) min"
    }
}

// MARK: - Grid Podcast Card View Component (Grid Layout)
struct GridPodcastCardView: View {
    let podcast: PodcastCard
    let selectedForSummary: Binding<Set<String>>
    let onTap: () -> Void
    let onAddToPlaylist: () -> Void
    
    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 12) {
                // Podcast artwork with buttons - responsive size
                GeometryReader { geometry in
                    ZStack {
                        AsyncImage(url: URL(string: podcast.imageUrl)) { image in
                            image
                                .resizable()
                                .aspectRatio(contentMode: .fill)
                                .frame(width: geometry.size.width, height: geometry.size.width)
                                .clipped()
                        } placeholder: {
                            Rectangle()
                                .fill(Color.gray.opacity(0.3))
                                .frame(width: geometry.size.width, height: geometry.size.width)
                                .overlay(
                                    Image(systemName: "music.note")
                                        .foregroundColor(.gray)
                                )
                        }
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                        
                        // Top left summary button
                        VStack {
                            HStack {
                                Button(action: toggleSummarySelection) {
                                    ZStack {
                                        Circle()
                                            .fill(Color.black.opacity(0.6))
                                            .frame(width: 36, height: 36)
                                        Image(systemName: "doc.text.magnifyingglass")
                                            .foregroundColor(selectedForSummary.wrappedValue.contains(podcast.id) ? .blue : .white)
                                            .font(.system(size: 16))
                                    }
                                }
                                .buttonStyle(PlainButtonStyle())
                                .padding(12)
                                
                                Spacer()
                                
                                // Top right add to playlist button
                                Button(action: onAddToPlaylist) {
                                    ZStack {
                                        Circle()
                                            .fill(Color.black.opacity(0.6))
                                            .frame(width: 36, height: 36)
                                        Image(systemName: "text.badge.plus")
                                            .foregroundColor(.white)
                                            .font(.system(size: 16))
                                    }
                                }
                                .buttonStyle(PlainButtonStyle())
                                .padding(12)
                            }
                            Spacer()
                        }
                    }
                }
                .aspectRatio(1, contentMode: .fit) // Make the artwork square
                
                // Podcast info
                VStack(alignment: .leading, spacing: 6) {
                    Text(podcast.title)
                        .font(.headline)
                        .fontWeight(.medium)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    
                    Text(formatDuration(podcast.durationSeconds))
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .frame(height: 60)
            }
        }
        .buttonStyle(PlainButtonStyle())
    }
    
    private func toggleSummarySelection() {
        if selectedForSummary.wrappedValue.contains(podcast.id) {
            selectedForSummary.wrappedValue.remove(podcast.id)
        } else if selectedForSummary.wrappedValue.count < 10 {
            selectedForSummary.wrappedValue.insert(podcast.id)
        }
    }
    
    private func formatDuration(_ seconds: Double) -> String {
        let minutes = Int(seconds) / 60
        return "\(minutes) min"
    }
}

// MARK: - Playlist Selection View
struct PlaylistSelectionView: View {
    let podcast: PodcastCard?
    let playlists: [Playlist]
    let isLoading: Bool
    let onAddToPlaylist: (String, String) -> Void
    let onCreatePlaylist: (String, String?) -> Void
    
    @Environment(\.dismiss) private var dismiss
    @State private var showingCreatePlaylist = false
    @State private var newPlaylistName = ""
    @State private var newPlaylistDescription = ""
    
    var body: some View {
            VStack {
                if let podcast = podcast {
                    // Podcast info header
                    HStack {
                        AsyncImage(url: URL(string: podcast.imageUrl)) { image in
                            image
                                .resizable()
                                .aspectRatio(contentMode: .fill)
                        } placeholder: {
                            RoundedRectangle(cornerRadius: 8)
                                .fill(Color.gray.opacity(0.3))
                        }
                        .frame(width: 60, height: 60)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        
                        VStack(alignment: .leading) {
                            Text(podcast.title)
                                .font(.headline)
                                .lineLimit(2)
                            Text("Select a playlist")
                                .font(.subheadline)
                                .foregroundColor(.secondary)
                        }
                        
                        Spacer()
                    }
                    .padding()
                    
                    Divider()
                    
                    // Playlists list
                    if isLoading {
                        VStack {
                            ProgressView()
                            Text("Loading playlists...")
                                .font(.subheadline)
                                .foregroundColor(.secondary)
                                .padding(.top, 8)
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else if playlists.isEmpty {
                        VStack(spacing: 16) {
                            Image(systemName: "music.note.list")
                                .font(.system(size: 50))
                                .foregroundColor(.gray)
                            Text("No playlists found")
                                .font(.headline)
                                .foregroundColor(.secondary)
                            Text("Create your first playlist to get started")
                                .font(.subheadline)
                                .foregroundColor(.secondary)
                                .multilineTextAlignment(.center)
                            
                            Button(action: {
                                showingCreatePlaylist = true
                            }) {
                                Text("Create Playlist")
                                    .foregroundColor(.white)
                                    .padding(.horizontal, 24)
                                    .padding(.vertical, 12)
                                    .background(Color.blue)
                                    .cornerRadius(8)
                            }
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .padding()
                    } else {
                        List {
                            // Create new playlist option
                            Button(action: {
                                showingCreatePlaylist = true
                            }) {
                                HStack {
                                    Image(systemName: "text.badge.plus")
                                        .foregroundColor(.blue)
                                    Text("Create New Playlist")
                                        .foregroundColor(.blue)
                                }
                            }
                            
                            // Existing playlists
                            ForEach(playlists) { playlist in
                                Button(action: {
                                    onAddToPlaylist(playlist.playlistId, podcast.id)
                                    dismiss()
                                }) {
                                    HStack {
                                        Image(systemName: "music.note.list")
                                            .foregroundColor(.gray)
                                        
                                        VStack(alignment: .leading) {
                                            Text(playlist.name)
                                                .foregroundColor(.primary)
                                            if !playlist.description.isEmpty {
                                                Text(playlist.description)
                                                    .font(.caption)
                                                    .foregroundColor(.secondary)
                                            }
                                        }
                                        
                                        Spacer()
                                        
                                        Image(systemName: "chevron.right")
                                            .foregroundColor(.gray)
                                            .font(.caption)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Add to Playlist")
            .navigationBarTitleDisplayMode(.inline)
            .navigationBarItems(
                trailing: Button("Cancel") {
                    dismiss()
                }
            )
            .sheet(isPresented: $showingCreatePlaylist) {
                    VStack {
                        Form {
                            Section("Playlist Details") {
                                TextField("Playlist Name", text: $newPlaylistName)
                                TextField("Description (Optional)", text: $newPlaylistDescription)
                            }
                        }
                    }
                    .navigationTitle("New Playlist")
                    .navigationBarTitleDisplayMode(.inline)
                    .navigationBarItems(
                        leading: Button("Cancel") {
                            showingCreatePlaylist = false
                            newPlaylistName = ""
                            newPlaylistDescription = ""
                        },
                        trailing: Button("Create") {
                            if !newPlaylistName.isEmpty {
                                onCreatePlaylist(newPlaylistName, newPlaylistDescription.isEmpty ? nil : newPlaylistDescription)
                                showingCreatePlaylist = false
                                newPlaylistName = ""
                                newPlaylistDescription = ""
                                dismiss()
                            }
                        }
                        .disabled(newPlaylistName.isEmpty)
                    )
            }
    }
}

// MARK: - Empty Section Component
struct EmptySection: View {
    let title: String
    
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "music.note.list")
                .font(.system(size: 40))
                .foregroundColor(.gray)
            
            Text("No \(title.lowercased()) available")
                .font(.subheadline)
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
    }
}

// MARK: - Server Settings View
struct ServerSettingsView: View {
    @AppStorage("serverURL") private var serverURL: String = "http://localhost:5002"
    @AppStorage("authToken") private var authToken: String = ""
    @State private var isEditing = false
    @State private var tempServerURL: String = ""
    @State private var tempAuthToken: String = ""
    @State private var showingAlert = false
    @State private var alertMessage = ""
    @Environment(\.presentationMode) var presentationMode
    let isInitialSetup: Bool
    let onServerUpdated: () -> Void
    
    var body: some View {
        List {
            Section(header: Text("Server Configuration")) {
                VStack(alignment: .leading, spacing: 12) {
                    if isEditing || isInitialSetup {
                        TextField("Server URL", text: $tempServerURL)
                            .textFieldStyle(RoundedBorderTextFieldStyle())
                            .autocapitalization(.none)
                            .disableAutocorrection(true)
                        
                        SecureField("Auth Token (Required)", text: $tempAuthToken)
                            .textFieldStyle(RoundedBorderTextFieldStyle())
                            .autocapitalization(.none)
                            .disableAutocorrection(true)
                        
                        HStack {
                            if !isInitialSetup {
                                Button("Cancel") {
                                    isEditing = false
                                    tempServerURL = serverURL
                                    tempAuthToken = authToken
                                }
                                .buttonStyle(.bordered)
                            }
                            
                            Spacer()
                            
                            Button(isInitialSetup ? "Continue" : "Save") {
                                if isValidURL(tempServerURL) {
                                    serverURL = tempServerURL
                                    authToken = tempAuthToken
                                    isEditing = false
                                    // Update GraphQLService with new configuration
                                    GraphQLService.shared.updateConfiguration(serverURL: serverURL, authToken: authToken)
                                    // Post notification for server configuration change
                                    NotificationCenter.default.post(name: NSNotification.Name("ServerConfigurationChanged"), object: nil)
                                    // Trigger refresh
                                    onServerUpdated()
                                    presentationMode.wrappedValue.dismiss()
                                } else {
                                    alertMessage = "Please enter a valid URL"
                                    showingAlert = true
                                }
                            }
                            .buttonStyle(.borderedProminent)
                        }
                    } else {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Server URL")
                                .font(.caption)
                                .foregroundColor(.secondary)
                            Text(serverURL)
                                .font(.body)
                            
                            if !authToken.isEmpty {
                                Text("Auth Token")
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                                    .padding(.top, 4)
                                Text("••••••••")
                                    .font(.body)
                            }
                        }
                        
                        Button("Edit Configuration") {
                            tempServerURL = serverURL
                            tempAuthToken = authToken
                            isEditing = true
                        }
                        .buttonStyle(.bordered)
                        .padding(.top, 8)
                    }
                }
                .padding(.vertical, 8)
            }
            
            if !isInitialSetup {
                Section(header: Text("About")) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("BriefCast")
                            .font(.headline)
                        Text("Version 1.0.0")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                    }
                    .padding(.vertical, 8)
                }
            }
        }
        .navigationTitle(isInitialSetup ? "Welcome to BriefCast" : "Server Settings")
        .navigationBarItems(trailing: isInitialSetup ? nil : Button("Done") {
            presentationMode.wrappedValue.dismiss()
        })
        .alert("Invalid URL", isPresented: $showingAlert) {
            Button("OK", role: .cancel) { }
        } message: {
            Text(alertMessage)
        }
        .onAppear {
            if isInitialSetup {
                tempServerURL = serverURL
                tempAuthToken = authToken
            }
        }
    }
    
    private func isValidURL(_ string: String) -> Bool {
        guard let url = URL(string: string) else { return false }
        return url.scheme?.starts(with: "http") == true
    }
}

// MARK: - Library View Model
class LibraryViewModel: ObservableObject {
    @Published var trendingPodcasts: [PodcastCard] = []
    @Published var recentHistory: [PodcastHistory] = []
    @Published var recommendations: [PodcastCard] = []
    @Published var searchResults: [PodcastCard] = []
    @Published var playlists: [Playlist] = []
    
    @Published var isLoadingTrending = false
    @Published var isLoadingHistory = false
    @Published var isLoadingRecommendations = false
    @Published var isLoadingSearch = false
    @Published var isLoadingPlaylists = false
    @Published var isSearching = false
    
    private let graphQLService = GraphQLService.shared
    private var cancellables = Set<AnyCancellable>()
    
    func loadInitialData() {
        loadTrending()
        loadHistory()
        loadRecommendations()
    }
    
    func refreshAll() {
        loadTrending()
        loadHistory()
        loadRecommendations()
        loadPlaylists()
    }
    
    func clearAll() {
        trendingPodcasts = []
        recentHistory = []
        recommendations = []
        searchResults = []
        playlists = []
        
        isLoadingTrending = false
        isLoadingHistory = false
        isLoadingRecommendations = false
        isLoadingSearch = false
        isLoadingPlaylists = false
        isSearching = false
        
        // Only cancel publishers when we're actually changing servers
        // Don't cancel during normal refresh operations
    }
    
    func clearAllForServerChange() {
        // Cancel existing requests when server changes
        cancellables.removeAll()
        
        // Clear all data
        clearAll()
    }
    
    private func loadTrending() {
        isLoadingTrending = true
        
        graphQLService.getTrending()
            .receive(on: DispatchQueue.main)
            .sink(
                receiveCompletion: { [weak self] completion in
                    self?.isLoadingTrending = false
                    if case .failure(let error) = completion {
                        if let graphQLError = error as? GraphQLServiceError {
                        }
                        self?.trendingPodcasts = []
                    } else {
                    }
                },
                receiveValue: { [weak self] podcasts in
                    if podcasts.isEmpty {
                    } else {
                    }
                    self?.trendingPodcasts = podcasts
                    self?.isLoadingTrending = false
                }
            )
            .store(in: &cancellables)
    }
    
    private func loadHistory() {
        isLoadingHistory = true
        
        // Don't cancel existing requests - let them run concurrently
        
        graphQLService.getHistory()
            .receive(on: DispatchQueue.main)
            .sink(
                receiveCompletion: { [weak self] completion in
                    self?.isLoadingHistory = false
                    if case .failure(let error) = completion {
                    }
                },
                receiveValue: { [weak self] history in
                    self?.recentHistory = history
                }
            )
            .store(in: &cancellables)
    }
    
    private func loadRecommendations() {
        isLoadingRecommendations = true
        
        graphQLService.getRecommendations()
            .receive(on: DispatchQueue.main)
            .sink(
                receiveCompletion: { [weak self] completion in
                    self?.isLoadingRecommendations = false
                    if case .failure(_) = completion {
                    }
                },
                receiveValue: { [weak self] recommendations in
                    self?.recommendations = recommendations
                }
            )
            .store(in: &cancellables)
    }
    
    func loadPlaylists() {
        isLoadingPlaylists = true
        
        graphQLService.getPlaylists()
            .receive(on: DispatchQueue.main)
            .sink(
                receiveCompletion: { [weak self] completion in
                    self?.isLoadingPlaylists = false
                    if case .failure(_) = completion {
                        // Handle error if needed
                    }
                },
                receiveValue: { [weak self] playlists in
                    self?.playlists = playlists
                    // Update shared cache for fast Add-to-Playlist sheets
                    PlaylistViewModel.cachedPlaylists = playlists
                }
            )
            .store(in: &cancellables)
    }
    
    func search(query: String) {
        isSearching = true
        isLoadingSearch = true
        
        graphQLService.search(query: query)
            .receive(on: DispatchQueue.main)
            .sink(
                receiveCompletion: { [weak self] completion in
                    self?.isLoadingSearch = false
                    if case .failure(_) = completion {
                        // Handle error if needed
                    }
                },
                receiveValue: { [weak self] results in
                    self?.searchResults = results
                    self?.isLoadingSearch = false
                }
            )
            .store(in: &cancellables)
    }
    
    func addToPlaylist(playlistId: String, podcastId: String) {
        graphQLService.addToPlaylist(playlistId: playlistId, podcastId: podcastId)
            .receive(on: DispatchQueue.main)
            .sink(
                receiveCompletion: { completion in
                    if case .failure(let error) = completion {
                        // Handle error if needed
                    }
                },
                receiveValue: { message in
                    // Handle success if needed
                }
            )
            .store(in: &cancellables)
    }
    
    func createPlaylist(name: String, description: String?) {
        graphQLService.createPlaylist(name: name, description: description)
            .receive(on: DispatchQueue.main)
            .sink(
                receiveCompletion: { [weak self] completion in
                    if case .failure(let error) = completion {
                        // Handle error if needed
                    } else {
                        // Reload playlists after creating a new one
                        self?.loadPlaylists()
                    }
                },
                receiveValue: { message in
                    // Handle success if needed
                }
            )
            .store(in: &cancellables)
    }
    
    func createSummary(podcastIds: [String], completion: @escaping (String) -> Void) {
        graphQLService.createSummary(podcastIds: podcastIds)
            .receive(on: DispatchQueue.main)
            .sink(
                receiveCompletion: { completion in
                    if case .failure(let error) = completion {
                        // Handle error if needed
                    }
                },
                receiveValue: { summaryPodcast in
                    completion(summaryPodcast.id)
                }
            )
            .store(in: &cancellables)
    }
    
    func clearSearch() {
        isSearching = false
        searchResults = []
    }
}

#Preview {
    LibraryView()
        .environmentObject(PlayerViewModel())
} 
