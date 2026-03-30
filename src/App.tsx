import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";

type UploadedSong = {
  id: string;
  name: string;
  path?: string;
  file?: File;
  url?: string;
  isDefault?: boolean;
  addedAt?: number;
};

type AnalysisResult = {
  bpm: number | null;
  beatPositions: number[];
  energyPeaks: number[];
};

type PlaybackMode = "slices" | "piano";
type TypingFeel = "slowest" | "slow" | "normal" | "high";
type MistakeMode = "off" | "normal" | "strict";
type GameSourceMode = "flow" | "lyrics";

type PianoVoice = {
  gain: GainNode;
  sources: AudioScheduledSourceNode[];
  nodes: AudioNode[];
};

type OutputChain = {
  context: AudioContext;
  input: GainNode;
  compressor: DynamicsCompressorNode;
  masterGain: GainNode;
};

type GlobalKeypressPayload = {
  key: string;
};

type PerformanceKeyInput = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  target?: EventTarget | null;
  preventDefault?: () => void;
  source?: "window" | "global";
};

type PerformanceClock = {
  songStartTime: number;
  wallStartTime: number;
};

type PersistedSong = {
  id: string;
  name: string;
  path?: string;
  url?: string;
  isDefault?: boolean;
  addedAt?: number;
};

const MIN_BPM = 70;
const MAX_BPM = 170;
const TYPING_FEELS: TypingFeel[] = ["slowest", "slow", "normal", "high"];
const MISTAKE_MODES: MistakeMode[] = ["off", "normal", "strict"];
const INITIAL_PROMPT_WORD_COUNT = 96;
const APPEND_PROMPT_WORD_COUNT = 48;
const SONG_LIBRARY_STORAGE_KEY = "type-a-tune:song-library";
const ACTIVE_SONG_STORAGE_KEY = "type-a-tune:active-song";
const DEFAULT_SONG: UploadedSong = {
  id: "builtin:piano-demo",
  name: "Built-in Piano Demo",
  url: "/demo-piano.wav",
  isDefault: true,
  addedAt: 0,
};
const PROMPT_WORD_BANK = [
  "the",
  "piano",
  "keeps",
  "breathing",
  "under",
  "your",
  "hands",
  "while",
  "the",
  "melody",
  "glides",
  "forward",
  "through",
  "warm",
  "lights",
  "and",
  "soft",
  "echoes",
  "every",
  "letter",
  "lands",
  "like",
  "a",
  "note",
  "inside",
  "the",
  "room",
  "and",
  "the",
  "rhythm",
  "stays",
  "close",
  "to",
  "your",
  "pulse",
  "as",
  "gentle",
  "chords",
  "rise",
  "and",
  "fall",
  "without",
  "breaking",
  "the",
  "flow",
  "of",
  "the",
  "song",
  "you",
  "keep",
  "typing",
  "through",
  "silver",
  "tones",
  "that",
  "open",
  "into",
  "a",
  "long",
  "line",
  "of",
  "motion",
  "and",
  "the",
  "music",
  "answers",
  "with",
  "steady",
  "weight",
  "soft",
  "spark",
  "quiet",
  "drift",
  "gold",
  "hammer",
  "felt",
  "strings",
  "moving",
  "clear",
  "across",
  "the",
  "air",
  "in",
  "one",
  "continuous",
  "stream",
  "that",
  "does",
  "not",
  "stutter",
  "or",
  "fall",
  "apart",
];

const isPersistedSong = (value: unknown): value is PersistedSong => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  if (typeof candidate.id !== "string" || typeof candidate.name !== "string") {
    return false;
  }

  if (candidate.path !== undefined && typeof candidate.path !== "string") {
    return false;
  }

  if (candidate.url !== undefined && typeof candidate.url !== "string") {
    return false;
  }

  if (candidate.isDefault !== undefined && typeof candidate.isDefault !== "boolean") {
    return false;
  }

  if (candidate.addedAt !== undefined && typeof candidate.addedAt !== "number") {
    return false;
  }

  return true;
};

const buildSongLibrary = (songs: UploadedSong[]) => {
  const uniqueSongs: UploadedSong[] = [];
  const seenSongIds = new Set<string>();

  for (const song of songs) {
    if (seenSongIds.has(song.id)) {
      continue;
    }

    seenSongIds.add(song.id);
    uniqueSongs.push(song);
  }

  return uniqueSongs;
};

const readInitialSongState = () => {
  const library = [DEFAULT_SONG];
  let activeSongId = DEFAULT_SONG.id;

  if (typeof window === "undefined") {
    return {
      library,
      activeSongId,
    };
  }

  try {
    const rawLibrary = window.localStorage.getItem(SONG_LIBRARY_STORAGE_KEY);

    if (rawLibrary) {
      const parsedLibrary = JSON.parse(rawLibrary) as unknown;

      if (Array.isArray(parsedLibrary)) {
        const restoredSongs = parsedLibrary
          .filter(isPersistedSong)
          .map((song) => ({
            ...song,
          }));

        const nextLibrary = buildSongLibrary([DEFAULT_SONG, ...restoredSongs]);

        library.splice(0, library.length, ...nextLibrary);
      }
    }

    const persistedActiveSongId = window.localStorage.getItem(ACTIVE_SONG_STORAGE_KEY);

    if (persistedActiveSongId && library.some((song) => song.id === persistedActiveSongId)) {
      activeSongId = persistedActiveSongId;
    }
  } catch {
    return {
      library: [DEFAULT_SONG],
      activeSongId: DEFAULT_SONG.id,
    };
  }

  return {
    library,
    activeSongId,
  };
};

const upsertSong = (songs: UploadedSong[], song: UploadedSong) => {
  const existingIndex = songs.findIndex((candidate) => candidate.id === song.id);

  if (existingIndex === -1) {
    return [...songs, song];
  }

  return songs.map((candidate, index) => (index === existingIndex ? song : candidate));
};

const createFileSong = (file: File): UploadedSong => {
  return {
    id: `file:${file.name}:${file.size}:${file.lastModified}`,
    name: file.name,
    file,
    addedAt: Date.now(),
  };
};

const createPathSong = (path: string): UploadedSong => {
  const name = path.split(/[/\\]/).pop() ?? path;

  return {
    id: `path:${path}`,
    name,
    path,
    addedAt: Date.now(),
  };
};

const isSongPersistable = (song: UploadedSong) => {
  return Boolean(song.isDefault || song.path || song.url);
};

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

const createPlayableStepMap = (analysisResult: AnalysisResult | null) => {
  if (!analysisResult) {
    return [];
  }

  const sourcePositions =
    analysisResult.beatPositions.length > 0
      ? analysisResult.beatPositions
      : analysisResult.energyPeaks;

  if (sourcePositions.length === 0) {
    return [];
  }

  const beatInterval = analysisResult.bpm ? 60 / analysisResult.bpm : 0.5;
  const minGap = Math.max(0.34, Math.min(0.48, beatInterval * 1.15));
  const playableSteps: number[] = [sourcePositions[0]];

  for (let index = 1; index < sourcePositions.length; index += 1) {
    const candidate = sourcePositions[index];
    const previous = playableSteps[playableSteps.length - 1];

    if (candidate - previous >= minGap) {
      playableSteps.push(candidate);
    }
  }

  return playableSteps.map((time) => Number(time.toFixed(3)));
};

const frequencyToMidi = (frequency: number) => {
  return 69 + 12 * Math.log2(frequency / 440);
};

const midiToFrequency = (midi: number) => {
  return 440 * 2 ** ((midi - 69) / 12);
};

