// Sound effects for Oracle Office

// Audio context — unlocked by user interaction
let audioCtx: AudioContext | null = null;
let unlocked = false;

/** Generate a short tick sound via Web Audio API */
function playTick() {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.frequency.value = 1200;
  osc.type = "sine";
  gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.08);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.08);
}

/** Unlock audio on first user click/tap — plays a small tick so human knows sound is on */
export function unlockAudio() {
  if (unlocked) return;
  try {
    audioCtx = new AudioContext();
    if (audioCtx.state === "suspended") audioCtx.resume();
    playTick();
    unlocked = true;
  } catch {}
}

export function isAudioUnlocked() { return unlocked; }

/** Set by store — checked before playing sounds */
let _muted = false;
export function setSoundMuted(m: boolean) { _muted = m; }
export function isSoundMuted() { return _muted; }

// --- Sound profiles ---

export type SoundProfile = "saiyan" | "ping" | "chime" | "bell" | "none";

export const SOUND_PROFILES: { id: SoundProfile; label: string; emoji: string }[] = [
  { id: "saiyan", label: "Super Saiyan", emoji: "⚡" },
  { id: "ping", label: "Ping", emoji: "🔔" },
  { id: "chime", label: "Chime", emoji: "🎵" },
  { id: "bell", label: "Bell", emoji: "🔕" },
  { id: "none", label: "Silent", emoji: "🤫" },
];

let _soundProfile: SoundProfile = (localStorage.getItem("office-sound") as SoundProfile) || "ping";
export function getSoundProfile() { return _soundProfile; }
export function setSoundProfile(p: SoundProfile) {
  _soundProfile = p;
  localStorage.setItem("office-sound", p);
}

// --- Saiyan (MP3) ---
const saiyanSounds = ["/office/saiyan.mp3", "/office/saiyan-aura.mp3", "/office/saiyan-rose.mp3", "/office/saiyan-2.mp3"];
const SAIYAN_MAX_PLAY = 3;
const SAIYAN_FADE_MS = 1500;

function playSaiyanInternal() {
  try {
    const src = saiyanSounds[Math.floor(Math.random() * saiyanSounds.length)];
    const audio = new Audio(src);
    audio.volume = 0.3;
    audio.play().catch(() => {});
    setTimeout(() => {
      const startVol = audio.volume;
      const steps = 30;
      const stepMs = SAIYAN_FADE_MS / steps;
      let step = 0;
      const fade = setInterval(() => {
        step++;
        audio.volume = Math.max(0, startVol * (1 - step / steps));
        if (step >= steps) { clearInterval(fade); audio.pause(); }
      }, stepMs);
    }, SAIYAN_MAX_PLAY * 1000);
  } catch {}
}

// --- Synthesized sounds (Web Audio API) ---

function playPing() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.frequency.setValueAtTime(880, t);
  osc.frequency.setValueAtTime(1320, t + 0.08);
  osc.type = "sine";
  gain.gain.setValueAtTime(0.15, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
  osc.start(t);
  osc.stop(t + 0.3);
}

function playChime() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  [523, 659, 784].forEach((freq, i) => {
    const osc = audioCtx!.createOscillator();
    const gain = audioCtx!.createGain();
    osc.connect(gain);
    gain.connect(audioCtx!.destination);
    osc.frequency.value = freq;
    osc.type = "sine";
    const start = t + i * 0.12;
    gain.gain.setValueAtTime(0.12, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.4);
    osc.start(start);
    osc.stop(start + 0.4);
  });
}

function playBell() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.frequency.value = 600;
  osc.type = "triangle";
  gain.gain.setValueAtTime(0.2, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
  osc.start(t);
  osc.stop(t + 0.6);
}

/** Play notification sound based on current profile */
export function playNotificationSound() {
  if (!unlocked || _muted) return;
  switch (_soundProfile) {
    case "saiyan": playSaiyanInternal(); break;
    case "ping": playPing(); break;
    case "chime": playChime(); break;
    case "bell": playBell(); break;
    case "none": break;
  }
}

// --- Per-Oracle Wake Sounds (Web Audio API) ---

/** Bell ding — crisp metallic tone with harmonic overtone */
function playWakeBell() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  // Main tone: 1200Hz → 800Hz sine
  const osc1 = audioCtx.createOscillator();
  const gain1 = audioCtx.createGain();
  osc1.connect(gain1);
  gain1.connect(audioCtx.destination);
  osc1.frequency.setValueAtTime(1200, t);
  osc1.frequency.exponentialRampToValueAtTime(800, t + 0.15);
  osc1.type = "sine";
  gain1.gain.setValueAtTime(0.15, t);
  gain1.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
  osc1.start(t);
  osc1.stop(t + 0.5);
  // Overtone: 2400Hz → 1600Hz sine (quieter)
  const osc2 = audioCtx.createOscillator();
  const gain2 = audioCtx.createGain();
  osc2.connect(gain2);
  gain2.connect(audioCtx.destination);
  osc2.frequency.setValueAtTime(2400, t);
  osc2.frequency.exponentialRampToValueAtTime(1600, t + 0.1);
  osc2.type = "sine";
  gain2.gain.setValueAtTime(0.08, t);
  gain2.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
  osc2.start(t);
  osc2.stop(t + 0.3);
}

