import SwiftUI

struct LyricsView: View {
    let lyricsUrl: String
    @EnvironmentObject private var playerViewModel: PlayerViewModel
    @Environment(\.dismiss) private var dismiss
    
    @State private var lyrics: Lyrics?
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var currentLineIndex: Int?
    
    var body: some View {
        NavigationView {
            ZStack {
                // Dark background similar to Apple Music
                LinearGradient(
                    gradient: Gradient(colors: [Color.black, Color(white: 0.05)]),
                    startPoint: .top,
                    endPoint: .bottom
                )
                .ignoresSafeArea()
                
                if isLoading {
                    VStack {
                        ProgressView()
                            .scaleEffect(1.2)
                            .tint(.white)
                        
                        Text("Loading lyrics...")
                            .foregroundColor(.white.opacity(0.8))
                            .padding(.top, 8)
                    }
                } else if let errorMessage = errorMessage {
                    VStack(spacing: 16) {
                        Image(systemName: "music.note.list")
                            .font(.system(size: 50))
                            .foregroundColor(.gray)
                        
                        Text("Lyrics unavailable")
                            .font(.title2)
                            .fontWeight(.semibold)
                            .foregroundColor(.white)
                        
                        Text(errorMessage)
                            .font(.subheadline)
                            .foregroundColor(.gray)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal)
                    }
                    .padding()
                } else if let lyrics = lyrics {
                    LyricsScrollView(
                        lyrics: lyrics,
                        currentTime: playerViewModel.currentTime,
                        currentLineIndex: $currentLineIndex,
                        onSeek: { time in
                            playerViewModel.seek(to: time)
                        }
                    )
                } else {
                    VStack(spacing: 16) {
                        Image(systemName: "music.note")
                            .font(.system(size: 50))
                            .foregroundColor(.gray)
                        
                        Text("No lyrics available")
                            .font(.title2)
                            .fontWeight(.semibold)
                            .foregroundColor(.white)
                            
                        Text("Lyrics will appear here when available")
                            .font(.subheadline)
                            .foregroundColor(.gray)
                    }
                }
            }
            .navigationTitle("Lyrics")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") {
                        dismiss()
                    }
                    .foregroundColor(.white)
                }
            }
        }
        .onAppear {
            loadLyrics()
        }
        .onChange(of: playerViewModel.currentTime) { currentTime in
            updateCurrentLine(for: currentTime)
        }
    }
    
    private func loadLyrics() {
        guard !lyricsUrl.isEmpty else {
            errorMessage = "No lyrics URL provided"
            isLoading = false
            return
        }
        
        guard let url = URL(string: lyricsUrl) else {
            errorMessage = "Invalid lyrics URL"
            isLoading = false
            return
        }
        
        URLSession.shared.dataTask(with: url) { data, response, error in
            DispatchQueue.main.async {
                isLoading = false
                
                if let error = error {
                    errorMessage = "Failed to load lyrics: \(error.localizedDescription)"
                    return
                }
                
                guard let httpResponse = response as? HTTPURLResponse else {
                    errorMessage = "Invalid response"
                    return
                }
                
                guard 200...299 ~= httpResponse.statusCode else {
                    errorMessage = "Server error (Status: \(httpResponse.statusCode))"
                    return
                }
                
                guard let data = data,
                      let lyricsText = String(data: data, encoding: .utf8) else {
                    errorMessage = "Failed to decode lyrics"
                    return
                }
                
                let parsedLyrics = LyricsParser.parse(lyricsText)
                
                if parsedLyrics.lines.isEmpty {
                    errorMessage = "No valid lyrics found in file"
                } else {
                    lyrics = parsedLyrics
                }
            }
        }.resume()
    }
    
    private func updateCurrentLine(for currentTime: TimeInterval) {
        guard let lyrics = lyrics else { return }
        currentLineIndex = lyrics.currentLineIndex(for: currentTime)
    }
}

struct LyricsScrollView: View {
    let lyrics: Lyrics
    let currentTime: TimeInterval
    @Binding var currentLineIndex: Int?
    let onSeek: (TimeInterval) -> Void
    
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 32) {
                    // Add top padding
                    Spacer()
                        .frame(height: 120)
                    
                    ForEach(Array(lyrics.lines.enumerated()), id: \.offset) { index, line in
                        LyricsLineView(
                            line: line,
                            isActive: index == currentLineIndex,
                            isNext: index == (currentLineIndex ?? -1) + 1,
                            isPrevious: index == (currentLineIndex ?? 1) - 1,
                            onTap: {
                                onSeek(line.timestamp)
                            }
                        )
                        .id("line-\(index)")
                    }
                    
                    // Add bottom padding
                    Spacer()
                        .frame(height: 120)
                }
                .padding(.horizontal, 24)
            }
            .onChange(of: currentLineIndex) { newIndex in
                guard let index = newIndex else { return }
                
                withAnimation(.easeInOut(duration: 0.5)) {
                    proxy.scrollTo("line-\(index)", anchor: .center)
                }
            }
        }
    }
}

struct LyricsLineView: View {
    let line: LyricsLine
    let isActive: Bool
    let isNext: Bool
    let isPrevious: Bool
    let onTap: () -> Void
    
    var body: some View {
        Button(action: onTap) {
            Text(line.text)
                .font(fontSize)
                .fontWeight(fontWeight)
                .foregroundColor(textColor)
                .multilineTextAlignment(.center)
                .lineLimit(nil)
                .fixedSize(horizontal: false, vertical: true)
                .scaleEffect(isActive ? 1.02 : 1.0)
                .padding(.vertical, isActive ? 8 : 4)
                .animation(.easeInOut(duration: 0.3), value: isActive)
        }
        .buttonStyle(PlainButtonStyle())
    }
    
    private var fontSize: Font {
        if isActive {
            return .title2
        } else if isNext || isPrevious {
            return .title3
        } else {
            return .body
        }
    }
    
    private var fontWeight: Font.Weight {
        if isActive {
            return .bold
        } else if isNext || isPrevious {
            return .semibold
        } else {
            return .medium
        }
    }
    
    private var textColor: Color {
        if isActive {
            return .white
        } else if isNext {
            return .white.opacity(0.8)
        } else if isPrevious {
            return .white.opacity(0.6)
        } else {
            return .white.opacity(0.4)
        }
    }
}

#Preview {
    LyricsView(lyricsUrl: "https://example.com/lyrics.txt")
        .environmentObject(PlayerViewModel())
} 