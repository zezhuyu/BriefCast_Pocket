/**
 * Utility to parse LRC files into transcript data format
 */

// Function to convert LRC format to transcriptData format
export const convertLRCToTranscriptData = async (lrcFilePath: string) => {
    try {
      // Fetch the LRC file
      const response = await fetch(lrcFilePath);
      if (!response.ok) {
        throw new Error(`Failed to fetch LRC file: ${response.status}`);
      }
      
      const lrcText = await response.text();
      const lines = lrcText.split('\n');
      const transcriptData = [];
      
      for (const line of lines) {
        const match = line.match(/\[(\d+):(\d+\.\d+)\]\s*(.*)/);
        if (match) {
          const minutes = parseInt(match[1]);
          const seconds = parseFloat(match[2]);
          const text = match[3];
          
          const startTime = minutes * 60 + seconds;
          
          transcriptData.push({
            start: startTime,
            text: text
          });
        }
      }
      
      // Add end times by using the start time of the next segment
      for (let i = 0; i < transcriptData.length - 1; i++) {
        transcriptData[i] = {
          ...transcriptData[i],
          end: transcriptData[i + 1].start
        };
      }
      
      // Set the end time for the last segment (add 5 seconds from the start)
      if (transcriptData.length > 0) {
        const lastItem = transcriptData[transcriptData.length - 1];
        transcriptData[transcriptData.length - 1] = {
          ...lastItem,
          end: lastItem.start + 5
        };
      }
      
      return transcriptData;
    } catch (error) {
      console.error("Error parsing LRC file:", error);
      return [];
    }
  };
  
  // For testing with a string directly
  export const parseLRCString = (lrcText: string) => {
    const lines = lrcText.split('\n');
    const transcriptData = [];
    
    for (const line of lines) {
      const match = line.match(/\[(\d+):(\d+\.\d+)\]\s*(.*)/);
      if (match) {
        const minutes = parseInt(match[1]);
        const seconds = parseFloat(match[2]);
        const text = match[3];
        
        const startTime = minutes * 60 + seconds;
        
        transcriptData.push({
          start: startTime,
          text: text
        });
      }
    }
    
    // Add end times by using the start time of the next segment
    for (let i = 0; i < transcriptData.length - 1; i++) {
      transcriptData[i] = {
        ...transcriptData[i],
        end: transcriptData[i + 1].start
      };
    }
    
    // Set the end time for the last segment (add 5 seconds from the start)
    if (transcriptData.length > 0) {
      const lastItem = transcriptData[transcriptData.length - 1];
      transcriptData[transcriptData.length - 1] = {
        ...lastItem,
        end: lastItem.start + 5
      };
    }
    
    return transcriptData;
  };