//
//  PlayerView.swift
//  BriefCast
//
//  Created by Zezhu Yu on 2025-06-09.
//

import SwiftUI
import Combine
import AVFoundation
import CoreLocation
import Foundation
import UIKit

// MARK: - Orientation Detection
class OrientationManager: ObservableObject {
    @Published var orientation: UIDeviceOrientation = UIDevice.current.orientation
    
    init() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(orientationChanged),
            name: UIDevice.orientationDidChangeNotification,
            object: nil
        )
    }
    
    @objc private func orientationChanged() {
        DispatchQueue.main.async {
            self.orientation = UIDevice.current.orientation
        }
    }
    
    var isLandscape: Bool {
        orientation == .landscapeLeft || orientation == .landscapeRight
    }
    
    deinit {
        NotificationCenter.default.removeObserver(self)
    }
}

// MARK: - Helper Function
func formatRelativeTime(from timestamp: String) -> String {
    // Try to parse as timestamp (seconds or milliseconds)
    if let timestampValue = Double(timestamp) {
        var date: Date
        if timestampValue > 1e10 { // Milliseconds
            date = Date(timeIntervalSince1970: timestampValue / 1000)
        } else { // Seconds
            date = Date(timeIntervalSince1970: timestampValue)
        }
        return formatRelativeDate(date)
    }
    
    // Try to parse as the specific format: "2025-06-10 10:13:45.357959"
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd HH:mm:ss.SSSSSS"
    if let date = formatter.date(from: timestamp) {
        return formatRelativeDate(date)
    }
    
    // Try to parse without microseconds: "2025-06-10 10:13:45"
    formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
    if let date = formatter.date(from: timestamp) {
        return formatRelativeDate(date)
    }
    
    // Try to parse as ISO date string
    let dateFormatter = ISO8601DateFormatter()
    if let date = dateFormatter.date(from: timestamp) {
        return formatRelativeDate(date)
    }
    
    // Try other common date formats
    formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSSZ"
    if let date = formatter.date(from: timestamp) {
        return formatRelativeDate(date)
    }
    
    // If all parsing fails, return the original string
    return timestamp
}

func formatRelativeDate(_ date: Date) -> String {
    let now = Date()
    let diffTime = abs(now.timeIntervalSince(date))
    let diffDays = Int(ceil(diffTime / (60 * 60 * 24)))
    
    if diffTime < 60 {
        return "just now"
    }
    if diffTime < 60 * 60 {
        let minutes = Int(ceil(diffTime / 60))
        return "\(minutes) minute\(minutes == 1 ? "" : "s") ago"
    }
    if diffTime < 60 * 60 * 24 {
        let hours = Int(ceil(diffTime / (60 * 60)))
        return "\(hours) hour\(hours == 1 ? "" : "s") ago"
    }
    if diffDays < 30 {
        return "\(diffDays) day\(diffDays == 1 ? "" : "s") ago"
    }
    if diffDays < 365 {
        let months = Int(ceil(Double(diffDays) / 30))
        return "\(months) month\(months == 1 ? "" : "s") ago"
    }
    let years = Int(ceil(Double(diffDays) / 365))
    return "\(years) year\(years == 1 ? "" : "s") ago"
}

// MARK: - Color Extraction Utility
class ImageColorExtractor {
    static func extractDominantColors(from imageData: Data) -> [Color] {
        guard let uiImage = UIImage(data: imageData),
              let cgImage = uiImage.cgImage else {
            return [Color.blue.opacity(0.4), Color.orange.opacity(0.4), Color.green.opacity(0.4)] // Darker default colors
        }
        
        let width = 100 // Moderate resolution for speed
        let height = 100
        
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            return [Color.blue.opacity(0.4), Color.orange.opacity(0.4), Color.green.opacity(0.4)]
        }
        
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
        
        guard let data = context.data else {
            return [Color.blue.opacity(0.4), Color.orange.opacity(0.4), Color.green.opacity(0.4)]
        }
        
        let buffer = data.bindMemory(to: UInt8.self, capacity: width * height * 4)
        
        var colorCounts: [String: Int] = [:] // Use string keys for exact colors
        
        // Sample every pixel with almost no filtering
        for i in stride(from: 0, to: width * height * 4, by: 4) {
            let r = buffer[i]
            let g = buffer[i + 1]
            let b = buffer[i + 2]
            let a = buffer[i + 3]
            
            // Only skip completely transparent pixels
            if a < 80 { continue }
            
            // Keep almost all colors - only filter extreme cases
            let brightness = (Int(r) + Int(g) + Int(b)) / 3
            if brightness < 15 || brightness > 245 { continue }
            
            // Skip white/very light colors completely
            let rNorm = Double(r) / 255.0
            let gNorm = Double(g) / 255.0
            let bNorm = Double(b) / 255.0
            
            // Skip if all RGB values are too high (white/light gray)
            if rNorm > 0.85 && gNorm > 0.85 && bNorm > 0.85 { continue }
            
            // Also skip if the color is very close to white in any combination
            let minComponent = min(rNorm, gNorm, bNorm)
            let maxComponent = max(rNorm, gNorm, bNorm)
            if minComponent > 0.8 && maxComponent > 0.9 { continue }
            
            // Create color key with exact RGB values (no masking!)
            let colorKey = "\(r)-\(g)-\(b)"
            colorCounts[colorKey, default: 0] += 1
        }
        
        
        // Group similar colors manually to reduce noise
        var groupedColors: [Color: Int] = [:]
        
        for (colorKey, count) in colorCounts {
            let components = colorKey.split(separator: "-")
            guard components.count == 3,
                  let r = Int(components[0]),
                  let g = Int(components[1]),
                  let b = Int(components[2]) else { continue }
            
            let color = Color(red: Double(r)/255.0, green: Double(g)/255.0, blue: Double(b)/255.0)
            
            // Find if this color is similar to any existing grouped color
            var foundSimilar = false
            for (existingColor, existingCount) in groupedColors {
                if areColorsVerySimilar(color, existingColor) {
                    groupedColors[existingColor] = existingCount + count
                    foundSimilar = true
                    break
                }
            }
            
            if !foundSimilar {
                groupedColors[color] = count
            }
        }
        
        // Sort by frequency
        let sortedColors = groupedColors.sorted { $0.value > $1.value }
        
        var extractedColors: [Color] = []
        
        // Take the top colors with diversity
        for (color, _) in sortedColors {
            if extractedColors.count >= 4 { break }
            
            // Check if this color is different enough from what we have
            var shouldAdd = true
            for existingColor in extractedColors {
                if areColorsModerateLySimilar(color, existingColor) {
                    shouldAdd = false
                    break
                }
            }
            
            if shouldAdd {
                extractedColors.append(color)
                
                // Get RGB values for debugging
                let uiColor = UIColor(color)
                var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
                uiColor.getRed(&r, green: &g, blue: &b, alpha: &a)
                
                _ = getColorDescription(r: Double(r), g: Double(g), b: Double(b))
            }
        }
        
        // Add diverse fallback colors if needed
        while extractedColors.count < 3 {
            let vibrantColors = [Color.green, Color.orange, Color.purple, Color.cyan]
            extractedColors.append(vibrantColors[extractedColors.count % vibrantColors.count])
        }
        
        return Array(extractedColors.prefix(4))
    }
    
    private static func areColorsVerySimilar(_ color1: Color, _ color2: Color) -> Bool {
        let ui1 = UIColor(color1)
        let ui2 = UIColor(color2)
        
        var r1: CGFloat = 0, g1: CGFloat = 0, b1: CGFloat = 0, a1: CGFloat = 0
        var r2: CGFloat = 0, g2: CGFloat = 0, b2: CGFloat = 0, a2: CGFloat = 0
        
        ui1.getRed(&r1, green: &g1, blue: &b1, alpha: &a1)
        ui2.getRed(&r2, green: &g2, blue: &b2, alpha: &a2)
        
        // Very tight similarity for initial grouping
        let distance = sqrt(pow(r1 - r2, 2) + pow(g1 - g2, 2) + pow(b1 - b2, 2))
        return distance < 0.05
    }
    
    private static func areColorsModerateLySimilar(_ color1: Color, _ color2: Color) -> Bool {
        let ui1 = UIColor(color1)
        let ui2 = UIColor(color2)
        
        var r1: CGFloat = 0, g1: CGFloat = 0, b1: CGFloat = 0, a1: CGFloat = 0
        var r2: CGFloat = 0, g2: CGFloat = 0, b2: CGFloat = 0, a2: CGFloat = 0
        
        ui1.getRed(&r1, green: &g1, blue: &b1, alpha: &a1)
        ui2.getRed(&r2, green: &g2, blue: &b2, alpha: &a2)
        
        // Moderate similarity for final selection
        let distance = sqrt(pow(r1 - r2, 2) + pow(g1 - g2, 2) + pow(b1 - b2, 2))
        return distance < 0.12
    }
    
    private static func getColorDescription(r: Double, g: Double, b: Double) -> String {
        let red = r, green = g, blue = b
        
        if red > 0.7 && green < 0.3 && blue < 0.3 {
            return "Red"
        } else if red > 0.7 && green > 0.4 && blue < 0.3 {
            return "Orange"
        } else if red > 0.8 && green > 0.6 && blue < 0.4 {
            return "Yellow"
        } else if red < 0.4 && green > 0.6 && blue < 0.4 {
            return "Green"
        } else if red < 0.4 && green > 0.6 && blue > 0.6 {
            return "Teal"
        } else if red < 0.3 && green < 0.3 && blue > 0.7 {
            return "Blue"
        } else if red > 0.5 && green < 0.3 && blue > 0.5 {
            return "Purple"
        } else if red > 0.8 && green < 0.6 && blue > 0.6 {
            return "Pink"
        } else if red > 0.8 && green > 0.8 && blue > 0.8 {
            return "White"
        } else if red < 0.2 && green < 0.2 && blue < 0.2 {
            return "Black"
        } else if red > 0.6 && green > 0.6 && blue > 0.6 {
            return "Light Gray"
        } else if red < 0.4 && green < 0.4 && blue < 0.4 {
            return "Dark Gray"
        } else {
            return "Mixed"
        }
    }
    
    private static func areColorsSimilar(_ color1: Color, _ color2: Color, threshold: Double = 0.2) -> Bool {
        let ui1 = UIColor(color1)
        let ui2 = UIColor(color2)
        
        var r1: CGFloat = 0, g1: CGFloat = 0, b1: CGFloat = 0, a1: CGFloat = 0
        var r2: CGFloat = 0, g2: CGFloat = 0, b2: CGFloat = 0, a2: CGFloat = 0
        
        ui1.getRed(&r1, green: &g1, blue: &b1, alpha: &a1)
        ui2.getRed(&r2, green: &g2, blue: &b2, alpha: &a2)
        
        // Calculate Euclidean distance in RGB space
        let distance = sqrt(pow(r1 - r2, 2) + pow(g1 - g2, 2) + pow(b1 - b2, 2))
        
        return distance < threshold
    }
    
    private static func createVariation(of color: Color, variation: Int) -> Color {
        // Convert to HSB and create variations
        let uiColor = UIColor(color)
        var hue: CGFloat = 0, saturation: CGFloat = 0, brightness: CGFloat = 0, alpha: CGFloat = 0
        uiColor.getHue(&hue, saturation: &saturation, brightness: &brightness, alpha: &alpha)
        
        switch variation {
        case 1:
            // Slightly different hue
            hue = (hue + 0.1).truncatingRemainder(dividingBy: 1.0)
        case 2:
            // Different saturation
            saturation = min(1.0, saturation + 0.3)
        default:
            // Different brightness
            brightness = min(1.0, brightness + 0.2)
        }
        
        return Color(UIColor(hue: hue, saturation: saturation, brightness: brightness, alpha: alpha))
    }
}

