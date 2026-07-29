/**
 * The Kokoro voice catalogue, deliberately kept apart from the engine.
 *
 * Both panels need this list to render before a word is spoken, and importing
 * it must not drag in transformers.js — that is two megabytes of runtime the
 * page has no use for until someone actually presses generate.
 */

import type { TtsVoice } from '../components/tts/VoicePicker';

/**
 * The catalogue, in the same shape the Gemini one uses so the picker does not
 * care which engine is selected. Kokoro's own ids already encode accent and
 * gender — `af_` American female, `bm_` British male — and the grades come from
 * the model card, which is why some voices are flagged as the dependable ones.
 */
export const KOKORO_VOICES: TtsVoice[] = [
  { id: 'af_heart', name: 'Heart', character: 'Warm', timbre: 'warm', gender: 'female',
    goodFor: 'The best all-round narrator (American)',
    bestFor: ['Audiobook narration', 'Literary fiction', 'Memoir'] },
  { id: 'af_bella', name: 'Bella', character: 'Rich', timbre: 'warm', gender: 'female',
    goodFor: 'Full-bodied and expressive (American)',
    bestFor: ['Audiobook narration', 'Romance', 'Drama'] },
  { id: 'af_nicole', name: 'Nicole', character: 'Hushed', timbre: 'warm', gender: 'female',
    goodFor: 'Close and quiet, almost whispered (American)',
    bestFor: ['Bedtime stories', 'Meditation', 'Poetry'] },
  { id: 'af_aoede', name: 'Aoede', character: 'Even', timbre: 'clear', gender: 'female',
    goodFor: 'Steady general narration (American)',
    bestFor: ['Non-fiction', 'E-learning', 'Long-form'] },
  { id: 'af_kore', name: 'Kore', character: 'Firm', timbre: 'clear', gender: 'female',
    goodFor: 'Confident and level (American)',
    bestFor: ['Business books', 'Presentation', 'Documentary'] },
  { id: 'af_sarah', name: 'Sarah', character: 'Friendly', timbre: 'warm', gender: 'female',
    goodFor: 'Conversational and easy (American)',
    bestFor: ['Podcast', 'Memoir', 'Interview reads'] },
  { id: 'af_nova', name: 'Nova', character: 'Bright', timbre: 'bright', gender: 'female',
    goodFor: 'Lively and forward (American)',
    bestFor: ['Advertising', 'Social video', 'Self-help'] },
  { id: 'af_sky', name: 'Sky', character: 'Light', timbre: 'bright', gender: 'female',
    goodFor: 'Youthful and airy (American)',
    bestFor: ['YA fiction', "Children's books", 'Social video'] },
  { id: 'af_jessica', name: 'Jessica', character: 'Casual', timbre: 'clear', gender: 'female',
    goodFor: 'Relaxed everyday delivery (American)',
    bestFor: ['Podcast', 'Explainer video', 'Non-fiction'] },
  { id: 'af_river', name: 'River', character: 'Calm', timbre: 'warm', gender: 'female',
    goodFor: 'Unhurried and soothing (American)',
    bestFor: ['Meditation', 'Poetry', 'Bedtime stories'] },
  { id: 'af_alloy', name: 'Alloy', character: 'Neutral', timbre: 'clear', gender: 'female',
    goodFor: 'Plain and unobtrusive (American)',
    bestFor: ['Reference books', 'Documentation', 'E-learning'] },

  { id: 'am_michael', name: 'Michael', character: 'Warm', timbre: 'warm', gender: 'male',
    goodFor: 'The best all-round male narrator (American)',
    bestFor: ['Audiobook narration', 'Literary fiction', 'Memoir'] },
  { id: 'am_fenrir', name: 'Fenrir', character: 'Strong', timbre: 'deep', gender: 'male',
    goodFor: 'Weight and drive (American)',
    bestFor: ['Thriller narration', 'Adventure fiction', 'Trailer'] },
  { id: 'am_puck', name: 'Puck', character: 'Playful', timbre: 'bright', gender: 'male',
    goodFor: 'Humour and lightness (American)',
    bestFor: ['Comedy', 'Podcast', 'Character voice'] },
  { id: 'am_adam', name: 'Adam', character: 'Plain', timbre: 'clear', gender: 'male',
    goodFor: 'Straightforward reading (American)',
    bestFor: ['Non-fiction', 'Reference books', 'E-learning'] },
  { id: 'am_echo', name: 'Echo', character: 'Even', timbre: 'clear', gender: 'male',
    goodFor: 'Low-fatigue long reads (American)',
    bestFor: ['Long audiobooks', 'Academic texts', 'Documentation'] },
  { id: 'am_eric', name: 'Eric', character: 'Bright', timbre: 'bright', gender: 'male',
    goodFor: 'Upbeat and clear (American)',
    bestFor: ['Explainer video', 'Self-help', 'Advertising'] },
  { id: 'am_liam', name: 'Liam', character: 'Youthful', timbre: 'clear', gender: 'male',
    goodFor: 'Younger narrator (American)',
    bestFor: ['YA fiction', 'Adventure fiction', 'Social video'] },
  { id: 'am_onyx', name: 'Onyx', character: 'Deep', timbre: 'deep', gender: 'male',
    goodFor: 'Dark and resonant (American)',
    bestFor: ['Documentary', 'Thriller narration', 'Trailer'] },
  { id: 'am_santa', name: 'Santa', character: 'Jolly', timbre: 'deep', gender: 'male',
    goodFor: 'Older, twinkling storyteller (American)',
    bestFor: ["Children's books", 'Family audio', 'Character voice'] },

  { id: 'bf_emma', name: 'Emma', character: 'Refined', timbre: 'warm', gender: 'female',
    goodFor: 'The strongest British female voice',
    bestFor: ['Literary fiction', 'Historical fiction', 'Audiobook narration'] },
  { id: 'bf_isabella', name: 'Isabella', character: 'Poised', timbre: 'clear', gender: 'female',
    goodFor: 'Composed and articulate (British)',
    bestFor: ['Historical fiction', 'Documentary', 'Essays'] },
  { id: 'bf_alice', name: 'Alice', character: 'Crisp', timbre: 'clear', gender: 'female',
    goodFor: 'Precise and bright (British)',
    bestFor: ['Non-fiction', 'Journalism', 'E-learning'] },
  { id: 'bf_lily', name: 'Lily', character: 'Gentle', timbre: 'warm', gender: 'female',
    goodFor: 'Soft and unhurried (British)',
    bestFor: ['Poetry', 'Bedtime stories', 'Romance'] },

  { id: 'bm_george', name: 'George', character: 'Classic', timbre: 'deep', gender: 'male',
    goodFor: 'The strongest British male voice',
    bestFor: ['Literary fiction', 'Historical fiction', 'Documentary'] },
  { id: 'bm_fable', name: 'Fable', character: 'Storyteller', timbre: 'warm', gender: 'male',
    goodFor: 'Made for reading aloud (British)',
    bestFor: ["Children's books", 'Family audio', 'Audiobook narration'] },
  { id: 'bm_daniel', name: 'Daniel', character: 'Measured', timbre: 'clear', gender: 'male',
    goodFor: 'Calm and deliberate (British)',
    bestFor: ['Academic texts', 'Reference books', 'Long audiobooks'] },
  { id: 'bm_lewis', name: 'Lewis', character: 'Grave', timbre: 'deep', gender: 'male',
    goodFor: 'Sombre and weighty (British)',
    bestFor: ['Thriller narration', 'Documentary', 'Trailer'] },
];

export const KOKORO_DEFAULT_VOICE = 'af_heart';
