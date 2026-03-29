import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";

type UploadedSong = {
  name: string;
  path?: string;
  file?: File;
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
  const [audioError, setAudioError] = useState<string | null>(null);
  const [audioState, setAudioState] = useState<
    "idle" | "loading" | "ready" | "playing" | "paused"
  >("idle");
  const [trackDuration, setTrackDuration] = useState<number | null>(null);

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
        pausedAtRef.current = 0;
        setAudioState("idle");
        setTrackDuration(null);
        setAudioError(null);
        return;
      }

      stopPlayback();
      audioBufferRef.current = null;
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
        setTrackDuration(decodedBuffer.duration);
        setAudioState("ready");
      } catch (error) {
        if (cancelled) {
          return;
        }

        audioBufferRef.current = null;
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
      </section>
    </main>
  );
}

export default App;