// MARK: - Animated Background Component
struct AnimatedGradientBackground: View {
    let colors: [Color]
    @State private var animationOffset: CGFloat = 0
    @State private var randomOffsets: [CGFloat] = []
    
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                // Dark base background for areas not covered by color chunks
                Rectangle()
                    .fill(
                        LinearGradient(
                            gradient: Gradient(colors: [
                                Color.black.opacity(0.8),
                                Color.black.opacity(0.9),
                                Color.black.opacity(0.85)
                            ]),
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .ignoresSafeArea()
                
                // Main flowing color chunks
                FlowingColorChunks(
                    colors: colors,
                    animationOffset: animationOffset,
                    randomOffsets: randomOffsets,
                    geometry: geometry
                )
                
                // Floating color patches
                FloatingColorPatches(
                    colors: colors,
                    animationOffset: animationOffset,
                    randomOffsets: randomOffsets,
                    geometry: geometry
                )
                
                // Remove the white material overlay to show more background color
            }
        }
        .clipped()
        .onAppear {
            setupRandomOffsets()
            startAnimation()
        }
        // Remove onChange to prevent animation restart when colors change
    }
    
    private func setupRandomOffsets() {
        randomOffsets = (0..<colors.count).map { _ in CGFloat.random(in: 0...360) }
    }
    
    private func startAnimation() {
        // Make animation faster and more visible
        withAnimation(.linear(duration: 15).repeatForever(autoreverses: false)) {
            animationOffset = 360
        }
    }
}

// MARK: - Flowing Color Chunks Sub-View
struct FlowingColorChunks: View {
    let colors: [Color]
    let animationOffset: CGFloat
    let randomOffsets: [CGFloat]
    let geometry: GeometryProxy
    
    var body: some View {
        ForEach(0..<colors.count, id: \.self) { index in
            let color = colors[index]
            let randomOffset = getRandomOffset(for: index)
            
            ForEach(0..<2, id: \.self) { instance in
                FlowingColorChunk(
                    color: color,
                    animationOffset: animationOffset,
                    randomOffset: randomOffset,
                    instance: instance,
                    geometry: geometry
                )
            }
        }
    }
    
    private func getRandomOffset(for index: Int) -> CGFloat {
        return randomOffsets.count > index ? randomOffsets[index] : 0
    }
}

// MARK: - Single Flowing Color Chunk
struct FlowingColorChunk: View {
    let color: Color
    let animationOffset: CGFloat
    let randomOffset: CGFloat
    let instance: Int
    let geometry: GeometryProxy
    
    private var instanceOffset: CGFloat {
        randomOffset + CGFloat(instance) * 180
    }
    
    // Make base position stable - only calculate once based on fixed parameters
    private var basePosition: CGPoint {
        // Use deterministic position based on instance and randomOffset
        let seedX = sin(randomOffset * .pi / 180) * 0.4 + 0.5 // 0.1 to 0.9
        let seedY = cos(randomOffset * .pi / 180) * 0.4 + 0.5 // 0.1 to 0.9
        let baseX = max(0.1, min(0.9, seedX)) * geometry.size.width
        let baseY = max(0.1, min(0.9, seedY)) * geometry.size.height
        return CGPoint(x: baseX, y: baseY)
    }
    
    private var flowingPosition: CGPoint {
        let base = basePosition
        // Make the animation more visible with larger movement
        let flowX = base.x + sin((animationOffset + instanceOffset) * .pi / 180) * 200
        let flowY = base.y + cos((animationOffset + instanceOffset * 0.7) * .pi / 180) * 150
        return CGPoint(x: flowX, y: flowY)
    }
    
    var body: some View {
        let position = flowingPosition
        
        Circle()
            .fill(color)
            .frame(width: geometry.size.width * 0.7, height: geometry.size.width * 0.7)
            .position(x: position.x, y: position.y)
            .blur(radius: 50)
            .opacity(0.6)
    }
}

// MARK: - Floating Color Patches Sub-View
struct FloatingColorPatches: View {
    let colors: [Color]
    let animationOffset: CGFloat
    let randomOffsets: [CGFloat]
    let geometry: GeometryProxy
    
    var body: some View {
        ForEach(0..<colors.count, id: \.self) { index in
            FloatingColorPatch(
                color: colors[index],
                animationOffset: animationOffset,
                randomOffset: getRandomOffset(for: index),
                geometry: geometry
            )
        }
    }
    
    private func getRandomOffset(for index: Int) -> CGFloat {
        return randomOffsets.count > index ? randomOffsets[index] : 0
    }
}

// MARK: - Single Floating Color Patch
struct FloatingColorPatch: View {
    let color: Color
    let animationOffset: CGFloat
    let randomOffset: CGFloat
    let geometry: GeometryProxy
    
    private var orbitalPosition: CGPoint {
        let centerX = geometry.size.width * 0.5
        let centerY = geometry.size.height * 0.5
        // Make the orbital radius larger and more dynamic
        let radiusX = geometry.size.width * 0.5
        let radiusY = geometry.size.height * 0.4
        
        // Use different animation speeds for more interesting movement
        let x = centerX + cos((animationOffset * 0.8 + randomOffset) * .pi / 180) * radiusX
        let y = centerY + sin((animationOffset * 0.6 + randomOffset) * .pi / 180) * radiusY
        
        return CGPoint(x: x, y: y)
    }
    
    var body: some View {
        let position = orbitalPosition
        
        Circle()
            .fill(color.opacity(0.5))
            .frame(width: geometry.size.width * 0.5, height: geometry.size.width * 0.5)
            .position(x: position.x, y: position.y)
            .blur(radius: 40)
    }
}

struct PlayerView: View {
    @EnvironmentObject private var playerViewModel: PlayerViewModel
    @StateObject private var orientationManager = OrientationManager()
    @State private var isShowingTranscript = false
    @State private var isShowingPlaylist = false
    @State private var showAddToPlaylistSheet = false
    @StateObject private var locationManager = LocationManager()
    @StateObject private var podcastImageLoader = PodcastImageLoader()
    @State private var extractedColors: [Color] = [Color.blue.opacity(0.4), Color.purple.opacity(0.4), Color.pink.opacity(0.4)]
    // Simple drag state for progress bar
    @State private var isDragging = false
    @State private var dragPosition: Double = 0
    // Persistent transcript state
    @State private var lastKnownPodcastId: String = ""
    // Track podcast changes for progress bar reset - more robust tracking
    @State private var lastProgressPodcastId: String = ""
    @State private var progressBarNeedsReset = false
    
