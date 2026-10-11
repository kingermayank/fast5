/**
 * Voiceover through the browser's built-in text-to-speech. Each character gets
 * a pitch/rate profile and, where the system has them, a male or female voice.
 * Subtitles are always shown, so a browser without speech still works.
 */
interface Profile {
  pitch: number;
  rate: number;
  female: boolean;
}

const PROFILES: Record<string, Profile> = {
  DOM: { pitch: 0.45, rate: 0.85, female: false },
  BRIAN: { pitch: 1.0, rate: 1.05, female: false },
  HOBBS: { pitch: 0.6, rate: 0.95, female: false },
  MIA: { pitch: 1.1, rate: 1.05, female: true },
  ELENA: { pitch: 1.0, rate: 1.0, female: true },
};

const FEMALE_HINTS = /female|samantha|victoria|karen|zira|susan|moira|tessa|fiona|serena|allison|ava|joanna|salli|kimberly/i;

export class Voice {
  enabled = 'speechSynthesis' in window;
  private voices: SpeechSynthesisVoice[] = [];

  constructor() {
    if (!this.enabled) return;
    const load = () => {
      this.voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'));
    };
    load();
    speechSynthesis.addEventListener?.('voiceschanged', load);
  }

  speak(speaker: string, text: string): void {
    if (!this.enabled) return;
    const p = PROFILES[speaker] ?? { pitch: 1, rate: 1, female: false };
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const pool = this.voices.filter((v) => FEMALE_HINTS.test(v.name) === p.female);
      const voice = pool[0] ?? this.voices[0];
      if (voice) u.voice = voice;
      u.pitch = p.pitch;
      u.rate = p.rate;
      u.volume = 1;
      speechSynthesis.speak(u);
    } catch {
      // Speech is optional; subtitles carry the line.
    }
  }

  stop(): void {
    if (this.enabled) speechSynthesis.cancel();
  }
}