/** Wave splash — filtered noise burst with warm undertone */
function playWakeSplash() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  // White noise burst with envelope
  const bufferSize = audioCtx.sampleRate * 0.6;
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 2);
  }
  const noise = audioCtx.createBufferSource();
  noise.buffer = buffer;
  // Bandpass filter sweeping 2000Hz → 400Hz
  const filter = audioCtx.createBiquadFilter();
  filter.type = "bandpass";
  filter.Q.value = 2;
  filter.frequency.setValueAtTime(2000, t);
  filter.frequency.exponentialRampToValueAtTime(400, t + 0.5);
  const noiseGain = audioCtx.createGain();
  noiseGain.gain.setValueAtTime(0.12, t);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
  noise.connect(filter);
  filter.connect(noiseGain);
  noiseGain.connect(audioCtx.destination);
  noise.start(t);
  noise.stop(t + 0.6);
  // Warm sine undertone: 500Hz → 250Hz
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.frequency.setValueAtTime(500, t);
  osc.frequency.exponentialRampToValueAtTime(250, t + 0.4);
  osc.type = "sine";
  gain.gain.setValueAtTime(0.1, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
  osc.start(t);
  osc.stop(t + 0.5);
}

/** Digital hum — low-frequency pulse with harmonic shimmer (Neo's signature) */
function playWakeDigital() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  // Low pulse: 220Hz square wave, fast decay
  const osc1 = audioCtx.createOscillator();
  const gain1 = audioCtx.createGain();
  osc1.connect(gain1);
  gain1.connect(audioCtx.destination);
  osc1.frequency.setValueAtTime(220, t);
  osc1.frequency.exponentialRampToValueAtTime(330, t + 0.2);
  osc1.type = "square";
  gain1.gain.setValueAtTime(0.06, t);
  gain1.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
  osc1.start(t);
  osc1.stop(t + 0.4);
  // High shimmer: 1760Hz sine
  const osc2 = audioCtx.createOscillator();
  const gain2 = audioCtx.createGain();
  osc2.connect(gain2);
  gain2.connect(audioCtx.destination);
  osc2.frequency.setValueAtTime(1760, t + 0.05);
  osc2.frequency.exponentialRampToValueAtTime(1320, t + 0.3);
  osc2.type = "sine";
  gain2.gain.setValueAtTime(0.0, t);
  gain2.gain.linearRampToValueAtTime(0.1, t + 0.05);
  gain2.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
  osc2.start(t);
  osc2.stop(t + 0.35);
}

/** Heartbeat pulse — warm thump-thump (Pulse's signature) */
function playWakeHeartbeat() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  for (let i = 0; i < 2; i++) {
    const offset = i * 0.2;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.setValueAtTime(80, t + offset);
    osc.frequency.exponentialRampToValueAtTime(40, t + offset + 0.15);
    osc.type = "sine";
    gain.gain.setValueAtTime(0.2, t + offset);
    gain.gain.exponentialRampToValueAtTime(0.001, t + offset + 0.2);
    osc.start(t + offset);
    osc.stop(t + offset + 0.2);
  }
}

/** Whisper whoosh — breathy filtered noise (Hermes's signature) */
function playWakeWhisper() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const bufferSize = audioCtx.sampleRate * 0.4;
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    // Smooth envelope: sine-shaped rise and fall
    const env = Math.sin((i / bufferSize) * Math.PI);
    data[i] = (Math.random() * 2 - 1) * env;
  }
  const noise = audioCtx.createBufferSource();
  noise.buffer = buffer;
  const filter = audioCtx.createBiquadFilter();
  filter.type = "highpass";
  filter.frequency.setValueAtTime(800, t);
  filter.frequency.exponentialRampToValueAtTime(3000, t + 0.3);
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.1, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
  noise.connect(filter);
  filter.connect(gain);
  gain.connect(audioCtx.destination);
  noise.start(t);
  noise.stop(t + 0.4);
}

/** Two-tone ascending chime — generic wake sound for unknown oracles */
function playWakeGeneric() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  [660, 880].forEach((freq, i) => {
    const osc = audioCtx!.createOscillator();
    const gain = audioCtx!.createGain();
    osc.connect(gain);
    gain.connect(audioCtx!.destination);
    osc.frequency.value = freq;
    osc.type = "sine";
    const start = t + i * 0.15;
    gain.gain.setValueAtTime(0.12, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.4);
    osc.start(start);
    osc.stop(start + 0.4);
  });
}

/** Map oracle names to wake sound functions */
const ORACLE_WAKE_SOUNDS: Record<string, () => void> = {
  "neo": playWakeDigital,
  "pulse": playWakeHeartbeat,
  "hermes": playWakeWhisper,
  "nexus": playWakeBell,
  "odin": playWakeSplash,
};

/** Resolve oracle name from agent window name (e.g. "neo-oracle" → "neo", "hermes-bitkub" → "hermes") */
function resolveOracleName(agentName: string): string {
  const lower = agentName.toLowerCase();
  // Try exact match first, then prefix match (for worktree agents like "neo-freelance")
  for (const name of Object.keys(ORACLE_WAKE_SOUNDS)) {
    if (lower === name || lower === `${name}-oracle` || lower.startsWith(`${name}-`)) {
      return name;
    }
  }
  return "";
}

/** Play per-oracle wake sound when transitioning from idle/ready → busy.
 *  Falls back to generic two-tone chime for unknown oracles. */
export function playWakeSound(agentName: string) {
  if (!unlocked || _muted || _soundProfile === "none") return;
  const oracle = resolveOracleName(agentName);
  const fn = ORACLE_WAKE_SOUNDS[oracle] || playWakeGeneric;
  fn();
}

/** Preview a specific oracle's wake sound */
export function previewWakeSound(agentName: string) {
  if (!unlocked) return;
  const prev = _muted;
  _muted = false;
  playWakeSound(agentName);
  _muted = prev;
}

/** Preview a sound profile */
export function previewSound(profile: SoundProfile) {
  if (!unlocked) return;
  const prev = _muted;
  _muted = false;
  const prevProfile = _soundProfile;
  _soundProfile = profile;
  playNotificationSound();
  _soundProfile = prevProfile;
  _muted = prev;
}