    var body: some View {
        ZStack {
            // Stable animated background that persists across view switches
            AnimatedGradientBackground(colors: extractedColors)
                .ignoresSafeArea()
                .id("stable-background") // Stable ID to prevent recreation
            
            if playerViewModel.isLoading {
                loadingView
            } else if let podcast = playerViewModel.currentPodcast {
                if orientationManager.isLandscape {
                    // Horizontal split-screen layout (Apple Music style)
                    horizontalSplitScreenView(podcast: podcast)
                } else {
                    // Original portrait layout
                    podcastPlayerView(podcast: podcast)
                }
            } else {
                emptyStateView
            }
        }
//            .navigationTitle("BriefCast")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            // Prefetch playlists cache for quick Add-to-Playlist sheet
            PlaylistViewModel.prefetchPlaylistsIfNeeded()
            // If no podcast is loaded, generate one based on location
            if playerViewModel.currentPodcast == nil {
                generatePodcastFromLocation()
            }
        }
        .onChange(of: orientationManager.isLandscape) { isLandscape in
            // Set default transcript tab when rotating to landscape
            if isLandscape && !isShowingTranscript && !isShowingPlaylist {
                isShowingTranscript = true
                isShowingPlaylist = false
            }
            // When rotating back to portrait, preserve whatever tab was selected
        }
        .onChange(of: playerViewModel.currentPodcast?.id) { newPodcastId in
            // More robust progress bar reset logic
            if let newId = newPodcastId, newId != lastProgressPodcastId {
                lastProgressPodcastId = newId
                // Only reset if not currently dragging to prevent jumping
                if !isDragging {
                    dragPosition = 0
                    progressBarNeedsReset = false
                } else {
                    // Mark that we need to reset once dragging is done
                    progressBarNeedsReset = true
                }
            }
            
            // Reset transcript/playlist state only when podcast actually changes
            if let newId = newPodcastId, newId != lastKnownPodcastId {
                lastKnownPodcastId = newId
                // Don't reset transcript state for same podcast
                if !isShowingTranscript && !isShowingPlaylist {
                    // Keep current state if user has made a selection
                }
            }
        }
    }
    
    private var loadingView: some View {
        VStack(spacing: 20) {
            ProgressView()
                .scaleEffect(1.5)
                .foregroundColor(.white)
            
            if let podcast = playerViewModel.currentPodcast {
                VStack(spacing: 12) {
                    Text("Preparing \"\(podcast.title)\"")
                        .font(.headline)
                        .foregroundColor(.white)
                        .multilineTextAlignment(.center)
                    
                    if podcast.audioUrl.isEmpty {
                        Text("Generating audio content...")
                            .font(.subheadline)
                            .foregroundColor(.white.opacity(0.8))
                        
                        Text("This may take a few moments")
                            .font(.caption)
                            .foregroundColor(.white.opacity(0.8))
                    } else if podcast.durationSeconds <= 0 {
                        Text("Processing audio file...")
                            .font(.subheadline)
                            .foregroundColor(.white.opacity(0.8))
                        
                        Text("Almost ready")
                            .font(.caption)
                            .foregroundColor(.white.opacity(0.8))
                    } else {
                        Text("Loading podcast...")
                            .font(.subheadline)
                            .foregroundColor(.white.opacity(0.8))
                    }
                }
            } else {
                Text("Loading podcast...")
                    .font(.headline)
                    .foregroundColor(.white.opacity(0.8))
            }
        }
        .padding()
    }
    
    private var emptyStateView: some View {
        VStack(spacing: 20) {
            Image(systemName: "waveform.circle.fill")
                .font(.system(size: 80))
                .foregroundColor(.white)
            
            Text("Welcome to BriefCast")
                .font(.title)
                .fontWeight(.bold)
                .foregroundColor(.white)
            
            Text("Generating your personalized podcast...")
                .font(.subheadline)
                .foregroundColor(.white.opacity(0.8))
                .multilineTextAlignment(.center)
            
            Button("Generate Podcast") {
                generatePodcastFromLocation()
            }
            .buttonStyle(.borderedProminent)
            .disabled(playerViewModel.isLoading)
        }
        .padding()
    }
    
    private func podcastPlayerView(podcast: Podcast) -> some View {
        VStack(spacing: 0) {
            if isShowingTranscript {
                // Apple Music style synchronized transcript view
                appleMusicStyleTranscriptView(podcast: podcast)
            } else if isShowingPlaylist {
                // Apple Music style library view
                appleMusicStyleLibraryView(podcast: podcast)
            } else {
                // Original full-screen player view
                originalPlayerView(podcast: podcast)
            }
        }
        .animation(.easeInOut(duration: 0.3), value: isShowingTranscript)
        .animation(.easeInOut(duration: 0.3), value: isShowingPlaylist)
        .onAppear {
            // Trigger color extraction when view first appears
            extractColorsFromImage(podcast: podcast)
        }
        .onChange(of: podcast.id) { newPodcastId in
            // Reset extracted colors when podcast changes and trigger extraction
            extractedColors = [Color.blue.opacity(0.4), Color.purple.opacity(0.4), Color.pink.opacity(0.4)]
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                extractColorsFromImage(podcast: podcast)
            }
        }
        .onChange(of: playerViewModel.currentImageUrl) { newImageUrl in
            // Also update colors when the current image URL changes (for transition audio)
            if !newImageUrl.isEmpty && newImageUrl != podcast.imageUrl {
                extractedColors = [Color.blue.opacity(0.4), Color.purple.opacity(0.4), Color.pink.opacity(0.4)]
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                    extractColorsFromTransitionImage(url: newImageUrl)
                }
            }
        }
        .sheet(isPresented: $showAddToPlaylistSheet) {
            AddToPlaylistSheet(currentPodcastId: podcast.id)
        }
    }
    
    // MARK: - Horizontal Split-Screen View (Apple Music Style)
    private func horizontalSplitScreenView(podcast: Podcast) -> some View {
        HStack(spacing: 0) {
            // Left side - Player
            VStack(spacing: 20) {
                // Header with three-dot menu
                HStack {
                    Spacer()
                    
                    // Three-dot menu button
                    Menu {
                        Button {
                            playerViewModel.toggleLike()
                        } label: {
                            Label(playerViewModel.isLiked ? "Unlike" : "Like", 
                                  systemImage: playerViewModel.isLiked ? "hand.thumbsup.fill" : "hand.thumbsup")
                        }
                        
                        Button {
                            playerViewModel.toggleDislike()
                        } label: {
                            Label(playerViewModel.isDisliked ? "Remove Dislike" : "Dislike", 
                                  systemImage: playerViewModel.isDisliked ? "hand.thumbsdown.fill" : "hand.thumbsdown")
                        }
                        
                        Divider()
                        
                        Button {
                            showAddToPlaylistSheet.toggle()
                        } label: {
                            Label("Add to Playlist", systemImage: "plus.circle")
                        }
                        
                        Button {
                            playerViewModel.toggleDownload()
                        } label: {
                            if playerViewModel.isDownloading {
                                Label("Downloading...", systemImage: "arrow.down.circle")
                            } else {
                                Label(playerViewModel.isDownloaded ? "Downloaded" : "Download", 
                                      systemImage: playerViewModel.isDownloaded ? "checkmark.circle.fill" : "arrow.down.circle")
                            }
                        }
                        .disabled(playerViewModel.isDownloading)
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.title2)
                            .foregroundColor(.white)
                    }
                }
                .padding(.horizontal)
                
                // Podcast artwork - smaller for landscape
                ZStack(alignment: .bottomLeading) {
                    Group {
                        if !playerViewModel.currentImageUrl.isEmpty {
                            AsyncImage(url: URL(string: playerViewModel.currentImageUrl)) { image in
                                image
                                    .resizable()
                                    .aspectRatio(contentMode: .fill)
                            } placeholder: {
                                RoundedRectangle(cornerRadius: 12)
                                    .fill(Color.gray.opacity(0.3))
                                    .overlay(
                                        Image(systemName: "music.note")
                                            .font(.system(size: 30))
                                            .foregroundColor(.gray)
                                    )
                            }
                            .id("current-image-\(playerViewModel.currentImageUrl)")
                        } else {
                            PersistentPodcastImageView(
                                podcast: podcast,
                                imageLoader: podcastImageLoader
                            )
                            .id("podcast-image-\(podcast.id)")
                        }
                    }
                    .frame(width: 200, height: 200) // Smaller for landscape
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .shadow(color: .black.opacity(0.3), radius: 15, x: 0, y: 8)
                    
                    if !playerViewModel.isPlayingTransition && !podcast.link.isEmpty && podcast.link.hasPrefix("http") {
                        Button {
                            if let url = URL(string: podcast.link) {
                                UIApplication.shared.open(url)
                            }
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: "link")
                                    .font(.caption2)
                                Text("Source")
                                    .font(.caption2)
                                    .fontWeight(.medium)
                            }
                            .padding(.horizontal, 8)
                            .padding(.vertical, 6)
                            .background(Color.black.opacity(0.7))
                            .foregroundColor(.white)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                            .shadow(color: .black.opacity(0.3), radius: 3, x: 0, y: 1)
                        }
                        .buttonStyle(PlainButtonStyle())
                        .padding(8)
                    }
                }
                
                // Podcast info - compact for landscape
                VStack(spacing: 6) {
                    Text(playerViewModel.currentTitle.isEmpty ? podcast.title : playerViewModel.currentTitle)
                        .font(.title3)
                        .fontWeight(.semibold)
                        .multilineTextAlignment(.center)
                        .foregroundColor(.white)
                        .fixedSize(horizontal: false, vertical: true)
                        .lineLimit(2)
                    
                    Text(playerViewModel.currentHost.isEmpty ? formatRelativeTime(from: podcast.publishedAt) : playerViewModel.currentHost)
                        .font(.caption)
                        .foregroundColor(.white.opacity(0.8))
                }
                
                Spacer()
                
                // Compact bottom controls for landscape
                compactBottomControls
            }
            .frame(maxWidth: .infinity)
            .padding(.top)
            
            // Right side - Tab content with selection
            VStack(spacing: 0) {
                // Tab selection buttons
                HStack(spacing: 40) {
                    Button {
                        isShowingTranscript = true
                        isShowingPlaylist = false
                    } label: {
                        VStack(spacing: 4) {
                            Image(systemName: isShowingTranscript ? "doc.text.fill" : "doc.text")
                                .font(.title3)
                            Text("Transcript")
                                .font(.caption)
                                .fontWeight(.medium)
                        }
                    }
                    .foregroundColor(isShowingTranscript ? .white : .white.opacity(0.6))
                    
                    Button {
                        isShowingTranscript = false
                        isShowingPlaylist = true
                    } label: {
                        VStack(spacing: 4) {
                            Image(systemName: "music.note.list")
                                .font(.title3)
                            Text("Playlists")
                                .font(.caption)
                                .fontWeight(.medium)
                        }
                    }
                    .foregroundColor(isShowingPlaylist ? .white : .white.opacity(0.6))
                }
                .padding(.vertical, 12)
                
                // Content based on selection
                if isShowingTranscript {
                    // Transcript content
                    SynchronizedTranscriptContentView(
                        transcriptUrl: playerViewModel.currentTranscriptUrl.isEmpty ? podcast.transcriptUrl : playerViewModel.currentTranscriptUrl, 
                        currentTime: playerViewModel.currentTime,
                        onSeek: { time in
                            playerViewModel.seek(to: time)
                        }
                    )
                    .id("transcript-\(playerViewModel.currentTranscriptUrl)")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding(.vertical, 10)
                } else {
                    // Playlist/Library content
                    LibraryContentView(currentPodcastId: podcast.id)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .padding(.vertical, 10)
                }
            }
            .frame(maxWidth: .infinity)
        }
        .onAppear {
            // Set default tab to transcript in landscape mode
            if orientationManager.isLandscape && !isShowingTranscript && !isShowingPlaylist {
                isShowingTranscript = true
                isShowingPlaylist = false
            }
            
            // Trigger color extraction when view first appears
            extractColorsFromImage(podcast: podcast)
        }
        .onChange(of: podcast.id) { newPodcastId in
            // Reset extracted colors when podcast changes and trigger extraction
            extractedColors = [Color.blue.opacity(0.4), Color.purple.opacity(0.4), Color.pink.opacity(0.4)]
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                extractColorsFromImage(podcast: podcast)
            }
        }
        .onChange(of: playerViewModel.currentImageUrl) { newImageUrl in
            // Also update colors when the current image URL changes (for transition audio)
            if !newImageUrl.isEmpty && newImageUrl != podcast.imageUrl {
                extractedColors = [Color.blue.opacity(0.4), Color.purple.opacity(0.4), Color.pink.opacity(0.4)]
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                    extractColorsFromTransitionImage(url: newImageUrl)
                }
            }
        }
        .sheet(isPresented: $showAddToPlaylistSheet) {
            AddToPlaylistSheet(currentPodcastId: podcast.id)
        }
    }
    
    // MARK: - Shared Bottom Controls Component
    private var sharedBottomControls: some View {
        VStack(spacing: 24) {
            // Progress bar
            customProgressBar()
                .padding(.horizontal)
                .padding(.bottom, -30)
            
            // All playback and navigation controls in one line
            HStack(spacing: 25) {
                Button {
                    playerViewModel.skipBackward(15)
                } label: {
                    Image(systemName: "gobackward.15")
                        .font(.title2)
                }
                
                Button {
                    playerViewModel.playPrevious()
                } label: {
                    Image(systemName: "backward.fill")
                        .font(.title2)
                }
                .disabled(!playerViewModel.hasPrevious)
                
                Button {
                    playerViewModel.togglePlayPause()
                } label: {
                    Image(systemName: playerViewModel.isPlaying ? "pause.circle.fill" : "play.circle.fill")
                        .font(.system(size: 64))
                }
                
                Button {
                    playerViewModel.playNext()
                } label: {
                    Image(systemName: "forward.fill")
                        .font(.title2)
                }
                .disabled(!playerViewModel.hasNext)
                
                Button {
                    playerViewModel.skipForward(30)
                } label: {
                    Image(systemName: "goforward.30")
                        .font(.title2)
                }
            }
            .foregroundColor(.white)
            .padding(.bottom, -20)
            
            // Simplified controls - just transcript and library
            HStack(spacing: 100) {
                Button {
                    if isShowingTranscript {
                        // If transcript is showing, clicking it goes back to player
                        isShowingTranscript = false
                        isShowingPlaylist = false
                    } else {
                        // Show transcript, hide playlist
                        isShowingTranscript = true
                        isShowingPlaylist = false
                    }
                } label: {
                    VStack {
                        Image(systemName: isShowingTranscript ? "doc.text.fill" : "doc.text")
                            .font(.title2)
                        Text("Transcript")
                            .font(.caption)
                    }
                }
                .foregroundColor(isShowingTranscript ? .white : .white.opacity(0.6))
                
                Button {
                    if isShowingPlaylist {
                        // If playlist is showing, clicking it goes back to player
                        isShowingTranscript = false
                        isShowingPlaylist = false
                    } else {
                        // Show playlist, hide transcript
                        isShowingTranscript = false
                        isShowingPlaylist = true
                    }
                } label: {
                    VStack {
                        Image(systemName: "music.note.list")
                            .font(.title2)
                        Text("Playlists")
                            .font(.caption)
                    }
                }
                .foregroundColor(isShowingPlaylist ? .white : .white.opacity(0.6))
            }
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 20)
    }
    
    // MARK: - Compact Bottom Controls for Landscape
    private var compactBottomControls: some View {
        VStack(spacing: 16) {
            // Progress bar - more compact
            compactProgressBar()
                .padding(.horizontal)
            
            // Compact playback controls
            HStack(spacing: 20) {
                Button {
                    playerViewModel.skipBackward(15)
                } label: {
                    Image(systemName: "gobackward.15")
                        .font(.title3)
                }
                
                Button {
                    playerViewModel.playPrevious()
                } label: {
                    Image(systemName: "backward.fill")
                        .font(.title3)
                }
                .disabled(!playerViewModel.hasPrevious)
                
                Button {
                    playerViewModel.togglePlayPause()
                } label: {
                    Image(systemName: playerViewModel.isPlaying ? "pause.circle.fill" : "play.circle.fill")
                        .font(.system(size: 50))
                }
                
                Button {
                    playerViewModel.playNext()
                } label: {
                    Image(systemName: "forward.fill")
                        .font(.title3)
                }
                .disabled(!playerViewModel.hasNext)
                
                Button {
                    playerViewModel.skipForward(30)
                } label: {
                    Image(systemName: "goforward.30")
                        .font(.title3)
                }
            }
            .foregroundColor(.white)
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 16)
    }
    
    // MARK: - Apple Music Style Synchronized Transcript View
    private func appleMusicStyleTranscriptView(podcast: Podcast) -> some View {
        VStack(spacing: 0) {
            // Top section with squeezed image and basic info
            HStack(alignment: .center, spacing: 16) {
                // Squeezed podcast artwork - use current image URL from PlayerViewModel
                ZStack {
                    Group {
                        if !playerViewModel.currentImageUrl.isEmpty {
                            AsyncImage(url: URL(string: playerViewModel.currentImageUrl)) { image in
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
                        } else {
                            PersistentPodcastImageView(
                                podcast: podcast,
                                imageLoader: podcastImageLoader
                            )
                        }
                    }
                    .frame(width: 80, height: 80)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .shadow(radius: 5)
                }
                
                // Podcast info - use current title and host from PlayerViewModel
                VStack(alignment: .leading, spacing: 2) {
                    Text(playerViewModel.currentTitle.isEmpty ? podcast.title : playerViewModel.currentTitle)
                        .font(.headline)
                        .fontWeight(.semibold)
                        .fixedSize(horizontal: false, vertical: true)
                        .foregroundColor(.white)
                    
                    Text(playerViewModel.currentHost.isEmpty ? formatRelativeTime(from: podcast.publishedAt) : playerViewModel.currentHost)
                        .font(.subheadline)
                        .foregroundColor(.white.opacity(0.8))
                }
                
                Spacer()
                
                // Three-dot menu button
                Menu {
                    Button {
                        playerViewModel.toggleLike()
                    } label: {
                        Label(playerViewModel.isLiked ? "Unlike" : "Like", 
                              systemImage: playerViewModel.isLiked ? "hand.thumbsup.fill" : "hand.thumbsup")
                    }
                    
                    Button {
                        playerViewModel.toggleDislike()
                    } label: {
                        Label(playerViewModel.isDisliked ? "Remove Dislike" : "Dislike", 
                              systemImage: playerViewModel.isDisliked ? "hand.thumbsdown.fill" : "hand.thumbsdown")
                    }
                    
                    Divider()
                    
                    Button {
                        showAddToPlaylistSheet.toggle()
                    } label: {
                        Label("Add to Playlist", systemImage: "plus.circle")
                    }
                    
                    Button {
                        playerViewModel.toggleDownload()
                    } label: {
                        if playerViewModel.isDownloading {
                            Label("Downloading...", systemImage: "arrow.down.circle")
                        } else {
                            Label(playerViewModel.isDownloaded ? "Downloaded" : "Download", 
                                  systemImage: playerViewModel.isDownloaded ? "checkmark.circle.fill" : "arrow.down.circle")
                        }
                    }
                    .disabled(playerViewModel.isDownloading)

                    if !playerViewModel.isPlayingTransition && !podcast.link.isEmpty && podcast.link.hasPrefix("http") {
                        Button {
                            if let url = URL(string: podcast.link) {
                                UIApplication.shared.open(url)
                            }
                        } label: {
                            Label("View Source", systemImage: "link")
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.title2)
                        .foregroundColor(.white)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 10)
            
            // Synchronized transcript content area - use current transcript URL from PlayerViewModel
            SynchronizedTranscriptContentView(
                transcriptUrl: playerViewModel.currentTranscriptUrl.isEmpty ? podcast.transcriptUrl : playerViewModel.currentTranscriptUrl, 
                currentTime: playerViewModel.currentTime,
                onSeek: { time in
                    playerViewModel.seek(to: time)
                }
            )
            .id("transcript-\(playerViewModel.currentTranscriptUrl)")
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.vertical, 10)
            .mask(
                VStack(spacing: 0) {
                    // Top fade
                    LinearGradient(
                        gradient: Gradient(stops: [
                            .init(color: Color.clear, location: 0.0),
                            .init(color: Color.black, location: 1.0)
                        ]),
                        startPoint: .top,
                        endPoint: .bottom
                    )
                    .frame(height: 100)
                    
                    // Middle (full visibility)
                    Rectangle()
                        .fill(Color.black)
                    
                    // Bottom fade
                    LinearGradient(
                        gradient: Gradient(stops: [
                            .init(color: Color.black, location: 0.0),
                            .init(color: Color.clear, location: 1.0)
                        ]),
                        startPoint: .top,
                        endPoint: .bottom
                    )
                    .frame(height: 60)
                }
            )
            
            // Audio controls at bottom - same as original player
            sharedBottomControls
        }
    }
    
    // MARK: - Apple Music Style Library View
    private func appleMusicStyleLibraryView(podcast: Podcast) -> some View {
        VStack(spacing: 0) {
            // Top section with squeezed image and basic info
            HStack(alignment: .center, spacing: 16) {
                // Squeezed podcast artwork - use current image URL from PlayerViewModel
                ZStack {
                    Group {
                        if !playerViewModel.currentImageUrl.isEmpty {
                            AsyncImage(url: URL(string: playerViewModel.currentImageUrl)) { image in
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
                        } else {
                            PersistentPodcastImageView(
                                podcast: podcast,
                                imageLoader: podcastImageLoader
                            )
                        }
                    }
                    .frame(width: 80, height: 80)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .shadow(radius: 5)
                }
                
                // Podcast info - use current title and host from PlayerViewModel
                VStack(alignment: .leading, spacing: 2) {
                    Text(playerViewModel.currentTitle.isEmpty ? podcast.title : playerViewModel.currentTitle)
                        .font(.headline)
                        .fontWeight(.semibold)
                        .fixedSize(horizontal: false, vertical: true)
                        .foregroundColor(.white)
                    
                    Text(playerViewModel.currentHost.isEmpty ? formatRelativeTime(from: podcast.publishedAt) : playerViewModel.currentHost)
                        .font(.subheadline)
                        .foregroundColor(.white.opacity(0.8))
                }
                
                Spacer()
                
                // Three-dot menu button
                Menu {
                    Button {
                        playerViewModel.toggleLike()
                    } label: {
                        Label(playerViewModel.isLiked ? "Unlike" : "Like", 
                              systemImage: playerViewModel.isLiked ? "hand.thumbsup.fill" : "hand.thumbsup")
                    }
                    
                    Button {
                        playerViewModel.toggleDislike()
                    } label: {
                        Label(playerViewModel.isDisliked ? "Remove Dislike" : "Dislike", 
                              systemImage: playerViewModel.isDisliked ? "hand.thumbsdown.fill" : "hand.thumbsdown")
                    }
                    
                    Divider()
                    
                    Button {
                        showAddToPlaylistSheet.toggle()
                    } label: {
                        Label("Add to Playlist", systemImage: "plus.circle")
                    }
                    
                    Button {
                        playerViewModel.toggleDownload()
                    } label: {
                        if playerViewModel.isDownloading {
                            Label("Downloading...", systemImage: "arrow.down.circle")
                        } else {
                            Label(playerViewModel.isDownloaded ? "Downloaded" : "Download", 
                                  systemImage: playerViewModel.isDownloaded ? "checkmark.circle.fill" : "arrow.down.circle")
                        }
                    }
                    .disabled(playerViewModel.isDownloading)

                    if !playerViewModel.isPlayingTransition && !podcast.link.isEmpty && podcast.link.hasPrefix("http") {
                        Button {
                            if let url = URL(string: podcast.link) {
                                UIApplication.shared.open(url)
                            }
                        } label: {
                            Label("View Source", systemImage: "link")
                        }
                    }

                } label: {
                    Image(systemName: "ellipsis")
                        .font(.title2)
                        .foregroundColor(.white)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 10)
            
            // Library content area
            LibraryContentView(currentPodcastId: podcast.id)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(.vertical, 10)
                .mask(
                    VStack(spacing: 0) {
                        // Top fade
                        LinearGradient(
                            gradient: Gradient(stops: [
                                .init(color: Color.clear, location: 0.0),
                                .init(color: Color.black, location: 1.0)
                            ]),
                            startPoint: .top,
                            endPoint: .bottom
                        )
                        .frame(height: 60)
                        
                        // Middle (full visibility)
                        Rectangle()
                            .fill(Color.black)
                        
                        // Bottom fade
                        LinearGradient(
                            gradient: Gradient(stops: [
                                .init(color: Color.black, location: 0.0),
                                .init(color: Color.clear, location: 1.0)
                            ]),
                            startPoint: .top,
                            endPoint: .bottom
                        )
                        .frame(height: 80)
                    }
                )
            
            // Audio controls at bottom - same as transcript view
            sharedBottomControls
        }
    }
    
    // MARK: - Original Player View
    private func originalPlayerView(podcast: Podcast) -> some View {
        VStack(spacing: 24) {
            // Header with three-dot menu
            HStack {
                Spacer()
                
                // Three-dot menu button
                Menu {
                    Button {
                        playerViewModel.toggleLike()
                    } label: {
                        Label(playerViewModel.isLiked ? "Unlike" : "Like", 
                              systemImage: playerViewModel.isLiked ? "hand.thumbsup.fill" : "hand.thumbsup")
                    }
                    
                    Button {
                        playerViewModel.toggleDislike()
                    } label: {
                        Label(playerViewModel.isDisliked ? "Remove Dislike" : "Dislike", 
                              systemImage: playerViewModel.isDisliked ? "hand.thumbsdown.fill" : "hand.thumbsdown")
                    }
                    
                    Divider()
                    
                    Button {
                        showAddToPlaylistSheet.toggle()
                    } label: {
                        Label("Add to Playlist", systemImage: "plus.circle")
                    }
                    
                    Button {
                        playerViewModel.toggleDownload()
                    } label: {
                        if playerViewModel.isDownloading {
                            Label("Downloading...", systemImage: "arrow.down.circle")
                        } else {
                            Label(playerViewModel.isDownloaded ? "Downloaded" : "Download", 
                                  systemImage: playerViewModel.isDownloaded ? "checkmark.circle.fill" : "arrow.down.circle")
                        }
                    }
                    .disabled(playerViewModel.isDownloading)
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.title2)
                        .foregroundColor(.white)
                }
            }
            .padding(.horizontal)
            
            // Podcast artwork - use current image URL from PlayerViewModel or fallback to podcast image
            ZStack(alignment: .bottomLeading) {
                Group {
                    if !playerViewModel.currentImageUrl.isEmpty {
                        AsyncImage(url: URL(string: playerViewModel.currentImageUrl)) { image in
                            image
                                .resizable()
                                .aspectRatio(contentMode: .fill)
                        } placeholder: {
                            RoundedRectangle(cornerRadius: 16)
                                .fill(Color.gray.opacity(0.3))
                                .overlay(
                                    Image(systemName: "music.note")
                                        .font(.system(size: 40))
                                        .foregroundColor(.gray)
                                )
                        }
                        .id("current-image-\(playerViewModel.currentImageUrl)")
                    } else {
                        PersistentPodcastImageView(
                            podcast: podcast,
                            imageLoader: podcastImageLoader
                        )
                        .id("podcast-image-\(podcast.id)")
                    }
                }
                .frame(width: 320, height: 320)
                .clipShape(RoundedRectangle(cornerRadius: 16))
                .shadow(color: .black.opacity(0.3), radius: 20, x: 0, y: 10)
                
                if !playerViewModel.isPlayingTransition && !podcast.link.isEmpty && podcast.link.hasPrefix("http") {
                    Button {
                        if let url = URL(string: podcast.link) {
                            UIApplication.shared.open(url)
                        }
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "link")
                                .font(.caption)
                            Text("View Source")
                                .font(.caption)
                                .fontWeight(.medium)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(Color.black.opacity(0.7))
                        .foregroundColor(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                        .shadow(color: .black.opacity(0.3), radius: 4, x: 0, y: 2)
                    }
                    .buttonStyle(PlainButtonStyle())
                    .padding(10) // padding from edges
                }
            }
            
            // Podcast info - use current title and host from PlayerViewModel
            VStack(spacing: 8) {
                Text(playerViewModel.currentTitle.isEmpty ? podcast.title : playerViewModel.currentTitle)
                    .font(.title2)
                    .fontWeight(.semibold)
                    .multilineTextAlignment(.center)
                    .foregroundColor(.white)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.vertical, 10)
                
                Text(playerViewModel.currentHost.isEmpty ? formatRelativeTime(from: podcast.publishedAt) : playerViewModel.currentHost)
                    .font(.subheadline)
                    .foregroundColor(.white.opacity(0.8))
            }
            
            Spacer()
            
            // Use shared bottom controls for consistent positioning
            sharedBottomControls
        }
        .padding(.top)
    }
    
    private func extractColorsFromImage(podcast: Podcast) {
        // Prevent multiple simultaneous extractions for the same podcast
        let extractionKey = "extraction-\(podcast.id)"
        if UserDefaults.standard.bool(forKey: extractionKey) {
            return
        }
        
        // Mark extraction as in progress
        UserDefaults.standard.set(true, forKey: extractionKey)
        
        // Track if extraction was successful to prevent retries
        var extractionSucceeded = false
        
        // Function to attempt color extraction
        func attemptExtraction() -> Bool {
            if let imageData = podcastImageLoader.getImageData(for: podcast.imageUrl) {
                let extractedColors = ImageColorExtractor.extractDominantColors(from: imageData)
                // Make colors darker and more muted for better contrast with white text
                let darkerColors = extractedColors.map { color in
                    let uiColor = UIColor(color)
                    var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
                    uiColor.getRed(&r, green: &g, blue: &b, alpha: &a)
                    
                    // Reduce brightness by 60% and increase saturation slightly
                    let darkerR = r * 0.4
                    let darkerG = g * 0.4
                    let darkerB = b * 0.4
                    
                    return Color(red: darkerR, green: darkerG, blue: darkerB)
                }
                DispatchQueue.main.async {
                    self.extractedColors = darkerColors
                    // Mark extraction as complete and successful
                    UserDefaults.standard.set(false, forKey: extractionKey)
                    extractionSucceeded = true
                }
                return true
            } else {
                // Trigger image loading if not already in cache
                if !podcastImageLoader.isLoading(for: podcast.imageUrl) && !podcastImageLoader.hasError(for: podcast.imageUrl) {
                    podcastImageLoader.loadImage(for: podcast.imageUrl)
                }
            }
            return false
        }
        
        // Try immediate extraction first
        if attemptExtraction() {
            return
        }
        
        // Retry multiple times with increasing delays
        let retryDelays: [Double] = [0.5, 1.0, 2.0, 3.0]
        
        for (index, delay) in retryDelays.enumerated() {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                // Skip if extraction already succeeded or if a different podcast is now playing
                if extractionSucceeded || podcast.id != self.playerViewModel.currentPodcast?.id {
                    UserDefaults.standard.set(false, forKey: extractionKey)
                    return
                }
                
                if attemptExtraction() {
                    return
                }
                
                if index == retryDelays.count - 1 {
                    UserDefaults.standard.set(false, forKey: extractionKey)
                }
            }
        }
    }
    
    private func extractColorsFromTransitionImage(url: String) {
        // Prevent multiple simultaneous extractions for the same URL
        let extractionKey = "extraction-transition-\(url)"
        if UserDefaults.standard.bool(forKey: extractionKey) {
            return
        }
        
        // Mark extraction as in progress
        UserDefaults.standard.set(true, forKey: extractionKey)
        
        guard let imageUrl = URL(string: url) else {
            UserDefaults.standard.set(false, forKey: extractionKey)
            return
        }
        
        URLSession.shared.dataTask(with: imageUrl) { data, _, _ in
            DispatchQueue.main.async {
                UserDefaults.standard.set(false, forKey: extractionKey)
                
                if let data = data {
                    let extractedColors = ImageColorExtractor.extractDominantColors(from: data)
                    // Make colors darker and more muted for better contrast with white text
                    let darkerColors = extractedColors.map { color in
                        let uiColor = UIColor(color)
                        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
                        uiColor.getRed(&r, green: &g, blue: &b, alpha: &a)
                        
                        // Reduce brightness by 60% and increase saturation slightly
                        let darkerR = r * 0.4
                        let darkerG = g * 0.4
                        let darkerB = b * 0.4
                        
                        return Color(red: darkerR, green: darkerG, blue: darkerB)
                    }
                    
                    self.extractedColors = darkerColors
                }
            }
        }.resume()
    }
    
    private func generatePodcastFromLocation() {
        locationManager.requestLocation { coordinates in
            playerViewModel.generatePodcast(location: coordinates, force: true)
        }
    }
    
    // MARK: - Custom Progress Bar Component
    private func customProgressBar() -> some View {
        VStack(spacing: 8) {
            GeometryReader { geo in
                let geoWidth = max(geo.size.width, 1)
                let duration = max(playerViewModel.duration, 0.1)
                
                // Improved progress calculation with better state management
                let currentProgress: Double = {
                    if isDragging {
                        return dragPosition
                    } else if progressBarNeedsReset {
                        // If we need to reset but weren't dragging, reset now
                        DispatchQueue.main.async {
                            dragPosition = 0
                            progressBarNeedsReset = false
                        }
                        return 0
                    } else {
                        return playerViewModel.currentTime / duration
                    }
                }()
                
                let barWidth = max(0, min(currentProgress, 1.0) * geoWidth)

                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Color.white.opacity(0.3))
                        .frame(height: 6)

                    Capsule()
                        .fill(Color.white)
                        .frame(width: barWidth, height: 6)
                }
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { value in
                            if !isDragging {
                                isDragging = true
                                // Clear any pending reset when starting to drag
                                progressBarNeedsReset = false
                            }
                            let percent = min(max(0, value.location.x / geoWidth), 1)
                            dragPosition = percent
                        }
                        .onEnded { value in
                            let percent = min(max(0, value.location.x / geoWidth), 1)
                            let seekTime = percent * duration
                            playerViewModel.seek(to: seekTime)
                            
                            // Delay setting isDragging to false to prevent jumping
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                                isDragging = false
                                // If we had a pending reset, apply it now
                                if progressBarNeedsReset {
                                    dragPosition = 0
                                    progressBarNeedsReset = false
                                }
                            }
                        }
                )
            }
            .frame(height: 20)
            
            // Time labels
            HStack {
                Text(playerViewModel.formatTime(isDragging ? dragPosition * playerViewModel.duration : playerViewModel.currentTime))
                    .font(.caption)
                    .foregroundColor(.white.opacity(0.8))

                Spacer()

                Text(playerViewModel.formatTime(playerViewModel.duration))
                    .font(.caption)
                    .foregroundColor(.white.opacity(0.8))
            }
        }
    }
    
    // MARK: - Compact Progress Bar Component
    private func compactProgressBar() -> some View {
        VStack(spacing: 6) {
            GeometryReader { geo in
                let geoWidth = max(geo.size.width, 1)
                let duration = max(playerViewModel.duration, 0.1)
                
                // Same improved logic as the regular progress bar
                let currentProgress: Double = {
                    if isDragging {
                        return dragPosition
                    } else if progressBarNeedsReset {
                        // If we need to reset but weren't dragging, reset now
                        DispatchQueue.main.async {
                            dragPosition = 0
                            progressBarNeedsReset = false
                        }
                        return 0
                    } else {
                        return playerViewModel.currentTime / duration
                    }
                }()
                
                let barWidth = max(0, min(currentProgress, 1.0) * geoWidth)

                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Color.white.opacity(0.3))
                        .frame(height: 4)

                    Capsule()
                        .fill(Color.white)
                        .frame(width: barWidth, height: 4)
                }
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { value in
                            if !isDragging {
                                isDragging = true
                                // Clear any pending reset when starting to drag
                                progressBarNeedsReset = false
                            }
                            let percent = min(max(0, value.location.x / geoWidth), 1)
                            dragPosition = percent
                        }
                        .onEnded { value in
                            let percent = min(max(0, value.location.x / geoWidth), 1)
                            let seekTime = percent * duration
                            playerViewModel.seek(to: seekTime)
                            
                            // Delay setting isDragging to false to prevent jumping
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                                isDragging = false
                                // If we had a pending reset, apply it now
                                if progressBarNeedsReset {
                                    dragPosition = 0
                                    progressBarNeedsReset = false
                                }
                            }
                        }
                )
            }
            .frame(height: 16)
            
            // Time labels - smaller
            HStack {
                Text(playerViewModel.formatTime(isDragging ? dragPosition * playerViewModel.duration : playerViewModel.currentTime))
                    .font(.caption2)
                    .foregroundColor(.white.opacity(0.8))

                Spacer()

                Text(playerViewModel.formatTime(playerViewModel.duration))
                    .font(.caption2)
                    .foregroundColor(.white.opacity(0.8))
            }
        }
    }
}

