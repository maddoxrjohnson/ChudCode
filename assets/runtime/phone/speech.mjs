/**
 * The browser's speech: reading the interviewer aloud, and turning the learner's
 * answer into text while timing it. Both are optional; the page works by typing.
 *
 * Recognition is the Web Speech API (Chrome and Edge, which send the audio to their
 * speech service). It runs continuously while the mic is on, restarting itself when
 * the browser ends a segment, and counts silences over three seconds between results.
 */

const LONG_PAUSE_MS = 3_000;

export function speechSupport() {
  const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  return { recognition: Boolean(Recognition), synthesis: "speechSynthesis" in window };
}

/** Read text aloud, cancelling anything still being read. */
export function speak(text) {
  if (!("speechSynthesis" in window) || !text.trim()) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.02;
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking() {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

/**
 * A recorder: `start()` and `stop()`; `onText(final, interim)` fires as words arrive.
 * `stop()` returns the measurement for the answer: how long the mic was on and how
 * many long silences it heard.
 */
export function createRecorder({ onText, onState }) {
  const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (!Recognition) return null;
  let recognition = null;
  let active = false;
  let finalText = "";
  let startedAt = 0;
  let lastHeard = 0;
  let longPauses = 0;

  function open() {
    recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";
    recognition.onresult = (event) => {
      const now = Date.now();
      if (lastHeard && now - lastHeard > LONG_PAUSE_MS) longPauses++;
      lastHeard = now;
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalText += `${result[0].transcript.trim()} `;
        else interim += result[0].transcript;
      }
      onText(finalText.trim(), interim.trim());
    };
    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        active = false;
        onState("blocked");
      }
    };
    // Chrome ends a segment after a silence; keep listening until the learner stops.
    recognition.onend = () => {
      if (active) {
        try {
          recognition.start();
        } catch {
          active = false;
          onState("stopped");
        }
      }
    };
    recognition.start();
  }

  return {
    get active() {
      return active;
    },
    start(existing = "") {
      if (active) return;
      finalText = existing ? `${existing.trim()} ` : "";
      startedAt = Date.now();
      lastHeard = startedAt;
      longPauses = 0;
      active = true;
      onState("listening");
      try {
        open();
      } catch {
        active = false;
        onState("blocked");
      }
    },
    stop() {
      const durationMs = startedAt ? Date.now() - startedAt : 0;
      active = false;
      try {
        recognition?.stop();
      } catch {
        // already stopped
      }
      onState("stopped");
      return { durationMs, longPauses };
    },
  };
}