const formatMidiNote = (midi: number) => {
  const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const noteName = noteNames[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;

  return `${noteName}${octave}`;
};

const clampMidi = (midi: number) => Math.max(36, Math.min(84, midi));

const getTypingFeelProfile = (typingFeel: TypingFeel) => {
  switch (typingFeel) {
    case "slowest":
      return {
        triggerGateMs: 72,
        duckReleaseTime: 0.32,
        idleDelayMs: 3500,
        pacedWindowMs: 3500,
        sliceTailMaxDuration: 3.2,
        pianoTailDuration: 4.2,
      };
    case "slow":
      return {
        triggerGateMs: 36,
        duckReleaseTime: 0.14,
        idleDelayMs: 1250,
        pacedWindowMs: 2400,
        sliceTailMaxDuration: 1.45,
        pianoTailDuration: 2.9,
      };
    case "high":
      return {
        triggerGateMs: 24,
        duckReleaseTime: 0.08,
        idleDelayMs: 620,
        pacedWindowMs: 1100,
        sliceTailMaxDuration: 0.92,
        pianoTailDuration: 1.95,
      };
    case "normal":
    default:
      return {
        triggerGateMs: 30,
        duckReleaseTime: 0.11,
        idleDelayMs: 920,
        pacedWindowMs: 1700,
        sliceTailMaxDuration: 1.18,
        pianoTailDuration: 2.45,
      };
  }
};

const buildPromptStream = (startIndex: number, wordCount: number) => {
  return Array.from({ length: wordCount }, (_, index) => {
    return PROMPT_WORD_BANK[(startIndex + index) % PROMPT_WORD_BANK.length];
  }).join(" ");
};



const analyzeStepTone = (audioBuffer: AudioBuffer, time: number) => {
  const sampleRate = audioBuffer.sampleRate;
  const channelCount = audioBuffer.numberOfChannels;
  const windowSize = 4096;
  const centerSample = Math.floor(time * sampleRate);
  const startSample = Math.max(0, centerSample - Math.floor(windowSize / 2));
  const endSample = Math.min(audioBuffer.length, startSample + windowSize);
  const mono = new Float32Array(endSample - startSample);

  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const channelData = audioBuffer.getChannelData(channelIndex);

    for (let sampleIndex = startSample; sampleIndex < endSample; sampleIndex += 1) {
      mono[sampleIndex - startSample] += channelData[sampleIndex] / channelCount;
    }
  }

  const rms = Math.sqrt(
    mono.reduce((sum, value) => sum + value * value, 0) / Math.max(1, mono.length),
  );
  const minLag = Math.floor(sampleRate / 880);
  const maxLag = Math.floor(sampleRate / 98);
  let bestLag = 0;
  let bestCorrelation = 0;

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let correlation = 0;

    for (let index = 0; index < mono.length - lag; index += 1) {
      correlation += mono[index] * mono[index + lag];
    }

    correlation /= Math.max(1, mono.length - lag);

    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestLag = lag;
    }
  }

  const rawFrequency =
    bestLag > 0 && bestCorrelation > 0.0005 ? sampleRate / bestLag : 261.63;
  const midi = Math.max(48, Math.min(84, Math.round(frequencyToMidi(rawFrequency))));
  const velocity = Math.max(0.24, Math.min(1, rms * 18));

  return {
    midi,
    velocity,
  };
};

const isEditableTarget = (target: EventTarget | null) => {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
};

const isTypingPerformanceInput = (input: PerformanceKeyInput) => {
  if (input.metaKey || input.ctrlKey || input.altKey || input.repeat) {
    return false;
  }

  if (input.key === "Backspace" || isEditableTarget(input.target ?? null)) {
    return false;
  }

  return input.key.length === 1 || input.key === " " || input.key === "Enter";
};

const isRewindInput = (input: PerformanceKeyInput) => {
  if (input.metaKey || input.ctrlKey || input.altKey || input.repeat) {
    return false;
  }

  if (isEditableTarget(input.target ?? null)) {
    return false;
  }

  return input.key === "Backspace";
};

const getTypedCharacterFromKey = (key: string) => {
  if (key === "Enter" || key === " ") {
    return " ";
  }

  return key.length === 1 ? key.toLowerCase() : "";
};