// MARK: - Persistent Image Loading Components
class PodcastImageLoader: ObservableObject {
    @Published private var imageCache: [String: Data] = [:]
    @Published private var loadingStates: [String: Bool] = [:]
    @Published private var errorStates: [String: Bool] = [:]
    
    private var tasks: [String: URLSessionDataTask] = [:]
    
    init() {
    }
    
    deinit {
        cancelAllTasks()
    }
    
    func getImageData(for url: String) -> Data? {
        return imageCache[url]
    }
    
    func isLoading(for url: String) -> Bool {
        return loadingStates[url] ?? false
    }
    
    func hasError(for url: String) -> Bool {
        return errorStates[url] ?? false
    }
    
    func loadImage(for url: String) {
        // If already cached or loading, don't reload
        if imageCache[url] != nil || isLoading(for: url) {
            return
        }
        
        guard let imageUrl = URL(string: url) else {
            errorStates[url] = true
            return
        }
        
        loadingStates[url] = true
        errorStates[url] = false
        let task = URLSession.shared.dataTask(with: imageUrl) { [weak self] data, response, error in
            DispatchQueue.main.async {
                self?.loadingStates[url] = false
                
                if error != nil {
                    self?.errorStates[url] = true
                    return
                }
                
                guard let data = data else {
                    self?.errorStates[url] = true
                    return
                }
                
                self?.imageCache[url] = data
                self?.errorStates[url] = false
            }
        }
        
        tasks[url] = task
        task.resume()
    }
    
