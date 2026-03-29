import { useEffect, useRef, useState } from "react";
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
  const [isDragActive, setIsDragActive] = useState(false);
  const [uploadedSong, setUploadedSong] = useState<UploadedSong | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

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
            </>
          ) : (
            <p className="status-placeholder">No song selected yet.</p>
          )}

          {uploadError ? <p className="status-error">{uploadError}</p> : null}
        </div>
      </section>
    </main>
  );
}

export default App;