function App() {
  const initialSongStateRef = useRef<ReturnType<typeof readInitialSongState> | null>(null);

  if (initialSongStateRef.current === null) {
    initialSongStateRef.current = readInitialSongState();
  }

  const initialSongState = initialSongStateRef.current;
  const dropzoneRef = useRef<HTMLElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const outputChainRef = useRef<OutputChain | null>(null);
  const audioBufferRef = useRef<AudioBuffer | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const activePianoVoicesRef = useRef<PianoVoice[]>([]);
  const idleReleaseTimerRef = useRef<number | null>(null);
  const pacedPlaybackTimerRef = useRef<number | null>(null);
  const pacedPlaybackUntilRef = useRef(0);
  const uiPulseTimerRef = useRef<number | null>(null);
  const performanceClockRef = useRef<PerformanceClock | null>(null);
  const lastPlayedStepIndexRef = useRef<number | null>(null);
  const pendingStepIndexRef = useRef<number | null>(null);
  const lastTriggerAtRef = useRef(0);
  const startedAtRef = useRef(0);
  const pausedAtRef = useRef(0);
  const manualStopRef = useRef(false);
  const currentBeatIndexRef = useRef(0);
  const lastHandledInputRef = useRef<{ key: string; source: "window" | "global"; at: number } | null>(
    null,
  );
  const [isDragActive, setIsDragActive] = useState(false);
  const [savedSongs, setSavedSongs] = useState<UploadedSong[]>(initialSongState.library);
  const [activeSongId, setActiveSongId] = useState(initialSongState.activeSongId);
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
  const [playableSteps, setPlayableSteps] = useState<number[]>([]);
  const [playbackMode, setPlaybackMode] = useState<PlaybackMode>("slices");
  const [isPaceLocked, setIsPaceLocked] = useState(true);
  const [typingFeel, setTypingFeel] = useState<TypingFeel>("slow");
  const [mistakeMode, setMistakeMode] = useState<MistakeMode>("normal");
  const [gameSourceMode, setGameSourceMode] = useState<GameSourceMode>("flow");
  const [isGameActive, setIsGameActive] = useState(false);
  const [backgroundTypingState, setBackgroundTypingState] = useState<
    "idle" | "enabling" | "enabled" | "error"
  >("idle");
  const [backgroundTypingMessage, setBackgroundTypingMessage] = useState(
    "Enable this when you want Type-a-tune to react while you use other apps.",
  );
  const [promptStream, setPromptStream] = useState(() =>
    buildPromptStream(0, INITIAL_PROMPT_WORD_COUNT),
  );
  const [nextPromptSeedIndex, setNextPromptSeedIndex] = useState(
    INITIAL_PROMPT_WORD_COUNT % PROMPT_WORD_BANK.length,
  );
  const [promptCursor, setPromptCursor] = useState(0);
  const [performanceStep, setPerformanceStep] = useState(0);
  const [lastTriggeredBeat, setLastTriggeredBeat] = useState<number | null>(null);
  const [lastPianoNote, setLastPianoNote] = useState<string>("--");
  const [isUiPulseActive, setIsUiPulseActive] = useState(false);
  const [isTypingBoothOpen, setIsTypingBoothOpen] = useState(false);
  const [isPulseInfoOpen, setIsPulseInfoOpen] = useState(false);
  const [performanceStatus, setPerformanceStatus] = useState(
    "Load a song and start typing to step through detected beats.",
  );
  const typingFeelProfile = getTypingFeelProfile(typingFeel);
  const activePrompt = promptStream;
  const promptWindowStart = Math.max(0, promptCursor - 20);
  const promptWindowEnd = Math.min(activePrompt.length, promptCursor + 96);
  const visiblePrompt = activePrompt.slice(promptWindowStart, promptWindowEnd);
  const visibleCursorIndex = Math.max(0, promptCursor - promptWindowStart);
  const activeSongIndex = savedSongs.findIndex((song) => song.id === activeSongId);
  const uploadedSong =
    savedSongs[activeSongIndex] ?? savedSongs[0] ?? null;
  const canSelectPreviousSong = activeSongIndex > 0;
  const canSelectNextSong =
    activeSongIndex >= 0 && activeSongIndex < savedSongs.length - 1;

  useEffect(() => {
    if (savedSongs.length === 0) {
      setSavedSongs([DEFAULT_SONG]);
      setActiveSongId(DEFAULT_SONG.id);
      return;
    }

    if (!savedSongs.some((song) => song.id === activeSongId)) {
      setActiveSongId(savedSongs[0].id);
    }
  }, [activeSongId, savedSongs]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const persistedSongs = savedSongs
      .filter(isSongPersistable)
      .map(({ id, name, path, url, isDefault, addedAt }) => ({
        id,
        name,
        path,
        url,
        isDefault,
        addedAt,
      }));

    window.localStorage.setItem(SONG_LIBRARY_STORAGE_KEY, JSON.stringify(persistedSongs));
  }, [savedSongs]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (uploadedSong) {
      window.localStorage.setItem(ACTIVE_SONG_STORAGE_KEY, uploadedSong.id);
      return;
    }

    window.localStorage.removeItem(ACTIVE_SONG_STORAGE_KEY);
  }, [uploadedSong]);

  useEffect(() => {
    if (!isTypingBoothOpen) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsTypingBoothOpen(false);
      }
    };

    window.addEventListener("keydown", handleEscape);

    return () => {
      window.removeEventListener("keydown", handleEscape);
    };
  }, [isTypingBoothOpen]);

  const handleDragState = (isActive: boolean) => {
    setIsDragActive(isActive);
  };

  const isMp3File = (fileName: string) => fileName.toLowerCase().endsWith(".mp3");

  const handleSongSelection = (song: UploadedSong | null, error?: string) => {
    setUploadError(error ?? null);

    if (!song) {
      return;
    }

    setSavedSongs((currentSongs) => upsertSong(currentSongs, song));
    setActiveSongId(song.id);
  };

  const handleUploadError = (message: string) => {
    setUploadError(message);
  };

  const handleSavedSongStep = (direction: -1 | 1) => {
    const nextSong = savedSongs[activeSongIndex + direction];

    if (!nextSong) {
      return;
    }

    setUploadError(null);
    setActiveSongId(nextSong.id);
  };

  const resetPromptGame = () => {
    if (gameSourceMode === "flow") {
      setPromptStream(buildPromptStream(0, INITIAL_PROMPT_WORD_COUNT));
      setNextPromptSeedIndex(INITIAL_PROMPT_WORD_COUNT % PROMPT_WORD_BANK.length);
    }
    setPromptCursor(0);
    setIsGameActive(false);
  };

  const ensureAudioContext = async () => {
    if (!audioContextRef.current || audioContextRef.current.state === "closed") {
      audioContextRef.current = new AudioContext();
      outputChainRef.current = null;
    }

    if (audioContextRef.current.state === "suspended") {
      await audioContextRef.current.resume();
    }

    return audioContextRef.current;
  };

  const ensureOutputChain = (audioContext: AudioContext) => {
    if (!outputChainRef.current || outputChainRef.current.context !== audioContext) {
      const input = audioContext.createGain();
      const compressor = audioContext.createDynamicsCompressor();
      const masterGain = audioContext.createGain();

      input.gain.setValueAtTime(1, audioContext.currentTime);
      compressor.threshold.setValueAtTime(-18, audioContext.currentTime);
      compressor.knee.setValueAtTime(16, audioContext.currentTime);
      compressor.ratio.setValueAtTime(2.8, audioContext.currentTime);
      compressor.attack.setValueAtTime(0.003, audioContext.currentTime);
      compressor.release.setValueAtTime(0.14, audioContext.currentTime);
      masterGain.gain.setValueAtTime(0.9, audioContext.currentTime);

      input.connect(compressor);
      compressor.connect(masterGain);
      masterGain.connect(audioContext.destination);

      outputChainRef.current = {
        context: audioContext,
        input,
        compressor,
        masterGain,
      };
    }

    return outputChainRef.current;
  };

  const triggerUiPulse = () => {
    if (uiPulseTimerRef.current !== null) {
      window.clearTimeout(uiPulseTimerRef.current);
    }

    setIsUiPulseActive(false);
    window.requestAnimationFrame(() => {
      setIsUiPulseActive(true);
      uiPulseTimerRef.current = window.setTimeout(() => {
        setIsUiPulseActive(false);
        uiPulseTimerRef.current = null;
      }, 420);
    });
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

  const stopSlicePlayback = () => {
    for (const voice of activePianoVoicesRef.current) {
      for (const source of voice.sources) {
        source.stop();
        source.disconnect();
      }

      for (const node of voice.nodes) {
        node.disconnect();
      }
    }

    activePianoVoicesRef.current = [];
  };

  const releaseVoice = (voice: PianoVoice, audioContext: AudioContext, releaseTime = 0.08) => {
    const now = audioContext.currentTime;

    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(Math.max(voice.gain.gain.value, 0.0001), now);
    voice.gain.gain.exponentialRampToValueAtTime(0.0001, now + releaseTime);

    window.setTimeout(() => {
      for (const source of voice.sources) {
        source.stop();
        source.disconnect();
      }

      for (const node of voice.nodes) {
        node.disconnect();
      }

      activePianoVoicesRef.current = activePianoVoicesRef.current.filter(
        (candidate) => candidate !== voice,
      );
    }, Math.round((releaseTime + 0.03) * 1000));
  };

  const duckActiveVoices = (audioContext: AudioContext, releaseTime = typingFeelProfile.duckReleaseTime) => {
    for (const voice of [...activePianoVoicesRef.current]) {
      releaseVoice(voice, audioContext, releaseTime);
    }
  };

  const trimActiveVoices = (
    audioContext: AudioContext,
    maxVoices: number,
    releaseTime = typingFeelProfile.duckReleaseTime,
  ) => {
    const overflow = activePianoVoicesRef.current.length - maxVoices;

    if (overflow <= 0) {
      return;
    }

    for (const voice of activePianoVoicesRef.current.slice(0, overflow)) {
      releaseVoice(voice, audioContext, releaseTime);
    }
  };

  const clearIdleRelease = () => {
    if (idleReleaseTimerRef.current !== null) {
      window.clearTimeout(idleReleaseTimerRef.current);
      idleReleaseTimerRef.current = null;
    }
  };

  const clearPacedPlaybackTimer = () => {
    if (pacedPlaybackTimerRef.current !== null) {
      window.clearTimeout(pacedPlaybackTimerRef.current);
      pacedPlaybackTimerRef.current = null;
    }
  };

  const resetPerformanceClock = () => {
    clearPacedPlaybackTimer();
    pacedPlaybackUntilRef.current = 0;
    performanceClockRef.current = null;
    lastPlayedStepIndexRef.current = null;
    pendingStepIndexRef.current = null;
  };

  const canAcceptTriggerBurst = () => {
    const now = Date.now();

    if (now - lastTriggerAtRef.current < typingFeelProfile.triggerGateMs) {
      return false;
    }

    lastTriggerAtRef.current = now;
    return true;
  };

  const shouldIgnoreDuplicateInput = (input: PerformanceKeyInput) => {
    const source = input.source ?? "window";
    const now = Date.now();
    const lastHandledInput = lastHandledInputRef.current;

    if (
      lastHandledInput &&
      lastHandledInput.key === input.key &&
      lastHandledInput.source !== source &&
      now - lastHandledInput.at <= 45
    ) {
      return true;
    }

    lastHandledInputRef.current = {
      key: input.key,
      source,
      at: now,
    };
    return false;
  };

  const playRawSliceStep = async (
    audioContext: AudioContext,
    audioBuffer: AudioBuffer,
    startTime: number,
    stepPositions: number[],
    beatIndex: number,
    paced: boolean,
  ) => {
    const sourceNode = audioContext.createBufferSource();
    const gainNode = audioContext.createGain();
    const outputChain = ensureOutputChain(audioContext);
    const now = audioContext.currentTime;
    const nextTime =
      stepPositions[beatIndex + 1] ?? Math.min(audioBuffer.duration, startTime + 0.52);
    const previewLead = 0.012;
    const sliceStart = Math.max(0, startTime - previewLead);
    const sliceDuration = paced
      ? typingFeelProfile.sliceTailMaxDuration
      : Math.max(
          0.24,
          Math.min(
            Math.max(0.92, typingFeelProfile.sliceTailMaxDuration * 0.78),
            Math.max(nextTime - sliceStart + 0.06, 0.34),
          ),
        );
    const safeStart = Math.min(
      Math.max(0, sliceStart),
      Math.max(0, audioBuffer.duration - 0.02),
    );
    const safeDuration = Math.min(sliceDuration, audioBuffer.duration - safeStart);

    sourceNode.buffer = audioBuffer;
    gainNode.gain.cancelScheduledValues(now);
    gainNode.gain.setValueAtTime(0.0001, now);
    gainNode.gain.linearRampToValueAtTime(paced ? 0.48 : 0.54, now + (paced ? 0.02 : 0.014));
    gainNode.gain.setValueAtTime(
      paced ? 0.48 : 0.54,
      now + Math.max(paced ? 0.28 : 0.12, safeDuration - (paced ? 0.28 : 0.12)),
    );
    gainNode.gain.exponentialRampToValueAtTime(0.0001, now + safeDuration + 0.04);

    sourceNode.connect(gainNode);
    gainNode.connect(outputChain.input);

    const activeVoice: PianoVoice = {
      gain: gainNode,
      sources: [sourceNode],
      nodes: [gainNode],
    };

    activePianoVoicesRef.current.push(activeVoice);

    sourceNode.onended = () => {
      sourceNode.disconnect();
      gainNode.disconnect();
      activePianoVoicesRef.current = activePianoVoicesRef.current.filter(
        (voice) => voice !== activeVoice,
      );
    };

    sourceNode.start(0, safeStart, safeDuration);
  };

  const playPianoStep = async (
    audioContext: AudioContext,
    audioBuffer: AudioBuffer,
    startTime: number,
    paced: boolean,
  ) => {
    const tone = analyzeStepTone(audioBuffer, startTime);
    const now = audioContext.currentTime;
    const outputChain = ensureOutputChain(audioContext);
    const noteDuration = paced
      ? typingFeelProfile.pianoTailDuration
      : Math.max(1.6, typingFeelProfile.pianoTailDuration * 0.86);
    const fundamental = midiToFrequency(tone.midi);
    const chordMidis =
      tone.velocity > 0.62
        ? [tone.midi, Math.min(84, tone.midi + 7), Math.min(84, tone.midi + 12)]
        : tone.velocity > 0.42
          ? [tone.midi, Math.min(84, tone.midi + 12)]
          : [tone.midi];
    const masterGain = audioContext.createGain();
    const toneFilter = audioContext.createBiquadFilter();
    const hammerFilter = audioContext.createBiquadFilter();
    const hammerGain = audioContext.createGain();
    const oscillators: OscillatorNode[] = [];
    const noteGains: GainNode[] = [];

    masterGain.gain.setValueAtTime(0.0001, now);
    masterGain.gain.linearRampToValueAtTime(0.56 * tone.velocity, now + 0.028);
    masterGain.gain.exponentialRampToValueAtTime(
      Math.max(0.072, 0.13 * tone.velocity),
      now + (paced ? 0.62 : 0.44),
    );
    masterGain.gain.exponentialRampToValueAtTime(0.0001, now + noteDuration + 0.08);

    toneFilter.type = "lowpass";
    toneFilter.frequency.setValueAtTime(2200 + tone.velocity * 1800, now);
    toneFilter.Q.value = 0.7;

    hammerFilter.type = "highpass";
    hammerFilter.frequency.value = 1800;
    hammerGain.gain.setValueAtTime(0.0001, now);
    hammerGain.gain.linearRampToValueAtTime(0.028 * tone.velocity, now + 0.004);
    hammerGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.032);

    for (const midi of chordMidis) {
      const frequency = midiToFrequency(midi);
      const fundamentalOsc = audioContext.createOscillator();
      const bodyOsc = audioContext.createOscillator();
      const shimmerOsc = audioContext.createOscillator();

      fundamentalOsc.type = "triangle";
      bodyOsc.type = "sine";
      shimmerOsc.type = "sine";

      fundamentalOsc.frequency.setValueAtTime(frequency, now);
      bodyOsc.frequency.setValueAtTime(frequency * 2, now);
      shimmerOsc.frequency.setValueAtTime(frequency * 3, now);

      const noteGain = audioContext.createGain();
      noteGain.gain.value =
        midi === tone.midi ? 1 : midi === tone.midi + 12 ? 0.32 : 0.2;

      fundamentalOsc.connect(noteGain);
      bodyOsc.connect(noteGain);
      shimmerOsc.connect(noteGain);
      noteGain.connect(toneFilter);

      noteGains.push(noteGain);
      oscillators.push(fundamentalOsc, bodyOsc, shimmerOsc);
    }

    const hammerOsc = audioContext.createOscillator();
    hammerOsc.type = "triangle";
    hammerOsc.frequency.setValueAtTime(fundamental * 6, now);
    hammerOsc.connect(hammerFilter);
    hammerFilter.connect(hammerGain);

    toneFilter.connect(masterGain);
    hammerGain.connect(masterGain);
    masterGain.connect(outputChain.input);

    for (const oscillator of oscillators) {
      oscillator.start(now);
      oscillator.stop(now + noteDuration + 0.04);
    }

    hammerOsc.start(now);
    hammerOsc.stop(now + 0.06);

    const activeVoice: PianoVoice = {
      gain: masterGain,
      sources: [...oscillators, hammerOsc],
      nodes: [toneFilter, hammerFilter, hammerGain, masterGain, ...noteGains],
    };

    activePianoVoicesRef.current.push(activeVoice);

    oscillators[0].onended = () => {
      for (const source of activeVoice.sources) {
        source.disconnect();
      }

      for (const node of activeVoice.nodes) {
        node.disconnect();
      }

      activePianoVoicesRef.current = activePianoVoicesRef.current.filter(
        (voice) => voice !== activeVoice,
      );
    };

    return formatMidiNote(tone.midi);
  };

  const playMistakeCue = async (
    audioContext: AudioContext,
    audioBuffer: AudioBuffer | null,
    referenceTime: number | null,
  ) => {
    const outputChain = ensureOutputChain(audioContext);
    const now = audioContext.currentTime;
    const referenceTone =
      audioBuffer && referenceTime !== null
        ? analyzeStepTone(audioBuffer, referenceTime).midi
        : 60;
    const midis = [
      clampMidi(referenceTone - 1),
      clampMidi(referenceTone + 1),
      clampMidi(referenceTone + 6),
    ];
    const masterGain = audioContext.createGain();
    const filter = audioContext.createBiquadFilter();
    const oscillators: OscillatorNode[] = [];
    const gains: GainNode[] = [];

    masterGain.gain.setValueAtTime(0.0001, now);
    masterGain.gain.linearRampToValueAtTime(0.16, now + 0.01);
    masterGain.gain.exponentialRampToValueAtTime(0.08, now + 0.12);
    masterGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.38);

    filter.type = "lowpass";
    filter.frequency.setValueAtTime(1800, now);
    filter.Q.value = 0.6;

    midis.forEach((midi, index) => {
      const fundamental = audioContext.createOscillator();
      const overtone = audioContext.createOscillator();
      const noteGain = audioContext.createGain();
      const frequency = midiToFrequency(midi);
      const startOffset = index * 0.012;

      fundamental.type = "triangle";
      overtone.type = "sine";
      fundamental.frequency.setValueAtTime(frequency, now + startOffset);
      overtone.frequency.setValueAtTime(frequency * 2.02, now + startOffset);
      noteGain.gain.value = [0.4, 0.28, 0.18][index] ?? 0.16;

      fundamental.connect(noteGain);
      overtone.connect(noteGain);
      noteGain.connect(filter);

      oscillators.push(fundamental, overtone);
      gains.push(noteGain);
    });

    filter.connect(masterGain);
    masterGain.connect(outputChain.input);

    for (let index = 0; index < oscillators.length; index += 1) {
      const startOffset = Math.floor(index / 2) * 0.012;
      oscillators[index].start(now + startOffset);
      oscillators[index].stop(now + 0.42 + startOffset);
    }

    const activeVoice: PianoVoice = {
      gain: masterGain,
      sources: oscillators,
      nodes: [filter, masterGain, ...gains],
    };

    activePianoVoicesRef.current.push(activeVoice);

    oscillators[0].onended = () => {
      for (const source of activeVoice.sources) {
        source.disconnect();
      }

      for (const node of activeVoice.nodes) {
        node.disconnect();
      }

      activePianoVoicesRef.current = activePianoVoicesRef.current.filter(
        (voice) => voice !== activeVoice,
      );
    };
  };

  const scheduleIdleRelease = () => {
    clearIdleRelease();
    idleReleaseTimerRef.current = window.setTimeout(() => {
      void ensureAudioContext()
        .then((audioContext) => {
          for (const voice of [...activePianoVoicesRef.current]) {
            releaseVoice(voice, audioContext, 0.82);
          }
        })
        .catch(() => {
          // Idle release is best-effort only.
        });
    }, typingFeelProfile.idleDelayMs);
  };

  const performStepPlayback = async (
    audioBuffer: AudioBuffer,
    stepPositions: number[],
    stepIndexToPlay: number,
    paced: boolean,
    statusMessage?: (playedLabel: string) => string,
  ) => {
    const startTime = stepPositions[stepIndexToPlay];
    currentBeatIndexRef.current = Math.max(currentBeatIndexRef.current, stepIndexToPlay + 1);
    setPerformanceStep(currentBeatIndexRef.current);
    pendingStepIndexRef.current = stepIndexToPlay;

    try {
      const audioContext = await ensureAudioContext();

      duckActiveVoices(audioContext, typingFeelProfile.duckReleaseTime);
      trimActiveVoices(
        audioContext,
        playbackMode === "piano" ? 2 : 1,
        Math.min(typingFeelProfile.duckReleaseTime, 0.1),
      );
      let playedLabel = "Song slice";

      if (playbackMode === "piano") {
        playedLabel = await playPianoStep(audioContext, audioBuffer, startTime, paced);
      } else {
        await playRawSliceStep(
          audioContext,
          audioBuffer,
          startTime,
          stepPositions,
          stepIndexToPlay,
          paced,
        );
      }

      lastPlayedStepIndexRef.current = stepIndexToPlay;
      if (pendingStepIndexRef.current === stepIndexToPlay) {
        pendingStepIndexRef.current = null;
      }
      setLastTriggeredBeat(startTime);
      setLastPianoNote(playedLabel);
      triggerUiPulse();
      setAudioError(null);
      setPerformanceStatus(
        statusMessage?.(playedLabel) ??
          `Played ${playedLabel} on step ${currentBeatIndexRef.current} of ${stepPositions.length}.`,
      );
      scheduleIdleRelease();
    } catch (error) {
      if (pendingStepIndexRef.current === stepIndexToPlay) {
        pendingStepIndexRef.current = null;
      }
      setPerformanceStatus(
        playbackMode === "piano"
          ? "Unable to play the piano interpretation."
          : "Unable to play the song slice mode.",
      );
      setAudioError(
        error instanceof Error
          ? error.message
          : playbackMode === "piano"
            ? "Piano playback failed."
            : "Song slice playback failed.",
      );
    }
  };

  const scheduleNextPacedStep = () => {
    if (pacedPlaybackTimerRef.current !== null) {
      return;
    }

    const audioBuffer = audioBufferRef.current;
    const clock = performanceClockRef.current;
    const nextStepIndex = currentBeatIndexRef.current;

    if (
      !isPaceLocked ||
      !audioBuffer ||
      analysisState !== "ready" ||
      !clock ||
      Date.now() >= pacedPlaybackUntilRef.current ||
      nextStepIndex >= playableSteps.length
    ) {
      return;
    }

    const nextStepSongTime = playableSteps[nextStepIndex];
    const dueAt =
      clock.wallStartTime + Math.max(0, (nextStepSongTime - clock.songStartTime) * 1000);
    const delayMs = Math.max(0, dueAt - Date.now());

    if (dueAt > pacedPlaybackUntilRef.current) {
      return;
    }

    pacedPlaybackTimerRef.current = window.setTimeout(() => {
      pacedPlaybackTimerRef.current = null;

      if (
        !isPaceLocked ||
        !audioBufferRef.current ||
        analysisState !== "ready" ||
        Date.now() >= pacedPlaybackUntilRef.current ||
        currentBeatIndexRef.current >= playableSteps.length
      ) {
        return;
      }

      const queuedStepIndex = currentBeatIndexRef.current;

      void performStepPlayback(
        audioBufferRef.current,
        playableSteps,
        queuedStepIndex,
        true,
        (playedLabel) =>
          `Played ${playedLabel} on step ${queuedStepIndex + 1} of ${playableSteps.length} at the song's pace.`,
      ).finally(() => {
        scheduleNextPacedStep();
      });
    }, delayMs);
  };


  const playRewindCue = async (
    audioContext: AudioContext,
    audioBuffer: AudioBuffer,
    startTime: number,
    mode: PlaybackMode,
    stepPositions: number[],
    stepIndex: number,
  ) => {
    const now = audioContext.currentTime;
    const outputChain = ensureOutputChain(audioContext);

    if (mode === "slices") {
      const previousStepStart =
        stepPositions[Math.max(0, stepIndex - 1)] ?? Math.max(0, startTime - 0.45);
      const snippetStart = Math.max(0, previousStepStart);
      const snippetEnd = Math.min(audioBuffer.duration, startTime + 0.04);
      const frameStart = Math.floor(snippetStart * audioBuffer.sampleRate);
      const frameEnd = Math.max(
        frameStart + 1,
        Math.floor(snippetEnd * audioBuffer.sampleRate),
      );
      const frameLength = frameEnd - frameStart;
      const reversedBuffer = audioContext.createBuffer(
        audioBuffer.numberOfChannels,
        frameLength,
        audioBuffer.sampleRate,
      );

      for (
        let channelIndex = 0;
        channelIndex < audioBuffer.numberOfChannels;
        channelIndex += 1
      ) {
        const sourceData = audioBuffer.getChannelData(channelIndex);
        const targetData = reversedBuffer.getChannelData(channelIndex);

        for (let index = 0; index < frameLength; index += 1) {
          targetData[index] = sourceData[frameEnd - index - 1] ?? 0;
        }
      }

      const sourceNode = audioContext.createBufferSource();
      const filter = audioContext.createBiquadFilter();
      const gainNode = audioContext.createGain();
      const safeDuration = Math.min(0.68, reversedBuffer.duration);

      sourceNode.buffer = reversedBuffer;
      sourceNode.playbackRate.setValueAtTime(0.84, now);
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(2200, now);
      filter.Q.value = 0.55;

      gainNode.gain.setValueAtTime(0.0001, now);
      gainNode.gain.linearRampToValueAtTime(0.28, now + 0.028);
      gainNode.gain.setValueAtTime(0.28, now + Math.max(0.08, safeDuration - 0.12));
      gainNode.gain.exponentialRampToValueAtTime(0.0001, now + safeDuration);

      sourceNode.connect(filter);
      filter.connect(gainNode);
      gainNode.connect(outputChain.input);

      const activeVoice: PianoVoice = {
        gain: gainNode,
        sources: [sourceNode],
        nodes: [filter, gainNode],
      };

      activePianoVoicesRef.current.push(activeVoice);

      sourceNode.onended = () => {
        sourceNode.disconnect();
        filter.disconnect();
        gainNode.disconnect();
        activePianoVoicesRef.current = activePianoVoicesRef.current.filter(
          (voice) => voice !== activeVoice,
        );
      };

      sourceNode.start(now, 0, safeDuration);
      return "Reverse slice";
    }

    const tone = analyzeStepTone(audioBuffer, startTime);
    const noteDuration = 1.32;
    const crashMidis = [
      clampMidi(tone.midi - 5),
      clampMidi(tone.midi),
      clampMidi(tone.midi + 1),
      clampMidi(tone.midi + 7),
    ];
    const masterGain = audioContext.createGain();
    const toneFilter = audioContext.createBiquadFilter();
    const hammerFilter = audioContext.createBiquadFilter();
    const hammerGain = audioContext.createGain();
    const oscillators: OscillatorNode[] = [];
    const noteGains: GainNode[] = [];

    masterGain.gain.setValueAtTime(0.0001, now);
    masterGain.gain.linearRampToValueAtTime(0.26, now + 0.03);
    masterGain.gain.exponentialRampToValueAtTime(0.13, now + 0.28);
    masterGain.gain.exponentialRampToValueAtTime(0.05, now + 0.86);
    masterGain.gain.exponentialRampToValueAtTime(0.0001, now + noteDuration);

    toneFilter.type = "lowpass";
    toneFilter.frequency.setValueAtTime(2600, now);
    toneFilter.frequency.exponentialRampToValueAtTime(980, now + noteDuration);
    toneFilter.Q.value = 0.65;

    hammerFilter.type = "highpass";
    hammerFilter.frequency.value = 1700;
    hammerGain.gain.setValueAtTime(0.0001, now);
    hammerGain.gain.linearRampToValueAtTime(0.042, now + 0.008);
    hammerGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.075);

    crashMidis.forEach((midi, index) => {
      const frequency = midiToFrequency(midi);
      const fundamentalOsc = audioContext.createOscillator();
      const bodyOsc = audioContext.createOscillator();
      const shimmerOsc = audioContext.createOscillator();
      const noteGain = audioContext.createGain();
      const startOffset = index * 0.018;

      fundamentalOsc.type = "triangle";
      bodyOsc.type = "sine";
      shimmerOsc.type = "sine";

      fundamentalOsc.frequency.setValueAtTime(frequency, now + startOffset);
      bodyOsc.frequency.setValueAtTime(frequency * 2, now + startOffset);
      shimmerOsc.frequency.setValueAtTime(frequency * 3, now + startOffset);

      noteGain.gain.value = [0.34, 0.28, 0.24, 0.16][index] ?? 0.15;

      fundamentalOsc.connect(noteGain);
      bodyOsc.connect(noteGain);
      shimmerOsc.connect(noteGain);
      noteGain.connect(toneFilter);

      noteGains.push(noteGain);
      oscillators.push(fundamentalOsc, bodyOsc, shimmerOsc);
    });

    const hammerOsc = audioContext.createOscillator();
    hammerOsc.type = "triangle";
    hammerOsc.frequency.setValueAtTime(midiToFrequency(clampMidi(tone.midi + 12)) * 2.5, now);
    hammerOsc.connect(hammerFilter);
    hammerFilter.connect(hammerGain);

    toneFilter.connect(masterGain);
    hammerGain.connect(masterGain);
    masterGain.connect(outputChain.input);

    for (let index = 0; index < oscillators.length; index += 1) {
      const startOffset = Math.floor(index / 3) * 0.018;
      oscillators[index].start(now + startOffset);
      oscillators[index].stop(now + noteDuration + startOffset + 0.08);
    }

    hammerOsc.start(now);
    hammerOsc.stop(now + 0.1);

    const activeVoice: PianoVoice = {
      gain: masterGain,
      sources: [...oscillators, hammerOsc],
      nodes: [toneFilter, hammerFilter, hammerGain, masterGain, ...noteGains],
    };

    activePianoVoicesRef.current.push(activeVoice);

    oscillators[0].onended = () => {
      for (const source of activeVoice.sources) {
        source.disconnect();
      }

      for (const node of activeVoice.nodes) {
        node.disconnect();
      }

      activePianoVoicesRef.current = activePianoVoicesRef.current.filter(
        (voice) => voice !== activeVoice,
      );
    };

    return "Bad piano crash";
  };

  const pauseTransportPlayback = () => {
    const audioContext = audioContextRef.current;

    if (!audioContext || !sourceNodeRef.current) {
      return;
    }

    pausedAtRef.current = audioContext.currentTime - startedAtRef.current;
    stopPlayback();
    setAudioState("paused");
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

    handleSongSelection(createFileSong(file));
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

        handleSongSelection(createPathSong(mp3Path));
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
        stopSlicePlayback();
        clearIdleRelease();
        resetPerformanceClock();
        audioBufferRef.current = null;
        setDecodedAudioBuffer(null);
        pausedAtRef.current = 0;
        currentBeatIndexRef.current = 0;
        setPerformanceStep(0);
        setLastTriggeredBeat(null);
        setLastPianoNote("--");
        resetPromptGame();
        setPerformanceStatus("Load a song and start typing to step through detected beats.");
        setAudioState("idle");
        setTrackDuration(null);
        setAudioError(null);
        setPlayableSteps([]);
        return;
      }

      stopPlayback();
      stopSlicePlayback();
      clearIdleRelease();
      resetPerformanceClock();
      audioBufferRef.current = null;
      setDecodedAudioBuffer(null);
      pausedAtRef.current = 0;
      currentBeatIndexRef.current = 0;
      setPerformanceStep(0);
      setLastTriggeredBeat(null);
      setLastPianoNote("--");
      resetPromptGame();
      setPerformanceStatus("Decoding the selected MP3...");
      setAudioState("loading");
      setTrackDuration(null);
      setAudioError(null);
      setPlayableSteps([]);

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
        } else if (uploadedSong.url) {
          const response = await fetch(uploadedSong.url);

          if (!response.ok) {
            throw new Error("Unable to load the bundled demo song.");
          }

          arrayBuffer = await response.arrayBuffer();
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
      setPlayableSteps([]);
      currentBeatIndexRef.current = 0;
      lastPlayedStepIndexRef.current = null;
      pendingStepIndexRef.current = null;
      clearIdleRelease();
      resetPerformanceClock();
      setPerformanceStep(0);
      setLastTriggeredBeat(null);
      setLastPianoNote("--");
      resetPromptGame();
      setPerformanceStatus("Load a song and start typing to step through detected beats.");
      return;
    }

    setAnalysisState("loading");
    setAnalysisError(null);

    const runAnalysis = () => {
      try {
        const result = analyzeAudioBuffer(decodedAudioBuffer);
        const nextPlayableSteps = createPlayableStepMap(result);
        setAnalysisResult(result);
        setPlayableSteps(nextPlayableSteps);
        setAnalysisState("ready");
        currentBeatIndexRef.current = 0;
        lastPlayedStepIndexRef.current = null;
        pendingStepIndexRef.current = null;
        setPerformanceStep(0);
        setLastTriggeredBeat(null);
        setLastPianoNote("--");
        resetPromptGame();
        setPerformanceStatus(
          nextPlayableSteps.length > 0
            ? "Typing mode is ready. Press any key to advance through the playable step map."
            : "No reliable beats were detected for typing progression yet.",
        );

        console.log("Detected beat timestamps (s):", result.beatPositions);
        console.log("Detected energy peaks (s):", result.energyPeaks);
      } catch (error) {
        setAnalysisState("error");
        setAnalysisResult(null);
        setPlayableSteps([]);
        setAnalysisError(
          error instanceof Error ? error.message : "Unable to analyze the selected song.",
        );
      }
    };

    window.setTimeout(runAnalysis, 0);
  }, [decodedAudioBuffer]);

  useEffect(() => {
    if (!isPaceLocked) {
      clearPacedPlaybackTimer();
      pacedPlaybackUntilRef.current = 0;
    } else {
      scheduleNextPacedStep();
    }
  }, [analysisState, isPaceLocked, playableSteps, playbackMode, typingFeel]);

  useEffect(() => {
    return () => {
      clearIdleRelease();
      clearPacedPlaybackTimer();
      if (uiPulseTimerRef.current !== null) {
        window.clearTimeout(uiPulseTimerRef.current);
      }
      stopPlayback();
      stopSlicePlayback();
      void audioContextRef.current?.close();
      audioContextRef.current = null;
      outputChainRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (gameSourceMode !== "flow") {
      return;
    }

    if (promptCursor < promptStream.length - 180) {
      return;
    }

    setPromptStream((currentPrompt) => {
      return `${currentPrompt} ${buildPromptStream(nextPromptSeedIndex, APPEND_PROMPT_WORD_COUNT)}`;
    });
    setNextPromptSeedIndex((currentIndex) => {
      return (currentIndex + APPEND_PROMPT_WORD_COUNT) % PROMPT_WORD_BANK.length;
    });
  }, [gameSourceMode, promptCursor, promptStream.length, nextPromptSeedIndex]);

  useEffect(() => {
    setPromptCursor((currentCursor) => Math.min(currentCursor, Math.max(0, activePrompt.length - 1)));
  }, [activePrompt]);

  useEffect(() => {
    setPromptCursor(0);
    setIsGameActive(false);
  }, [gameSourceMode]);

  useEffect(() => {
    if (gameSourceMode === "lyrics") {
      setGameSourceMode("flow");
    }
  }, [gameSourceMode]);

  useEffect(() => {
    const handlePerformanceInput = (input: PerformanceKeyInput) => {
      if (shouldIgnoreDuplicateInput(input)) {
        return;
      }

      if (isRewindInput(input)) {
        const audioBuffer = audioBufferRef.current;
        const stepPositions = playableSteps;

        if (!audioBuffer || stepPositions.length === 0 || analysisState !== "ready") {
          return;
        }

        input.preventDefault?.();
        pauseTransportPlayback();
        clearIdleRelease();

        if (!canAcceptTriggerBurst()) {
          return;
        }

        void ensureAudioContext().then((audioContext) => {
          duckActiveVoices(audioContext);
        });

        if (currentBeatIndexRef.current <= 0) {
          setPerformanceStatus("Already at the beginning of the playable step map.");
          return;
        }

        const rewoundIndex = currentBeatIndexRef.current - 1;
        const rewoundBeat = stepPositions[rewoundIndex];
        performanceClockRef.current = {
          songStartTime: rewoundBeat,
          wallStartTime: Date.now(),
        };
        clearPacedPlaybackTimer();
        pacedPlaybackUntilRef.current = 0;
        lastPlayedStepIndexRef.current = null;
        pendingStepIndexRef.current = null;

        currentBeatIndexRef.current = rewoundIndex;
        setPerformanceStep(rewoundIndex);
        setLastTriggeredBeat(rewoundBeat);
        setLastPianoNote(playbackMode === "piano" ? "Crash chord" : "Reverse slice");
        if (isGameActive) {
          setPromptCursor((currentCursor) => Math.max(0, currentCursor - 1));
        }
        triggerUiPulse();
        setAudioError(null);
        setPerformanceStatus(
          `Rewound to step ${rewoundIndex} of ${stepPositions.length}.`,
        );

        void (async () => {
          try {
            const audioContext = await ensureAudioContext();
            const cueLabel = await playRewindCue(
              audioContext,
              audioBuffer,
              rewoundBeat,
              playbackMode,
              stepPositions,
              rewoundIndex,
            );
            setLastPianoNote(cueLabel);
          } catch (error) {
            setAudioError(
              error instanceof Error ? error.message : "Rewind cue playback failed.",
            );
          }
        })();

        return;
      }

      if (!isTypingPerformanceInput(input)) {
        return;
      }

      const audioBuffer = audioBufferRef.current;
      const stepPositions = playableSteps;

      if (!audioBuffer || stepPositions.length === 0 || analysisState !== "ready") {
        return;
      }

      let beatIndex = currentBeatIndexRef.current;

      if (beatIndex >= stepPositions.length) {
        currentBeatIndexRef.current = 0;
        lastPlayedStepIndexRef.current = null;
        pendingStepIndexRef.current = null;
        resetPerformanceClock();
        setPerformanceStep(0);
        beatIndex = 0;
      }

      input.preventDefault?.();
      pauseTransportPlayback();
      clearIdleRelease();

      const paceLockEnabled = isPaceLocked;

      if (!paceLockEnabled && !canAcceptTriggerBurst()) {
        return;
      }

      const typedCharacter = getTypedCharacterFromKey(input.key);
      const expectedCharacter = activePrompt[promptCursor]?.toLowerCase() ?? "";

      if (isGameActive && typedCharacter) {
        if (mistakeMode !== "off" && (!expectedCharacter || typedCharacter !== expectedCharacter)) {
          void (async () => {
            try {
              const audioContext = await ensureAudioContext();
              const referenceTime =
                stepPositions[Math.min(currentBeatIndexRef.current, stepPositions.length - 1)] ??
                null;
              await playMistakeCue(audioContext, audioBuffer, referenceTime);
            } catch {
              // Mistake cue is best-effort only.
            }
          })();

          if (mistakeMode === "strict") {
            setPromptCursor((currentCursor) => Math.max(0, currentCursor - 1));
          }
          setLastPianoNote("Mistake cue");
          triggerUiPulse();
          setPerformanceStatus(
            expectedCharacter
              ? `Mistake: expected ${expectedCharacter === " " ? "space" : `"${expectedCharacter}"`}.`
              : "Mistake: the phrase is complete. Keep going on the next prompt.",
          );
          return;
        } else {
          setPromptCursor((currentCursor) => Math.min(activePrompt.length, currentCursor + 1));
        }
      }

      let stepIndexToPlay = beatIndex;
      let startTime = stepPositions[beatIndex];

      if (paceLockEnabled) {
        if (!performanceClockRef.current) {
          performanceClockRef.current = {
            songStartTime: startTime,
            wallStartTime: Date.now(),
          };
        }

        if (currentBeatIndexRef.current >= stepPositions.length) {
          setPerformanceStatus("Reached the end of the playable step map.");
          return;
        }

        const now = Date.now();
        const isWindowActive = now < pacedPlaybackUntilRef.current;

        if (!isWindowActive) {
          performanceClockRef.current = {
            songStartTime: stepPositions[currentBeatIndexRef.current],
            wallStartTime: now,
          };
          pacedPlaybackUntilRef.current = now + typingFeelProfile.pacedWindowMs;
          scheduleNextPacedStep();
          setPerformanceStatus(
            `Keeping song pace flowing from step ${currentBeatIndexRef.current + 1} for ${(
              typingFeelProfile.pacedWindowMs / 1000
            ).toFixed(1)} seconds.`,
          );
        } else {
          setPerformanceStatus(
            `Song pace is already flowing through step ${currentBeatIndexRef.current + 1}.`,
          );
        }

        triggerUiPulse();
        return;
      }

      resetPerformanceClock();

      const isDuplicateStep =
        pendingStepIndexRef.current === stepIndexToPlay ||
        lastPlayedStepIndexRef.current === stepIndexToPlay;

      if (isDuplicateStep) {
        setLastTriggeredBeat(startTime);
        triggerUiPulse();
        scheduleIdleRelease();
        setPerformanceStatus(
          `Holding step ${stepIndexToPlay + 1} of ${stepPositions.length} until the next trigger.`,
        );
        return;
      }

      currentBeatIndexRef.current = Math.max(
        currentBeatIndexRef.current,
        stepIndexToPlay + 1,
      );
      setPerformanceStep(currentBeatIndexRef.current);

      void performStepPlayback(
        audioBuffer,
        stepPositions,
        stepIndexToPlay,
        false,
        (playedLabel) =>
          `Played ${playedLabel} on step ${currentBeatIndexRef.current} of ${stepPositions.length}.`,
      );
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      handlePerformanceInput({
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        repeat: event.repeat,
        target: event.target,
        preventDefault: () => event.preventDefault(),
        source: "window",
      });
    };

    let globalKeypressUnlisten: UnlistenFn | null = null;
    let globalKeypressErrorUnlisten: UnlistenFn | null = null;
    let cancelled = false;

    window.addEventListener("keydown", handleKeyDown);

    void listen<GlobalKeypressPayload>("global-keypress", (event) => {
      if (cancelled) {
        return;
      }

      setBackgroundTypingState("enabled");
      setBackgroundTypingMessage("Background typing is on.");
      handlePerformanceInput({
        key: event.payload.key,
        source: "global",
      });
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
        return;
      }

      globalKeypressUnlisten = unlisten;
    });

    void listen<string>("global-keypress-error", () => {
      if (cancelled) {
        return;
      }

      setBackgroundTypingState("error");
      setBackgroundTypingMessage(
        "Permission needed: System Settings → Privacy & Security → Input Monitoring → allow this app. Then quit and re-run: npm run tauri dev",
      );
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
        return;
      }

      globalKeypressErrorUnlisten = unlisten;
    });

    return () => {
      cancelled = true;
      window.removeEventListener("keydown", handleKeyDown);
      globalKeypressUnlisten?.();
      globalKeypressErrorUnlisten?.();
    };
  }, [
    analysisState,
    playableSteps,
    playbackMode,
    isPaceLocked,
    typingFeel,
    activePrompt,
    promptCursor,
    mistakeMode,
    isGameActive,
  ]);

  const handleEnableBackgroundTyping = async () => {
    if (backgroundTypingState === "enabled" || backgroundTypingState === "enabling") {
      return;
    }

    setBackgroundTypingState("enabling");
    setBackgroundTypingMessage(
      "Trying to enable background typing. macOS may ask for permission once.",
    );

    try {
      await invoke("enable_background_typing");
      setBackgroundTypingState("enabled");
      setBackgroundTypingMessage(
        "Background typing is on. Type in any window to trigger sounds.",
      );
    } catch (error) {
      setBackgroundTypingState("error");
      setBackgroundTypingMessage(
        error instanceof Error
          ? error.message
          : "Unable to enable background typing.",
      );
    }
  };

  const handleDisableBackgroundTyping = async () => {
    setBackgroundTypingState("idle");
    setBackgroundTypingMessage("");

    try {
      await invoke("disable_background_typing");
    } catch (error) {
      setBackgroundTypingState("error");
      setBackgroundTypingMessage(
        error instanceof Error ? error.message : "Unable to disable background typing.",
      );
    }
  };

  const handlePlay = async () => {
    const audioBuffer = audioBufferRef.current;

    if (!audioBuffer) {
      return;
    }

    const audioContext = await ensureAudioContext();
    const outputChain = ensureOutputChain(audioContext);
    const sourceNode = audioContext.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.connect(outputChain.input);
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
    pauseTransportPlayback();
  };

  const beatPreview = analysisResult?.beatPositions.slice(0, 16) ?? [];
  const peakPreview = analysisResult?.energyPeaks.slice(0, 12) ?? [];
  const boothCaption = isGameActive
    ? mistakeMode === "off"
      ? "The booth is live with mistakes ignored."
      : "Type the line exactly, including spaces, to keep the rhythm clean."
    : "Open the booth when you want the typing line in focus.";

  return (
    <main className="shell shell-ready">
      <section className="app-shell">
        <div className="workspace-grid">
          <section
            ref={dropzoneRef}
            className={`panel track-panel ${isDragActive ? "track-panel-active" : ""}`}
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

            <div className="panel-head">
              <div>
                <p className="panel-label">Track deck</p>
                <h2 className="panel-title">Load the song</h2>
              </div>
            </div>

            <div className="dropzone-card">
              <div className="dropzone-icon" aria-hidden="true">
                ♪
              </div>
              <p className="dropzone-title">Drag and drop an MP3 here</p>
              <p className="dropzone-caption">
                {uploadedSong
                  ? uploadedSong.isDefault
                    ? "The bundled piano demo is ready until you replace it."
                    : "Imported songs stay in the deck so you can switch between them."
                  : "Imported songs stay in the deck so you can switch between them."}
              </p>

              <button
                className="browse-button"
                type="button"
                onClick={() => fileInputRef.current?.click()}
              >
                Choose MP3
              </button>

              <div className="song-switcher" aria-label="Saved songs">
                <button
                  className="song-nav-button"
                  type="button"
                  onClick={() => handleSavedSongStep(-1)}
                  disabled={!canSelectPreviousSong}
                  aria-label="Previous saved song"
                >
                  ←
                </button>
                <div className="song-switcher-status">
                  <p className="song-switcher-count">
                    Saved songs {savedSongs.length > 0 ? activeSongIndex + 1 : 0}/{savedSongs.length}
                  </p>
                  <p className="song-switcher-name">
                    {uploadedSong?.name ?? "No saved songs yet"}
                  </p>
                </div>
                <button
                  className="song-nav-button"
                  type="button"
                  onClick={() => handleSavedSongStep(1)}
                  disabled={!canSelectNextSong}
                  aria-label="Next saved song"
                >
                  →
                </button>
              </div>
            </div>

            <div className="dropzone-status" aria-live="polite">
              {uploadedSong ? (
                <>
                  <p className="status-label">
                    {uploadedSong.isDefault ? "Default song" : "Loaded song"}
                  </p>
                  <p className="status-file">{uploadedSong.name}</p>
                  <p className="status-meta">
                    Web Audio buffer: {audioState} • {formatTime(trackDuration)}
                  </p>
                  <p className="status-meta">
                    Playable steps: {playableSteps.length}
                  </p>
                </>
              ) : (
                <p className="status-placeholder">No song selected yet.</p>
              )}

              {uploadError ? <p className="status-error">{uploadError}</p> : null}
              {audioError ? <p className="status-error">{audioError}</p> : null}
            </div>

            <div className="transport transport-inline">
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
                Preview the track here before using it for rhythm analysis and typing.
              </p>
            </div>
          </section>

          <section
            className={`panel control-panel ${isUiPulseActive ? "control-panel-pulse" : ""}`}
            aria-live="polite"
          >
            <div className="panel-head">
              <div>
                <p className="panel-label">Performance desk</p>
                <h2 className="panel-title">Shape the response</h2>
              </div>
            </div>

            <p className="analysis-summary">{performanceStatus}</p>

            <div className="mode-switch" role="group" aria-label="Typing playback mode">
              <button
                className={`mode-button ${playbackMode === "slices" ? "mode-button-active" : ""}`}
                type="button"
                onClick={() => setPlaybackMode("slices")}
              >
                Song slices
              </button>
              <button
                className={`mode-button ${playbackMode === "piano" ? "mode-button-active" : ""}`}
                type="button"
                onClick={() => setPlaybackMode("piano")}
              >
                Piano interpretation
              </button>
            </div>

            <div className="control-grid">
              <div className="pace-panel">
                <label className="pace-label" htmlFor="pace-lock">
                  Pace control
                </label>
                <div className="pace-toggle-row">
                  <span className={`pace-option ${!isPaceLocked ? "pace-option-active" : ""}`}>
                    Follow typing
                  </span>
                  <button
                    id="pace-lock"
                    className={`pace-toggle ${isPaceLocked ? "pace-toggle-active" : ""}`}
                    type="button"
                    role="switch"
                    aria-checked={isPaceLocked}
                    aria-label="Keep song pace"
                    onClick={() => setIsPaceLocked((value) => !value)}
                  >
                    <span className="pace-toggle-knob" />
                  </button>
                  <span className={`pace-option ${isPaceLocked ? "pace-option-active" : ""}`}>
                    Keep song pace
                  </span>
                </div>
              </div>

              <div className="feel-panel">
                <label className="pace-label">
                  Typing feel
                </label>
                <div className="feel-options" role="group" aria-label="Typing feel">
                  {TYPING_FEELS.map((feel) => (
                    <button
                      key={feel}
                      className={`feel-option-button ${
                        typingFeel === feel ? "feel-option-button-active" : ""
                      }`}
                      type="button"
                      onClick={() => setTypingFeel(feel)}
                    >
                      {feel === "slowest"
                        ? "Slowest"
                        : feel === "high"
                          ? "High"
                          : feel === "normal"
                            ? "Normal"
                            : "Slow"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="feel-panel">
                <label className="pace-label">
                  Mistake mode
                </label>
                <div className="feel-options" role="group" aria-label="Mistake mode">
                  {MISTAKE_MODES.map((mode) => (
                    <button
                      key={mode}
                      className={`feel-option-button ${
                        mistakeMode === mode ? "feel-option-button-active" : ""
                      }`}
                      type="button"
                      onClick={() => setMistakeMode(mode)}
                    >
                      {mode === "off" ? "Off" : mode === "normal" ? "Normal" : "Strict"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="feel-panel">
                <label className="pace-label">Game source</label>
                <div className="mode-switch" role="group" aria-label="Typing game source">
                  <button
                    className={`mode-button ${gameSourceMode === "flow" ? "mode-button-active" : ""}`}
                    type="button"
                    onClick={() => setGameSourceMode("flow")}
                  >
                    Flow lane
                  </button>
                  <button
                    className="mode-button mode-button-disabled"
                    type="button"
                    disabled
                    aria-disabled="true"
                  >
                    Lyrics mode (WIP)
                  </button>
                </div>
              </div>
            </div>

            <div className="background-panel">
              <label className="pace-label">Use in background</label>
              <div className="pace-toggle-row">
                <button
                  className={`background-button ${
                    backgroundTypingState === "enabled" ? "background-button-active" : ""
                  }`}
                  type="button"
                  onClick={() =>
                    void (
                      backgroundTypingState === "enabled"
                        ? handleDisableBackgroundTyping()
                        : handleEnableBackgroundTyping()
                    )
                  }
                  disabled={backgroundTypingState === "enabling"}
                  aria-label={
                    backgroundTypingState === "enabled"
                      ? "Disable background typing"
                      : "Enable background typing"
                  }
                >
                  {backgroundTypingState === "enabled"
                    ? "Turn background typing off"
                    : backgroundTypingState === "enabling"
                      ? "Enabling..."
                      : "Enable background typing"}
                </button>
              </div>
              <p className="prompt-caption">{backgroundTypingMessage}</p>
            </div>

            <div className="booth-launch">
              <div>
                <p className="prompt-label">Typing booth</p>
                <p className="booth-title">Open the live line in a focused pop-up.</p>
                <p className="prompt-caption">{boothCaption}</p>
              </div>
              <div className="prompt-actions">
                <button
                  className="prompt-button"
                  type="button"
                  onClick={() => setIsTypingBoothOpen(true)}
                >
                  Open booth
                </button>
                <button
                  className="prompt-button prompt-button-secondary"
                  type="button"
                  onClick={resetPromptGame}
                >
                  Reset lane
                </button>
              </div>
            </div>

            <div className="typing-stats">
              <div className="typing-stat">
                <p className="typing-stat-label">Current step</p>
                <p className="typing-stat-value">
                  {performanceStep}/{playableSteps.length}
                </p>
              </div>

              <div className="typing-stat">
                <p className="typing-stat-label">Last beat</p>
                <p className="typing-stat-value">
                  {lastTriggeredBeat === null ? "--:--" : `${lastTriggeredBeat.toFixed(2)}s`}
                </p>
              </div>

              <div className="typing-stat">
                <p className="typing-stat-label">
                  {playbackMode === "piano" ? "Last note" : "Last mode"}
                </p>
                <p className="typing-stat-value">{lastPianoNote}</p>
              </div>
            </div>
          </section>
        </div>

        <section className="analysis-panel panel" aria-live="polite">
          <div className="panel-head">
            <div>
              <p className="panel-label">Rhythm analysis</p>
              <h2 className="panel-title">Pulse map</h2>
            </div>
            <div className="panel-head-actions">
              <button
                className={`info-button ${isPulseInfoOpen ? "info-button-active" : ""}`}
                type="button"
                aria-expanded={isPulseInfoOpen}
                aria-controls="pulse-map-info"
                aria-label="Explain how Pulse map works"
                onClick={() => setIsPulseInfoOpen((current) => !current)}
              >
                i
              </button>
            </div>
          </div>

          {isPulseInfoOpen ? (
            <div id="pulse-map-info" className="analysis-explainer">
              <p className="analysis-card-label">How it works</p>
              <p className="analysis-note">
                Pulse Map scans the decoded audio in short frames, measures frame energy, then
                finds local peaks that look like attacks or accents.
              </p>
              <p className="analysis-note">
                It builds a histogram of time gaps between nearby peaks, normalizes those gaps into
                a BPM range, and picks the strongest cluster as the estimated tempo.
              </p>
              <p className="analysis-note">
                From that tempo it seeds a beat grid, snaps predicted beats toward nearby peaks,
                then thins the result into a playable step map so the typing response lands on
                stronger musical moments instead of every transient.
              </p>
            </div>
          ) : null}

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
            </>
          ) : null}
        </section>
      </section>

      {isTypingBoothOpen ? (
        <div
          className="typing-booth-backdrop"
          role="presentation"
          onClick={() => setIsTypingBoothOpen(false)}
        >
          <section
            className="typing-booth"
            role="dialog"
            aria-modal="true"
            aria-label="Typing booth"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="booth-header">
              <div>
                <p className="prompt-label">Typing booth</p>
                <p className="booth-title">Focused typing lane</p>
              </div>
              <button
                className="prompt-button prompt-button-secondary"
                type="button"
                onClick={() => setIsTypingBoothOpen(false)}
              >
                Close
              </button>
            </div>

            <div className="prompt-card" aria-live="polite">
              <div className="prompt-header">
                <p className="prompt-label">Typing game</p>
                <div className="prompt-actions">
                  <button
                    className="prompt-button"
                    type="button"
                    onClick={() => setIsGameActive((current) => !current)}
                  >
                    {isGameActive ? "Pause game" : "Play game"}
                  </button>
                  <button
                    className="prompt-button prompt-button-secondary"
                    type="button"
                    onClick={resetPromptGame}
                  >
                    Reset
                  </button>
                </div>
              </div>
              <div className="prompt-stream-viewport" aria-hidden="true">
                <div className={`prompt-stream-track ${isGameActive ? "prompt-stream-active" : ""}`}>
                  <span className="prompt-done">{visiblePrompt.slice(0, visibleCursorIndex)}</span>
                  <span className="prompt-current">
                    {activePrompt[promptCursor] ?? " "}
                  </span>
                  <span className="prompt-remaining">
                    {visiblePrompt.slice(visibleCursorIndex + 1)}
                  </span>
                </div>
              </div>
              <p className="prompt-caption">{boothCaption}</p>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

export default App;