    private func cancelAllTasks() {
        for task in tasks.values {
            task.cancel()
        }
        tasks.removeAll()
    }
}

struct PersistentPodcastImageView: View {
    let podcast: Podcast
    @ObservedObject var imageLoader: PodcastImageLoader
    
    init(podcast: Podcast, imageLoader: PodcastImageLoader) {
        self.podcast = podcast
        self.imageLoader = imageLoader
    }
    
    var body: some View {
        Group {
            if let imageData = imageLoader.getImageData(for: podcast.imageUrl),
               let uiImage = UIImage(data: imageData) {
                Image(uiImage: uiImage)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .onAppear {}
            } else if imageLoader.isLoading(for: podcast.imageUrl) {
                RoundedRectangle(cornerRadius: 16)
                    .fill(Color.gray.opacity(0.3))
                    .overlay(ProgressView())
                    .onAppear {}
            } else if imageLoader.hasError(for: podcast.imageUrl) {
                RoundedRectangle(cornerRadius: 16)
                    .fill(Color.gray.opacity(0.3))
                    .overlay(
                        VStack {
                            Image(systemName: "exclamationmark.triangle")
                                .font(.system(size: 20))
                                .foregroundColor(.red)
                            Text("Image failed to load")
                                .font(.caption2)
                                .foregroundColor(.red)
                        }
                    )
                    .onAppear {}
            } else {
                RoundedRectangle(cornerRadius: 16)
                    .fill(Color.gray.opacity(0.3))
                    .overlay(
                        Image(systemName: "music.note")
                            .font(.system(size: 40))
                            .foregroundColor(.gray)
                    )
                    .onAppear {
                        imageLoader.loadImage(for: podcast.imageUrl)
                    }
            }
        }
        .onAppear {}
        .onDisappear {}
        .onChange(of: podcast.imageUrl) { newUrl in
            imageLoader.loadImage(for: newUrl)
        }
    }
}

