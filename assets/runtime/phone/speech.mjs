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

// How close a voice sounds to a person, judged by its name. Edge's "Online (Natural)"
// voices and Safari's Premium and Enhanced ones are neural and sound closest; Chrome's
// "Google" voices come next. The old desktop voices and eSpeak sound robotic.
const VOICE_RANKS = [
  [/natural|neural/i, 50],
  [/premium/i, 40],
  [/enhanced/i, 30],
  [/^google\b/i, 20],
];
// Adult voices that read conversationally, among the good ones.
const CONVERSATIONAL =
  /\b(ava|andrew|emma|brian|aria|jenny|guy|michelle|christopher|samantha|allison|evan|zoe)(multilingual)?\b/i;
const ROBOTIC = /espeak|desktop|\b(david|zira|mark|hazel)\b/i;
// Edge's Ana is a child's voice.
const CHILD = /\bana online\b/i;

const normalLang = (lang) => (lang || "").toLowerCase().replace("_", "-");

function voiceScore(voice, want) {
  let score = normalLang(voice.lang) === want ? 5 : 0;
  const rank = VOICE_RANKS.find(([pattern]) => pattern.test(voice.name));
  if (rank) score += rank[1];
  if (CONVERSATIONAL.test(voice.name)) score += 8;
  if (ROBOTIC.test(voice.name)) score -= 30;
  if (CHILD.test(voice.name)) score -= 40;
  if (!voice.localService) score += 3;
  return score;
}

/** The browser's voices in the page's language, most human sounding first. */
export function rankedVoices(lang = navigator.language || "en-US") {
  if (!("speechSynthesis" in window)) return [];
  const want = normalLang(lang);
  const base = want.split("-")[0];
  return window.speechSynthesis
    .getVoices()
    .filter((v) => normalLang(v.lang).split("-")[0] === base)
    .map((voice) => ({ voice, score: voiceScore(voice, want) }))
    .sort((a, b) => b.score - a.score || a.voice.name.localeCompare(b.voice.name))
    .map((x) => x.voice);
}

export function isNaturalVoice(voice) {
  return Boolean(voice) && /natural|neural|premium|enhanced/i.test(voice.name);
}

/** "Microsoft Aria Online (Natural) - English (United States)" → "Aria (Natural)". */
export function voiceLabel(voice) {
  return voice.name
    .replace(/\s+-\s+.*$/, "")
    .replace(/^(Microsoft|Google|Apple)\s+/i, "")
    .replace(/\s+Online\b/i, "")
    .trim();
}

/** Voices load after the page in Chrome; call back now and whenever the list changes. */
export function onVoices(callback) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.addEventListener("voiceschanged", callback);
  callback();
}

/** Markdown as a person would say it: no marks, abbreviations read out, lines as sentences. */
export function speakable(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, " The code is on your screen. ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\w)_(\w)/g, "$1 $2")
    .replace(/[*_`#>]/g, "")
    .replace(/\be\.g\.,?/gi, "for example,")
    .replace(/\bi\.e\.,?/gi, "that is,")
    .replace(/\bvs\.?(?=\s)/gi, "versus")
    .replace(/\s&\s/g, " and ")
    .replace(/([^.!?:;,\s])[ \t]*\n+/g, "$1. ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Sentences grouped into utterances of at most `max` characters. Short utterances
 * keep Chrome's network voices from cutting out partway, and the gap between them
 * lands where a speaker would breathe.
 */
export function speechChunks(text, max = 220) {
  const pieces = text
    .split(/(?<=[.!?])\s+/)
    .flatMap((sentence) => (sentence.length <= max ? [sentence] : sentence.split(/(?<=,)\s+/)));
  const chunks = [];
  for (const piece of pieces) {
    const last = chunks.at(-1);
    if (last !== undefined && last.length + piece.length + 1 <= max)
      chunks[chunks.length - 1] = `${last} ${piece}`;
    else chunks.push(piece);
  }
  return chunks.filter((c) => c.trim());
}

/** Read text aloud in `voice` (the best one if not given), cancelling anything still being read. */
export function speak(text, voice = rankedVoices()[0]) {
  if (!("speechSynthesis" in window) || !text.trim()) return;
  window.speechSynthesis.cancel();
  for (const chunk of speechChunks(text)) {
    const utterance = new SpeechSynthesisUtterance(chunk);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
    // Neural voices pace themselves; the older ones sound better a touch slower.
    utterance.rate = isNaturalVoice(voice) ? 1 : 0.95;
    window.speechSynthesis.speak(utterance);
  }
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
