import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";

type UploadedSong = {
  name: string;
  path?: string;
  file?: File;
};

type AnalysisResult = {
  bpm: number | null;
  beatPositions: number[];
  energyPeaks: number[];
};

const MIN_BPM = 70;
const MAX_BPM = 170;

const normalizeBpm = (value: number) => {
  let bpm = value;

  while (bpm < MIN_BPM) {
    bpm *= 2;
  }

  while (bpm > MAX_BPM) {
    bpm /= 2;
  }

  return bpm;
};

const analyzeAudioBuffer = (audioBuffer: AudioBuffer): AnalysisResult => {
  const frameSize = 2048;
  const hopSize = 1024;
  const minPeakGapSeconds = 0.18;
  const channelCount = audioBuffer.numberOfChannels;
  const frameCount = Math.max(
    0,
    Math.floor((audioBuffer.length - frameSize) / hopSize) + 1,
  );

  if (frameCount === 0) {
    return { bpm: null, beatPositions: [], energyPeaks: [] };
  }

  const channelData = Array.from({ length: channelCount }, (_, index) =>
    audioBuffer.getChannelData(index),
  );
  const energies = new Array<number>(frameCount);
  const frameDuration = hopSize / audioBuffer.sampleRate;

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const start = frameIndex * hopSize;
    let energy = 0;

    for (let sampleIndex = 0; sampleIndex < frameSize; sampleIndex += 1) {
      let mixedSample = 0;

      for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
        mixedSample += channelData[channelIndex][start + sampleIndex] ?? 0;
      }

      const monoSample = mixedSample / channelCount;
      energy += monoSample * monoSample;
    }

    energies[frameIndex] = Math.sqrt(energy / frameSize);
  }

  const maxEnergy = Math.max(...energies, 1e-6);
  const normalized = energies.map((value) => value / maxEnergy);
  const mean =
    normalized.reduce((sum, value) => sum + value, 0) / normalized.length;
  const variance =
    normalized.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    normalized.length;
  const standardDeviation = Math.sqrt(variance);
  const threshold = Math.min(0.95, mean + standardDeviation * 0.9);
  const minPeakGapFrames = Math.max(1, Math.round(minPeakGapSeconds / frameDuration));

  const detectedPeaks: Array<{ time: number; energy: number }> = [];

  for (let index = 1; index < normalized.length - 1; index += 1) {
    const current = normalized[index];

    if (
      current < threshold ||
      current < normalized[index - 1] ||
      current < normalized[index + 1]
    ) {
      continue;
    }

    const time = index * frameDuration;
    const previousPeak = detectedPeaks[detectedPeaks.length - 1];

    if (!previousPeak) {
      detectedPeaks.push({ time, energy: current });
      continue;
    }

    const previousPeakFrame = Math.round(previousPeak.time / frameDuration);

    if (index - previousPeakFrame < minPeakGapFrames) {
      if (current > previousPeak.energy) {
        previousPeak.time = time;
        previousPeak.energy = current;
      }

      continue;
    }

    detectedPeaks.push({ time, energy: current });
  }

  const histogram = new Map<number, number>();

  for (let peakIndex = 0; peakIndex < detectedPeaks.length; peakIndex += 1) {
    const currentPeak = detectedPeaks[peakIndex];

    for (
      let intervalIndex = peakIndex + 1;
      intervalIndex < Math.min(detectedPeaks.length, peakIndex + 9);
      intervalIndex += 1
    ) {
      const delta = detectedPeaks[intervalIndex].time - currentPeak.time;

      if (delta <= 0.2) {
        continue;
      }

      const bpmBucket = Math.round(normalizeBpm(60 / delta));
      const weight = currentPeak.energy + detectedPeaks[intervalIndex].energy;
      histogram.set(bpmBucket, (histogram.get(bpmBucket) ?? 0) + weight);
    }
  }

  let bpm: number | null = null;
  let bestWeight = 0;

  for (const [candidateBpm, weight] of histogram.entries()) {
    const neighborhoodWeight =
      (histogram.get(candidateBpm - 1) ?? 0) +
      weight +
      (histogram.get(candidateBpm + 1) ?? 0);

    if (neighborhoodWeight > bestWeight) {
      bpm = candidateBpm;
      bestWeight = neighborhoodWeight;
    }
  }

  const energyPeaks = detectedPeaks.map((peak) => peak.time);

  if (!bpm || energyPeaks.length === 0) {
    return {
      bpm,
      beatPositions: energyPeaks,
      energyPeaks,
    };
  }

  const beatInterval = 60 / bpm;
  const tolerance = Math.min(0.12, beatInterval * 0.3);
  const seedPeak =
    detectedPeaks.find((peak) => peak.time > 1 && peak.time < 8) ?? detectedPeaks[0];
  const beatPositions: number[] = [];

  for (
    let predicted = seedPeak.time;
    predicted >= 0;
    predicted -= beatInterval
  ) {
    const nearbyPeak = detectedPeaks.find(
      (peak) => Math.abs(peak.time - predicted) <= tolerance,
    );
    beatPositions.unshift(
      Number((nearbyPeak?.time ?? Math.max(0, predicted)).toFixed(3)),
    );
  }

  for (
    let predicted = seedPeak.time + beatInterval;
    predicted <= audioBuffer.duration;
    predicted += beatInterval
  ) {
    const nearbyPeak = detectedPeaks.find(
      (peak) => Math.abs(peak.time - predicted) <= tolerance,
    );
    beatPositions.push(Number((nearbyPeak?.time ?? predicted).toFixed(3)));
  }

  const dedupedBeatPositions = beatPositions.filter((time, index, array) => {
    return index === 0 || Math.abs(time - array[index - 1]) > 0.05;
  });

  return {
    bpm,
    beatPositions: dedupedBeatPositions,
    energyPeaks: energyPeaks.map((time) => Number(time.toFixed(3))),
  };
};