// MARK: - Location Manager
class LocationManager: NSObject, ObservableObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var completion: (([Double]?) -> Void)?
    
    override init() {
        super.init()
        manager.delegate = self
    }
    
    func requestLocation(completion: @escaping ([Double]?) -> Void) {
        self.completion = completion
        
        switch manager.authorizationStatus {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse, .authorizedAlways:
            manager.requestLocation()
        default:
            completion(nil) // Use default location
        }
    }
    
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.first else {
            completion?(nil)
            return
        }
        
        let coordinates = [location.coordinate.latitude, location.coordinate.longitude]
        completion?(coordinates)
        completion = nil
    }
    
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        completion?(nil)
        completion = nil
    }
    
    func locationManager(_ manager: CLLocationManager, didChangeAuthorization status: CLAuthorizationStatus) {
        if status == .authorizedWhenInUse || status == .authorizedAlways {
            manager.requestLocation()
        } else if status == .denied || status == .restricted {
            completion?(nil)
            completion = nil
        }
    }
}

#Preview {
    PlayerView()
        .environmentObject(PlayerViewModel())
}

// MARK: - Playlist Sheet View
struct PlaylistSheet: View {
    let currentPodcastId: String
    @Environment(\.dismiss) private var dismiss
    @StateObject private var viewModel = PlaylistViewModel()
    @EnvironmentObject private var playerViewModel: PlayerViewModel
    @State private var selectedPlaylistId: String?
    
    var body: some View {
        NavigationView {
            VStack(spacing: 0) {
                if let selectedPlaylistId = selectedPlaylistId {
                    // Show playlist items
                    PlaylistItemsView(
                        playlistId: selectedPlaylistId,
                        playlistName: viewModel.playlists.first { $0.id == selectedPlaylistId }?.name ?? "Playlist",
                        onBack: { self.selectedPlaylistId = nil }
                    )
                } else {
                    // Show playlists list and recommendations
                    ScrollView {
                        LazyVStack(spacing: 16) {
                            // Playlists Section
                            if !viewModel.playlists.isEmpty {
                                VStack(alignment: .leading, spacing: 12) {
                                    HStack {
                                        Text("Your Playlists")
                                            .font(.title2)
                                            .fontWeight(.bold)
                                        
                                        Spacer()
                                        
                                        if viewModel.isLoadingPlaylists {
                                            ProgressView()
                                                .scaleEffect(0.8)
                                        }
                                    }
                                    
                                    ForEach(viewModel.playlists) { playlist in
                                        PlaylistRowView(playlist: playlist) {
                                            selectedPlaylistId = playlist.id
                                        }
                                    }
                                }
                                .padding(.horizontal)
                            }
                            
                            // Up Next Section (Recommendations)
                            if !viewModel.recommendations.isEmpty {
                                VStack(alignment: .leading, spacing: 12) {
                                    HStack {
                                        Text("Up Next")
                                            .font(.title2)
                                            .fontWeight(.bold)
                                        
                                        Spacer()
                                        
                                        if viewModel.isLoadingRecommendations {
                                            ProgressView()
                                                .scaleEffect(0.8)
                                        }
                                    }
                                    
                                    ForEach(viewModel.recommendations) { podcast in
                                        RecommendationRowView(podcast: podcast, allRecommendations: viewModel.recommendations)
                                    }
                                }
                                .padding(.horizontal)
                            }
                            
                            if viewModel.playlists.isEmpty && viewModel.recommendations.isEmpty && !viewModel.isLoading {
                                VStack(spacing: 12) {
                                    Image(systemName: "music.note.list")
                                        .font(.system(size: 40))
                                        .foregroundColor(.gray)
                                    
                                    Text("No playlists or recommendations available")
                                        .font(.subheadline)
                                        .foregroundColor(.gray)
                                        .multilineTextAlignment(.center)
                                }
                                .padding()
                            }
                        }
                        .padding(.vertical)
                    }
                }
            }
            .navigationTitle("Playlists")
            .navigationBarTitleDisplayMode(.inline)
            
        }
        .onAppear {
            viewModel.loadData(currentPodcastId: currentPodcastId, cachedRecommendations: playerViewModel.persistentRecommendations)
        }
    }
}

// MARK: - Playlist Row View
struct PlaylistRowView: View {
    let playlist: Playlist
    let onTap: () -> Void
    
    var body: some View {
        Button(action: onTap) {
            HStack {
                Image(systemName: "music.note.list")
                    .font(.title2)
                    .foregroundColor(Color.accentColor)
                    .frame(width: 40, height: 40)
                    .background(Color.accentColor.opacity(0.1))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                
                VStack(alignment: .leading, spacing: 4) {
                    Text(playlist.name)
                        .font(.headline)
                        .foregroundColor(.white)
                    
                    Text(playlist.description)
                        .font(.caption)
                        .foregroundColor(.gray.opacity(0.8))
                        .lineLimit(1)
                }
                
                Spacer()
                
                Image(systemName: "chevron.right")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            .padding()
        }
        .buttonStyle(PlainButtonStyle())
    }
}

// MARK: - Recommendation Row View
struct RecommendationRowView: View {
    let podcast: PodcastCard
    @EnvironmentObject private var playerViewModel: PlayerViewModel
    let allRecommendations: [PodcastCard]
    
    var body: some View {
        let isCurrent = playerViewModel.currentPodcast?.id == podcast.id
        Button {
            // Set the recommendations as the current queue and start playing from the selected podcast
            let podcastIndex = allRecommendations.firstIndex { $0.id == podcast.id } ?? 0
            playerViewModel.setQueue(allRecommendations, startingAt: podcastIndex, fromExternalSelection: false)
        } label: {
            HStack {
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
                .frame(width: 50, height: 50)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                
                VStack(alignment: .leading, spacing: 4) {
                    Text(podcast.title)
                        .font(.subheadline)
                        .fontWeight(.medium)
                        .foregroundColor(.white)
                        .lineLimit(2)
                    
                    Text(formatRelativeTime(from: podcast.publishedAt))
                        .font(.caption)
                        .foregroundColor(.gray)
                }
                
                Spacer()
                
                Image(systemName: "play.circle")
                    .font(.title2)
                    .foregroundColor(Color.accentColor)
            }
            .padding()
            .background(isCurrent ? Color.accentColor.opacity(0.25) : Color.clear)
            .cornerRadius(10)
        }
        .buttonStyle(PlainButtonStyle())
    }
    
    private func formatDuration(_ seconds: Double) -> String {
        let minutes = Int(seconds) / 60
        return "\(minutes) min"
    }
}

// MARK: - Playlist Items View
struct PlaylistItemsView: View {
    let playlistId: String
    let playlistName: String
    let onBack: () -> Void
    @StateObject private var viewModel = PlaylistItemsViewModel()
    @EnvironmentObject private var playerViewModel: PlayerViewModel
    
    var body: some View {
        VStack {
            ScrollView {
                LazyVStack(spacing: 12) {
                    ForEach(viewModel.items) { item in
                        PlaylistItemRowView(
                            item: item, 
                            allItems: viewModel.items,
                            playlistId: playlistId,
                            onRemove: { id in
                                viewModel.removeItem(id: id)
                            }
                        )
                    }
                    
                    if viewModel.items.isEmpty && !viewModel.isLoading {
                        VStack(spacing: 12) {
                            Image(systemName: "music.note")
                                .font(.system(size: 40))
                                .foregroundColor(.gray)
                            
                            Text("This playlist is empty")
                                .font(.subheadline)
                                .foregroundColor(.gray)
                        }
                        .padding()
                    }
                }
                .padding()
            }
        }
        .navigationTitle(playlistName)
        .navigationBarTitleDisplayMode(.large)
        .onAppear {
            viewModel.loadItems(playlistId: playlistId)
        }
    }
}

// MARK: - Playlist Item Row View
struct PlaylistItemRowView: View {
    let item: PlaylistItem
    let allItems: [PlaylistItem]
    let playlistId: String
    let onRemove: (String) -> Void
    @EnvironmentObject private var playerViewModel: PlayerViewModel
    
    var body: some View {
        let isCurrent = playerViewModel.currentPodcast?.id == item.id
        
        HStack {
            Button {
                // Convert PlaylistItems to PodcastCards for queue management
                let podcastCards = allItems.map { item in
                    PodcastCard(
                        id: item.id,
                        title: item.title,
                        imageUrl: item.imageUrl,
                        durationSeconds: item.durationSeconds
                    )
                }
                
                // Set the playlist as the current queue and start playing from the selected item
                let itemIndex = allItems.firstIndex { $0.id == item.id } ?? 0
                playerViewModel.setQueue(podcastCards, startingAt: itemIndex, fromExternalSelection: true)
            } label: {
                HStack {
                    AsyncImage(url: URL(string: item.imageUrl)) { image in
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
                    .frame(width: 50, height: 50)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    
                    VStack(alignment: .leading, spacing: 4) {
                        Text(item.title)
                            .font(.subheadline)
                            .fontWeight(.medium)
                            .foregroundColor(.white)
                            .lineLimit(2)
                        
                        Text(formatDuration(item.durationSeconds))
                            .font(.caption)
                            .foregroundColor(.gray)
                    }
                    
                    Spacer()
                    
                    Image(systemName: "play.circle")
                        .font(.title2)
                        .foregroundColor(Color.accentColor)
                }
            }
            .buttonStyle(PlainButtonStyle())
            
            // Remove button
            Button {
                onRemove(item.id)
            } label: {
                Image(systemName: "minus.circle.fill")
                    .font(.title2)
                    .foregroundColor(.red)
            }
            .buttonStyle(PlainButtonStyle())
        }
        .padding()
        .background(isCurrent ? Color.accentColor.opacity(0.25) : Color.clear)
        .cornerRadius(10)
    }
    
    private func formatDuration(_ seconds: Double) -> String {
        let minutes = Int(seconds) / 60
        return "\(minutes) min"
    }
}

// MARK: - Playlist View Model
class PlaylistViewModel: ObservableObject {
    // Simple in-memory cache shared across instances to speed up sheet opening
    static var cachedPlaylists: [Playlist] = []
    
    @Published var playlists: [Playlist] = []
    @Published var recommendations: [PodcastCard] = []
    @Published var isLoadingPlaylists = false
    @Published var isLoadingRecommendations = false
    
    private let graphQLService = GraphQLService.shared
    private var cancellables = Set<AnyCancellable>()
    
    var isLoading: Bool {
        isLoadingPlaylists || isLoadingRecommendations
    }
    
    func updatePlaylists() {
        loadPlaylists()
    }

    func loadData(currentPodcastId: String, cachedRecommendations: [PodcastCard]? = nil, forcePlaylistRefresh: Bool = false) {
        if forcePlaylistRefresh || PlaylistViewModel.cachedPlaylists.isEmpty {
            loadPlaylists()
        } else {
            // Serve cached instantly without triggering network
            self.playlists = PlaylistViewModel.cachedPlaylists
            self.isLoadingPlaylists = false
        }
        if let cached = cachedRecommendations, !cached.isEmpty {
            self.recommendations = cached
        } else {
            loadRecommendations(podcastId: currentPodcastId)
        }
    }
    
    private func loadPlaylists() {
        // If cache exists, show instantly without spinner
        if !PlaylistViewModel.cachedPlaylists.isEmpty {
            self.playlists = PlaylistViewModel.cachedPlaylists
            isLoadingPlaylists = false
        } else {
            isLoadingPlaylists = true
        }
        
        graphQLService.getPlaylists()
            .receive(on: DispatchQueue.main)
            .sink(
                receiveCompletion: { [weak self] completion in
                    self?.isLoadingPlaylists = false
                    if case .failure(_) = completion {
                    }
                },
                receiveValue: { [weak self] playlists in
                    self?.playlists = playlists
                    // Update cache
                    PlaylistViewModel.cachedPlaylists = playlists
                }
            )
            .store(in: &cancellables)
    }
    
