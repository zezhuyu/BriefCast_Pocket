import Foundation

// MARK: - Lyrics Models
struct LyricsLine {
    let timestamp: TimeInterval
    let text: String
}

struct Lyrics {
    let lines: [LyricsLine]
    
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

// MARK: - Lyrics Parser
class LyricsParser {
    static func parse(_ lyricsText: String) -> Lyrics {
        let lines = lyricsText.components(separatedBy: .newlines)
        var lyricsLines: [LyricsLine] = []
        
        for line in lines {
            if let parsedLine = parseLine(line.trimmingCharacters(in: .whitespacesAndNewlines)) {
                lyricsLines.append(parsedLine)
            }
        }
        
        // Sort by timestamp to ensure correct order
        lyricsLines.sort { $0.timestamp < $1.timestamp }
        
        return Lyrics(lines: lyricsLines)
    }
    
    private static func parseLine(_ line: String) -> LyricsLine? {
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
        
        return LyricsLine(timestamp: timestamp, text: text)
    }
} 