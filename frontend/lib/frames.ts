/**
 * One Twilio media frame is 160 bytes of μ-law: exactly 20 ms of speech.
 * Every duration in this console is derived from counting those frames, which
 * is why the console can show frame counts rather than estimates.
 *
 * Mirrors backend/src/media/audio.ts — keep the two in step.
 */
export const FRAME_MS = 20