    private func loadRecommendations(podcastId: String) {
        isLoadingRecommendations = true
        
        graphQLService.getRecommendations(podcastId: podcastId)
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
    
    func deletePlaylist(playlistId: String) {
        graphQLService.deletePlaylist(playlistId: playlistId)
            .receive(on: DispatchQueue.main)
            .sink(
                receiveCompletion: { completion in
                    if case .failure(_) = completion {
                    }
                },
                receiveValue: { [weak self] _ in
                    // Remove from local array
                    self?.playlists.removeAll { $0.id == playlistId }
                }
            )
            .store(in: &cancellables)
    }
    
    // MARK: - Static prefetch helper
    static func prefetchPlaylistsIfNeeded() {
        guard cachedPlaylists.isEmpty else { return }
        
        let service = GraphQLService.shared
        service.getPlaylists()
            .receive(on: DispatchQueue.main)
            .sink(
                receiveCompletion: { completion in
                    // Ignore errors for silent prefetch
                },
                receiveValue: { playlists in
                    PlaylistViewModel.cachedPlaylists = playlists
                }
            )
            .cancel() // fire-and-forget
    }
}

// MARK: - Playlist Items View Model
class PlaylistItemsViewModel: ObservableObject {
    @Published var items: [PlaylistItem] = []
    @Published var isLoading = false
    
    private let graphQLService = GraphQLService.shared
    private var cancellables = Set<AnyCancellable>()
    private var currentPlaylistId: String?
    
    func loadItems(playlistId: String) {
        currentPlaylistId = playlistId
        isLoading = true
        
        graphQLService.getPlaylistItems(playlistId: playlistId)
            .receive(on: DispatchQueue.main)
            .sink(
                receiveCompletion: { [weak self] completion in
                    self?.isLoading = false
                    if case .failure(_) = completion {
                    }
                },
                receiveValue: { [weak self] items in
                    self?.items = items
                }
            )
            .store(in: &cancellables)
    }
    
    func removeItem(id: String) {
        guard let playlistId = currentPlaylistId else { return }
        
        graphQLService.removeFromPlaylist(playlistId: playlistId, podcastId: id)
            .receive(on: DispatchQueue.main)
            .sink(
                receiveCompletion: { completion in
                    if case .failure(_) = completion {
                    }
                },
                receiveValue: { [weak self] _ in
                    // Remove from local array on success
                    self?.items.removeAll { $0.id == id }
                }
            )
            .store(in: &cancellables)
    }
}

// MARK: - Add to Playlist Sheet
struct AddToPlaylistSheet: View {
    let currentPodcastId: String
    @Environment(\.dismiss) private var dismiss
    @StateObject private var viewModel = PlaylistViewModel()
    @EnvironmentObject private var playerViewModel: PlayerViewModel
    @State private var showCreatePlaylist = false
    @State private var newPlaylistName = ""
    @State private var newPlaylistDescription = ""
    @State private var showDeleteAlert = false
    @State private var playlistToDelete: Playlist?
    
    var body: some View {
        NavigationView {
            VStack {
                if viewModel.isLoading {
                    ProgressView("Loading playlists...")
                        .padding()
                } else {
                    VStack(spacing: 16) {
                        // Create new playlist button
                        Button {
                            showCreatePlaylist = true
                        } label: {
                            HStack {
                                Image(systemName: "plus.circle.fill")
                                    .font(.title2)
                                    .foregroundColor(.green)
                                    .frame(width: 40, height: 40)
                                    .background(Color.green.opacity(0.1))
                                    .clipShape(RoundedRectangle(cornerRadius: 8))
                                
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("Create New Playlist")
                                        .font(.headline)
                                        .foregroundColor(.primary)
                                    
                                    Text("Add a new playlist")
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                }
                                
                                Spacer()
                            }
                            .padding()
                            .background(Color.green.opacity(0.05))
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                        }
                        .buttonStyle(PlainButtonStyle())
                        .padding(.horizontal)
                        
                        if viewModel.playlists.isEmpty {
                            VStack(spacing: 12) {
                                Image(systemName: "music.note.list")
                                    .font(.system(size: 40))
                                    .foregroundColor(.gray)
                                
                                Text("No playlists available")
                                    .font(.subheadline)
                                    .foregroundColor(.secondary)
                                
                                Text("Create your first playlist above")
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                            }
                            .padding()
                        } else {
                            List {
                                ForEach(viewModel.playlists) { playlist in
                                    HStack {
                                        Button {
                                            playerViewModel.addCurrentPodcastToPlaylist(playlistId: playlist.id)
                                            // Refresh playlists to reflect potential server-side changes before closing
                                            viewModel.loadData(currentPodcastId: currentPodcastId, cachedRecommendations: nil, forcePlaylistRefresh: true)
                                            dismiss()
                                        } label: {
                                            HStack {
                                                Image(systemName: "music.note.list")
                                                    .font(.title2)
                                                    .foregroundColor(Color.accentColor)
                                                    .frame(width: 40, height: 40)
                                                    .background(Color.accentColor.opacity(0.1))
                                                    .clipShape(RoundedRectangle(cornerRadius: 8))
                                                
                                                VStack(alignment: .leading, spacing: 4) {
                                                    Text(playlist.name)
                                                        .font(.headline)
                                                        .foregroundColor(.primary)
                                                    
                                                    Text(playlist.description)
                                                        .font(.caption)
                                                        .foregroundColor(.secondary)
                                                        .lineLimit(1)
                                                }
                                                
                                                Spacer()
                                                
                                                Image(systemName: "plus.circle")
                                                    .font(.title2)
                                                    .foregroundColor(Color.accentColor)
                                            }
                                            .padding(.vertical, 4)
                                        }
                                        .buttonStyle(PlainButtonStyle())
                                        
                                        // Delete button
                                        Button {
                                            playlistToDelete = playlist
                                            showDeleteAlert = true
                                        } label: {
                                            Image(systemName: "trash")
                                                .font(.title3)
                                                .foregroundColor(.red)
                                        }
                                        .buttonStyle(PlainButtonStyle())
                                    }
                                }
                            }
                        }
                    }
                }
                
                Spacer()
            }
            .navigationTitle("Add to Playlist")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        viewModel.updatePlaylists()
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .disabled(viewModel.isLoading)
                }
            }
            .task {
                // Always load playlists when sheet appears
                viewModel.updatePlaylists()
            }
            .sheet(isPresented: $showCreatePlaylist) {
                CreatePlaylistSheet(
                    onPlaylistCreated: { 
                        viewModel.updatePlaylists()
                    }
                )
            }
            .alert("Delete Playlist", isPresented: $showDeleteAlert) {
                Button("Cancel", role: .cancel) { }
                Button("Delete", role: .destructive) {
                    if let playlist = playlistToDelete {
                        viewModel.deletePlaylist(playlistId: playlist.id)
                        playlistToDelete = nil
                    }
                }
            } message: {
                if let playlist = playlistToDelete {
                    Text("Are you sure you want to delete '\(playlist.name)'? This action cannot be undone.")
                }
            }
        }
    }
}

// MARK: - Create Playlist Sheet
struct CreatePlaylistSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var description = ""
    @State private var isCreating = false
    @State private var errorMessage: String?
    @State private var cancellables = Set<AnyCancellable>()
    let onPlaylistCreated: () -> Void
    
    private let graphQLService = GraphQLService.shared
    
    var body: some View {
        NavigationView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Playlist Name")
                        .font(.headline)
                    
                    TextField("Enter playlist name", text: $name)
                        .textFieldStyle(RoundedBorderTextFieldStyle())
                }
                
                VStack(alignment: .leading, spacing: 8) {
                    Text("Description (Optional)")
                        .font(.headline)
                    
                    TextField("Enter description", text: $description)
                        .textFieldStyle(RoundedBorderTextFieldStyle())
                }
                
                if let errorMessage = errorMessage {
                    Text(errorMessage)
                        .foregroundColor(.red)
                        .font(.caption)
                }
                
                Spacer()
            }
            .padding()
            .navigationTitle("New Playlist")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Cancel") {
                        dismiss()
                    }
                    .disabled(isCreating)
                }
                
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Create") {
                        createPlaylist()
                    }
                    .disabled(name.isEmpty || isCreating)
                }
            }
        }
    }
    
    private func createPlaylist() {
        isCreating = true
        errorMessage = nil
        
        graphQLService.createPlaylist(name: name, description: description.isEmpty ? nil : description)
            .receive(on: DispatchQueue.main)
            .sink(
                receiveCompletion: { completion in
                    isCreating = false
                    if case .failure(let error) = completion {
                        errorMessage = "Failed to create playlist: \(error.localizedDescription)"
                    }
                },
                receiveValue: { _ in
                    onPlaylistCreated()
                    dismiss()
                }
            )
            .store(in: &cancellables)
    }
}

// MARK: - Transcript Models (formerly Lyrics)
struct TranscriptLine {
    let timestamp: TimeInterval
    let text: String
}

struct SynchronizedTranscript {
    let lines: [TranscriptLine]
    
    func currentLineIndex(for currentTime: TimeInterval) -> Int? {
        guard !lines.isEmpty else { return nil }
        
        // Find the last line that has a timestamp <= currentTime
        var currentIndex: Int?
        for (index, line) in lines.enumerated() {
            if line.timestamp <= currentTime {
                currentIndex = index
            } else {
                break
            }
        }
        
        return currentIndex
    }
    
    func nextLineIndex(for currentTime: TimeInterval) -> Int? {
        guard !lines.isEmpty else { return nil }
        
        // Find the first line that has a timestamp > currentTime
        for (index, line) in lines.enumerated() {
            if line.timestamp > currentTime {
                return index
            }
        }
        
        return nil
    }
}

// MARK: - Transcript Parser (formerly Lyrics Parser)
class SynchronizedTranscriptParser {
    static func parse(_ transcriptText: String) -> SynchronizedTranscript {
        let lines = transcriptText.components(separatedBy: .newlines)
        var transcriptLines: [TranscriptLine] = []
        
        for line in lines {
            if let parsedLine = parseLine(line.trimmingCharacters(in: .whitespacesAndNewlines)) {
                transcriptLines.append(parsedLine)
            }
        }
        
        // Sort by timestamp to ensure correct order
        transcriptLines.sort { $0.timestamp < $1.timestamp }
        
        return SynchronizedTranscript(lines: transcriptLines)
    }
    
    private static func parseLine(_ line: String) -> TranscriptLine? {
        // Match pattern [mm:ss.ff] or [m:ss.ff]
        let pattern = #"\[(\d{1,2}):(\d{2})\.(\d{2})\](.+)"#
        
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: line, range: NSRange(location: 0, length: line.count)) else {
            return nil
        }
        
        let minutesRange = Range(match.range(at: 1), in: line)
        let secondsRange = Range(match.range(at: 2), in: line)
        let centisecondsRange = Range(match.range(at: 3), in: line)
        let textRange = Range(match.range(at: 4), in: line)
        
        guard let minutesRange = minutesRange,
              let secondsRange = secondsRange,
              let centisecondsRange = centisecondsRange,
              let textRange = textRange,
              let minutes = Int(line[minutesRange]),
              let seconds = Int(line[secondsRange]),
              let centiseconds = Int(line[centisecondsRange]) else {
            return nil
        }
        
        let timestamp = TimeInterval(minutes * 60 + seconds) + TimeInterval(centiseconds) / 100.0
        let text = String(line[textRange]).trimmingCharacters(in: .whitespacesAndNewlines)
        
        return TranscriptLine(timestamp: timestamp, text: text)
    }
}

// MARK: - SynchronizedTranscriptView (formerly LyricsView)
struct SynchronizedTranscriptView: View {
    let transcriptUrl: String
    @EnvironmentObject private var playerViewModel: PlayerViewModel
    @Environment(\.dismiss) private var dismiss
    
    @State private var transcript: SynchronizedTranscript?
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
                        
