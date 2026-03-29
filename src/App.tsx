import { useState } from "react";
import "./App.css";

function App() {
  const [isDragActive, setIsDragActive] = useState(false);

  const handleDragState = (isActive: boolean) => {
    setIsDragActive(isActive);
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
        }}
      >
        <div className="dropzone-icon" aria-hidden="true">
          ♪
        </div>
        <p className="dropzone-title">Drag and drop an MP3 here</p>
        <p className="dropzone-caption">
          A default song will come later. For now, this is the upload landing
          zone.
        </p>
      </section>
    </main>
  );
}

export default App;