function App() {
  const dropzoneRef = useRef<HTMLElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioBufferRef = useRef<AudioBuffer | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const startedAtRef = useRef(0);
  const pausedAtRef = useRef(0);
  const manualStopRef = useRef(false);
  const [isDragActive, setIsDragActive] = useState(false);
  const [uploadedSong, setUploadedSong] = useState<UploadedSong | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [decodedAudioBuffer, setDecodedAudioBuffer] = useState<AudioBuffer | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [audioState, setAudioState] = useState<
    "idle" | "loading" | "ready" | "playing" | "paused"
  >("idle");
  const [trackDuration, setTrackDuration] = useState<number | null>(null);
  const [analysisState, setAnalysisState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);

  const handleDragState = (isActive: boolean) => {
    setIsDragActive(isActive);
  };

  const isMp3File = (fileName: string) => fileName.toLowerCase().endsWith(".mp3");

  const handleSongSelection = (song: UploadedSong | null, error?: string) => {
    setUploadedSong(song);
    setUploadError(error ?? null);
  };

  const handleUploadError = (message: string) => {
    setUploadError(message);
  };

  const ensureAudioContext = async () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }

    if (audioContextRef.current.state === "suspended") {
      await audioContextRef.current.resume();
    }

    return audioContextRef.current;
  };

  const stopPlayback = () => {
    const sourceNode = sourceNodeRef.current;

    if (!sourceNode) {
      return;
    }

    manualStopRef.current = true;
    sourceNode.stop();
    sourceNode.disconnect();
    sourceNodeRef.current = null;
  };

  const formatTime = (value: number | null) => {
    if (value === null) {
      return "--:--";
    }

    const minutes = Math.floor(value / 60);
    const seconds = Math.floor(value % 60);

    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  const loadFileIntoMemory = (file: File) => {
    if (!isMp3File(file.name)) {
      handleUploadError("Only MP3 files are supported right now.");
      return;
    }

    handleSongSelection({ name: file.name, file });
  };

  const isInsideDropzone = (x: number, y: number) => {
    const dropzone = dropzoneRef.current;

    if (!dropzone) {
      return false;
    }

    const rect = dropzone.getBoundingClientRect();

    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  };

  useEffect(() => {
    let disposed = false;
    let detachDropListener: (() => void) | undefined;

    const setupDropListener = async () => {
      const appWindow = getCurrentWindow();
      const unlisten = await appWindow.onDragDropEvent((event) => {
        if (disposed) {
          return;
        }

        if (event.payload.type === "enter" || event.payload.type === "over") {
          const scale = window.devicePixelRatio || 1;
          const x = event.payload.position.x / scale;
          const y = event.payload.position.y / scale;

          handleDragState(isInsideDropzone(x, y));
          return;
        }

        if (event.payload.type === "leave") {
          handleDragState(false);
          return;
        }

        const scale = window.devicePixelRatio || 1;
        const x = event.payload.position.x / scale;
        const y = event.payload.position.y / scale;

        handleDragState(false);

        if (!isInsideDropzone(x, y)) {
          return;
        }

        const mp3Path = event.payload.paths.find(isMp3File);

        if (!mp3Path) {
          handleUploadError("Only MP3 files are supported right now.");
          return;
        }

        const name = mp3Path.split(/[/\\]/).pop() ?? mp3Path;
        handleSongSelection({ name, path: mp3Path });
      });

      if (disposed) {
        unlisten();
        return;
      }

      detachDropListener = unlisten;
    };

    void setupDropListener();

    return () => {
      disposed = true;
      detachDropListener?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadUploadedSong = async () => {
      if (!uploadedSong) {
        stopPlayback();
        audioBufferRef.current = null;
        setDecodedAudioBuffer(null);
        pausedAtRef.current = 0;
        setAudioState("idle");
        setTrackDuration(null);
        setAudioError(null);
        return;
      }

      stopPlayback();
      audioBufferRef.current = null;
      setDecodedAudioBuffer(null);
      pausedAtRef.current = 0;
      setAudioState("loading");
      setTrackDuration(null);
      setAudioError(null);

      try {
        const audioContext = await ensureAudioContext();
        let arrayBuffer: ArrayBuffer;

        if (uploadedSong.file) {
          arrayBuffer = await uploadedSong.file.arrayBuffer();
        } else if (uploadedSong.path) {
          const bytes = await invoke<number[]>("read_audio_file", {
            path: uploadedSong.path,
          });
          arrayBuffer = Uint8Array.from(bytes).buffer;
        } else {
          throw new Error("No audio source is available.");
        }

        const decodedBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));

        if (cancelled) {
          return;
        }

        audioBufferRef.current = decodedBuffer;
        setDecodedAudioBuffer(decodedBuffer);
        setTrackDuration(decodedBuffer.duration);
        setAudioState("ready");
      } catch (error) {
        if (cancelled) {
          return;
        }

        audioBufferRef.current = null;
        setDecodedAudioBuffer(null);
        setTrackDuration(null);
        setAudioState("idle");
        setAudioError(
          error instanceof Error ? error.message : "Unable to decode the selected MP3.",
        );
      }
    };

    void loadUploadedSong();

    return () => {
      cancelled = true;
    };
  }, [uploadedSong]);

  useEffect(() => {
    if (!decodedAudioBuffer) {
      setAnalysisState("idle");
      setAnalysisError(null);
      setAnalysisResult(null);
      return;
    }

    setAnalysisState("loading");
    setAnalysisError(null);

    const runAnalysis = () => {
      try {
        const result = analyzeAudioBuffer(decodedAudioBuffer);
        setAnalysisResult(result);
        setAnalysisState("ready");

        console.log("Detected beat timestamps (s):", result.beatPositions);
        console.log("Detected energy peaks (s):", result.energyPeaks);
      } catch (error) {
        setAnalysisState("error");
        setAnalysisResult(null);
        setAnalysisError(
          error instanceof Error ? error.message : "Unable to analyze the selected song.",
        );
      }
    };

    window.setTimeout(runAnalysis, 0);
  }, [decodedAudioBuffer]);

  useEffect(() => {
    return () => {
      stopPlayback();
      void audioContextRef.current?.close();
    };
  }, []);

  const handlePlay = async () => {
    const audioBuffer = audioBufferRef.current;

    if (!audioBuffer) {
      return;
    }

    const audioContext = await ensureAudioContext();
    const sourceNode = audioContext.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.connect(audioContext.destination);
    sourceNodeRef.current = sourceNode;
    startedAtRef.current = audioContext.currentTime - pausedAtRef.current;
    manualStopRef.current = false;

    sourceNode.onended = () => {
      sourceNode.disconnect();
      sourceNodeRef.current = null;

      if (manualStopRef.current) {
        manualStopRef.current = false;
        return;
      }

      pausedAtRef.current = 0;
      setAudioState("ready");
    };

    sourceNode.start(0, pausedAtRef.current);
    setAudioState("playing");
  };

  const handlePause = () => {
    const audioContext = audioContextRef.current;

    if (!audioContext || !sourceNodeRef.current) {
      return;
    }

    pausedAtRef.current = audioContext.currentTime - startedAtRef.current;
    stopPlayback();
    setAudioState("paused");
  };

  const beatPreview = analysisResult?.beatPositions.slice(0, 16) ?? [];
  const peakPreview = analysisResult?.energyPeaks.slice(0, 12) ?? [];

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Type-a-tune</p>
        <h1>Drop a song or start typing</h1>
        <p className="subtitle">
          Turn each keystroke into a piano performance, one note at a time.
        </p>
      </section>

      <section
        ref={dropzoneRef}
        className={`dropzone ${isDragActive ? "dropzone-active" : ""}`}
        onDragEnter={(event) => {
          event.preventDefault();
          handleDragState(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          handleDragState(true);
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          handleDragState(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          handleDragState(false);

          const droppedFile = Array.from(event.dataTransfer.files).find((file) =>
            isMp3File(file.name),
          );

          if (!droppedFile) {
            handleUploadError("Only MP3 files are supported right now.");
            return;
          }

          loadFileIntoMemory(droppedFile);
        }}
      >
        <input
          ref={fileInputRef}
          className="file-input"
          type="file"
          accept=".mp3,audio/mpeg"
          onChange={(event) => {
            const selectedFile = event.currentTarget.files?.[0];

            if (selectedFile) {
              loadFileIntoMemory(selectedFile);
            }

            event.currentTarget.value = "";
          }}
        />
        <div className="dropzone-icon" aria-hidden="true">
          ♪
        </div>
        <p className="dropzone-title">Drag and drop an MP3 here</p>
        <p className="dropzone-caption">
          {uploadedSong
            ? "The song is loaded into app memory for this session."
            : "Your uploaded song stays in app memory for this session."}
        </p>

        <button
          className="browse-button"
          type="button"
          onClick={() => fileInputRef.current?.click()}
        >
          Choose MP3
        </button>

        <div className="dropzone-status" aria-live="polite">
          {uploadedSong ? (
            <>
              <p className="status-label">Loaded song</p>
              <p className="status-file">{uploadedSong.name}</p>
              <p className="status-meta">
                Web Audio buffer: {audioState} • {formatTime(trackDuration)}
              </p>
            </>
          ) : (
            <p className="status-placeholder">No song selected yet.</p>
          )}

          {uploadError ? <p className="status-error">{uploadError}</p> : null}
          {audioError ? <p className="status-error">{audioError}</p> : null}
        </div>

        <div className="transport">
          <button
            className="transport-button"
            type="button"
            disabled={audioState === "idle" || audioState === "loading"}
            onClick={audioState === "playing" ? handlePause : () => void handlePlay()}
          >
            {audioState === "loading"
              ? "Loading audio..."
              : audioState === "playing"
                ? "Pause"
                : "Play"}
          </button>
          <p className="transport-caption">
            Use this to confirm the MP3 decodes and plays cleanly before we move
            into beat analysis.
          </p>
        </div>

        <section className="analysis-panel" aria-live="polite">
          <p className="analysis-label">Rhythm analysis</p>
          <p className="analysis-summary">
            {analysisState === "idle" && "Load a song to analyze its tempo and beats."}
            {analysisState === "loading" && "Analyzing tempo, beat markers, and energy peaks..."}
            {analysisState === "error" && analysisError}
            {analysisState === "ready" &&
              `Estimated BPM: ${analysisResult?.bpm ?? "unknown"} • Beats: ${
                analysisResult?.beatPositions.length ?? 0
              } • Energy peaks: ${analysisResult?.energyPeaks.length ?? 0}`}
          </p>

          {analysisState === "ready" ? (
            <>
              <div className="analysis-grid">
                <div className="analysis-card">
                  <p className="analysis-card-label">Beat markers</p>
                  <p className="analysis-card-value">
                    {beatPreview.length > 0
                      ? beatPreview.map((time) => `${time.toFixed(2)}s`).join(", ")
                      : "None detected"}
                  </p>
                </div>

                <div className="analysis-card">
                  <p className="analysis-card-label">Energy peaks</p>
                  <p className="analysis-card-value">
                    {peakPreview.length > 0
                      ? peakPreview.map((time) => `${time.toFixed(2)}s`).join(", ")
                      : "None detected"}
                  </p>
                </div>
              </div>
              <p className="analysis-note">
                Full beat timestamps are also logged in the dev console.
              </p>
            </>
          ) : null}
        </section>
      </section>
    </main>
  );
}

export default App;