                        Text("Loading transcript...")
                            .foregroundColor(.white.opacity(0.8))
                            .padding(.top, 8)
                    }
                } else if let errorMessage = errorMessage {
                    VStack(spacing: 16) {
                        Image(systemName: "doc.text")
                            .font(.system(size: 50))
                            .foregroundColor(.gray)
                        
                        Text("Transcript unavailable")
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
                } else if let transcript = transcript {
                    TranscriptScrollView(
                        transcript: transcript,
                        currentTime: playerViewModel.currentTime,
                        currentLineIndex: $currentLineIndex,
                        onSeek: { time in
                            playerViewModel.seek(to: time)
                        }
                    )
                } else {
                    VStack(spacing: 16) {
                        Image(systemName: "doc.text")
                            .font(.system(size: 50))
                            .foregroundColor(.gray)
                        
                        Text("No transcript available")
                            .font(.title2)
                            .fontWeight(.semibold)
                            .foregroundColor(.white)
                            
                        Text("Transcript will appear here when available")
                            .font(.subheadline)
                            .foregroundColor(.gray)
                    }
                }
            }
            .navigationTitle("Transcript")
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
            loadTranscript()
        }
        .onChange(of: playerViewModel.currentTime) { currentTime in
            updateCurrentLine(for: currentTime)
        }
    }
    
    private func loadTranscript() {
        guard !transcriptUrl.isEmpty else {
            errorMessage = "No transcript URL provided"
            isLoading = false
            return
        }
        
        guard let url = URL(string: transcriptUrl) else {
            errorMessage = "Invalid transcript URL"
            isLoading = false
            return
        }
        
        URLSession.shared.dataTask(with: url) { data, response, error in
            DispatchQueue.main.async {
                isLoading = false
                
                if let error = error {
                    errorMessage = "Failed to load transcript: \(error.localizedDescription)"
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
                      let transcriptText = String(data: data, encoding: .utf8) else {
                    errorMessage = "Failed to decode transcript"
                    return
                }
                
                let parsedTranscript = SynchronizedTranscriptParser.parse(transcriptText)
                
                if parsedTranscript.lines.isEmpty {
                    errorMessage = "No valid transcript found in file"
                } else {
                    transcript = parsedTranscript
                }
            }
        }.resume()
    }
    
    private func updateCurrentLine(for currentTime: TimeInterval) {
        guard let transcript = transcript else { return }
        currentLineIndex = transcript.currentLineIndex(for: currentTime)
    }
}

struct TranscriptScrollView: View {
    let transcript: SynchronizedTranscript
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
                    
                    ForEach(Array(transcript.lines.enumerated()), id: \.offset) { index, line in
                        TranscriptLineView(
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

struct TranscriptLineView: View {
    let line: TranscriptLine
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
            return .white.opacity(0.4)
        } else if isPrevious {
            return .white.opacity(0.4)
        } else {
            return .gray
        }
    }
}

// MARK: - Synchronized Transcript Content View (for inline display)
struct SynchronizedTranscriptContentView: View {
    let transcriptUrl: String
    let currentTime: TimeInterval
    let onSeek: (TimeInterval) -> Void
    
    @State private var transcript: SynchronizedTranscript?
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var currentLineIndex: Int?
    @State private var lastSuccessfulUrl: String = ""
    
    var body: some View {
        Group {
            if isLoading && transcript == nil {
                // Only show loading if we don't have any transcript yet
                VStack {
                    ProgressView()
                        .scaleEffect(1.2)
                    
                    Text("Loading transcript...")
                        .foregroundColor(.secondary)
                        .padding(.top, 8)
                }
            } else if let transcript = transcript {
                // Always show transcript if we have it, even during reloading
                TranscriptScrollView(
                    transcript: transcript,
                    currentTime: currentTime,
                    currentLineIndex: $currentLineIndex,
                    onSeek: onSeek
                )
            } else if let errorMessage = errorMessage {
                VStack(spacing: 16) {
                    Image(systemName: "doc.text")
                        .font(.system(size: 40))
                        .foregroundColor(.gray)
                    
                    Text("Transcript unavailable")
                        .font(.headline)
                        .foregroundColor(.primary)
                    
                    Text(errorMessage)
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)
                    
                    Button("Retry") {
                        loadTranscript()
                    }
                    .buttonStyle(.bordered)
                    .foregroundColor(.primary)
                }
            } else {
                VStack(spacing: 16) {
                    Image(systemName: "doc.text")
                        .font(.system(size: 40))
                        .foregroundColor(.gray)
                    
                    Text("No transcript available")
                        .font(.headline)
                        .foregroundColor(.primary)
                        
                    Text("Transcript will appear here when available")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                }
            }
        }
        .onAppear {
            if transcript == nil || lastSuccessfulUrl != transcriptUrl {
                loadTranscript()
            }
        }
        .onChange(of: currentTime) { time in
            updateCurrentLine(for: time)
        }
        .onChange(of: transcriptUrl) { newUrl in
            // Only reload if URL actually changed and is not empty
            if !newUrl.isEmpty && newUrl != lastSuccessfulUrl {
                loadTranscript()
            }
        }
    }
    
    private func loadTranscript() {
        guard !transcriptUrl.isEmpty, let url = URL(string: transcriptUrl) else {
            errorMessage = "Invalid transcript URL"
            return
        }
        
        // Don't show loading if we already have a transcript (seamless updates)
        if transcript == nil {
            isLoading = true
        }
        errorMessage = nil
        
        URLSession.shared.dataTask(with: url) { data, response, error in
            DispatchQueue.main.async {
                isLoading = false
                
                if let error = error {
                    // Only show error if we don't have existing transcript
                    if transcript == nil {
                        errorMessage = "Network error: \(error.localizedDescription)"
                    }
                    return
                }
                
                guard let data = data else {
                    if transcript == nil {
                        errorMessage = "No data received"
                    }
                    return
                }
                
                if let text = String(data: data, encoding: .utf8) {
                    let parsedTranscript = SynchronizedTranscriptParser.parse(text)
                    if parsedTranscript.lines.isEmpty {
                        if transcript == nil {
                            errorMessage = "No valid transcript found"
                        }
                    } else {
                        transcript = parsedTranscript
                        lastSuccessfulUrl = transcriptUrl
                        errorMessage = nil
                    }
                } else {
                    if transcript == nil {
                        errorMessage = "Failed to decode transcript"
                    }
                }
            }
        }.resume()
    }
    
    private func updateCurrentLine(for currentTime: TimeInterval) {
        guard let transcript = transcript else { return }
        currentLineIndex = transcript.currentLineIndex(for: currentTime)
    }
}

// MARK: - Library Content View (for inline display)
struct LibraryContentView: View {
    let currentPodcastId: String
    @StateObject private var viewModel = PlaylistViewModel()
    @EnvironmentObject private var playerViewModel: PlayerViewModel
    @State private var selectedPlaylistId: String?
    
    var body: some View {
        Group {
            if let selectedPlaylistId = selectedPlaylistId {
                // Show playlist items
                PlaylistItemsInlineView(
                    playlistId: selectedPlaylistId,
                    playlistName: viewModel.playlists.first { $0.id == selectedPlaylistId }?.name ?? "Playlist",
                    onBack: { self.selectedPlaylistId = nil }
                )
            } else {
                // Show playlists list and recommendations with auto-scroll
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 16) {
                            // Playlists Section
                            if !viewModel.playlists.isEmpty {
                                VStack(alignment: .leading, spacing: 12) {
                                    HStack {
                                        Text("Your Playlists")
                                            .font(.title2)
                                            .fontWeight(.bold)
                                            .foregroundColor(.white)
                                        
                                        Spacer()
                                        
                                        if viewModel.isLoadingPlaylists {
                                            ProgressView()
                                                .scaleEffect(0.8)
                                        }
                                    }
                                    
                                    ForEach(viewModel.playlists) { playlist in
                                        PlaylistRowView(playlist: playlist) {
                                            selectedPlaylistId = playlist.id
                                        }
                                    }
                                }
                                .padding(.horizontal)
                            }
                            
                            // Up Next Section (Recommendations)
                            if !viewModel.recommendations.isEmpty {
                                VStack(alignment: .leading, spacing: 12) {
                                    HStack {
                                        Text("Up Next")
                                            .font(.title2)
                                            .fontWeight(.bold)
                                            .foregroundColor(.white)
                                        
                                        Spacer()
                                        
                                        if viewModel.isLoadingRecommendations {
                                            ProgressView()
                                                .scaleEffect(0.8)
                                        }
                                    }
                                    
                                    ForEach(viewModel.recommendations) { podcast in
                                        RecommendationRowView(podcast: podcast, allRecommendations: viewModel.recommendations)
                                    }
                                }
                                .padding(.horizontal)
                            }
                            
                            if viewModel.playlists.isEmpty && viewModel.recommendations.isEmpty && !viewModel.isLoading {
                                VStack(spacing: 12) {
                                    Image(systemName: "music.note.list")
                                        .font(.system(size: 40))
                                        .foregroundColor(.gray)
                                    
                                    Text("No playlists or recommendations available")
                                        .font(.subheadline)
                                        .foregroundColor(.gray)
                                        .multilineTextAlignment(.center)
                                }
                                .padding()
                            }
                        }
                        .padding(.vertical)
                    }
                    .onAppear {
                        scrollToCurrentIfNeeded(proxy: proxy)
                    }
                    .onChange(of: playerViewModel.currentPodcast?.id) { _ in
                        scrollToCurrentIfNeeded(proxy: proxy)
                    }
                    .onChange(of: viewModel.recommendations) { _ in
                        scrollToCurrentIfNeeded(proxy: proxy)
                    }
                }
            }
        }
        .onAppear {
            viewModel.loadData(currentPodcastId: currentPodcastId, cachedRecommendations: playerViewModel.persistentRecommendations)
        }
        // Keep recommendations in sync live
        .onReceive(playerViewModel.$persistentRecommendations) { newRecs in
            viewModel.recommendations = newRecs
        }
    }
    
    // Helper to scroll to the currently playing podcast if it exists in recommendations
    private func scrollToCurrentIfNeeded(proxy: ScrollViewProxy) {
        guard let currentId = playerViewModel.currentPodcast?.id else { return }
        if viewModel.recommendations.contains(where: { $0.id == currentId }) {
            withAnimation {
                proxy.scrollTo(currentId, anchor: .center)
            }
        }
    }
}

// MARK: - Playlist Items Inline View
struct PlaylistItemsInlineView: View {
    let playlistId: String
    let playlistName: String
    let onBack: () -> Void
    @StateObject private var viewModel = PlaylistItemsViewModel()
    @EnvironmentObject private var playerViewModel: PlayerViewModel
    
    var body: some View {
        VStack(spacing: 0) {
            // Back button header
            HStack {
                Button {
                    onBack()
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.left")
                            .font(.title3)
                        Text("Back")
                            .font(.body)
                    }
                }
                .foregroundColor(Color.accentColor)
                
                Spacer()
                
                Text(playlistName)
                    .font(.headline)
                    .fontWeight(.semibold)
                    .foregroundColor(.white)
                
                Spacer()
                
                // Empty space to balance the back button
                HStack(spacing: 4) {
                    Image(systemName: "chevron.left")
                        .font(.title3)
                    Text("Back")
                        .font(.body)
                }
                .opacity(0) // Invisible but takes up space
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            
            ScrollView {
                LazyVStack(spacing: 12) {
                    ForEach(viewModel.items) { item in
                        PlaylistItemRowView(
                            item: item, 
                            allItems: viewModel.items,
                            playlistId: playlistId,
                            onRemove: { id in
                                viewModel.removeItem(id: id)
                            }
                        )
                    }
                    
                    if viewModel.items.isEmpty && !viewModel.isLoading {
                        VStack(spacing: 12) {
                            Image(systemName: "music.note")
                                .font(.system(size: 40))
                                .foregroundColor(.gray)
                            
                            Text("This playlist is empty")
                                .font(.subheadline)
                                .foregroundColor(.gray)
                        }
                        .padding()
                    }
                }
                .padding()
            }
        }
        .onAppear {
            viewModel.loadItems(playlistId: playlistId)
        }
    }
} 

 