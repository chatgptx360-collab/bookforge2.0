import type { ReaderSettings } from '../../utils/readerStore';
import type { FlatParagraph } from './content';

/**
 * Narration built on the Web Speech API.
 *
 * Two things separate this from calling speak() on a paragraph: delivery is
 * split into sentences, and each sentence carries its own prosody. Sentences
 * also sidestep the Chromium bug that truncates utterances longer than roughly
 * fifteen seconds, which is what makes long-paragraph playback cut out.
 */

export interface NarrationChunk {
  text: string;
  paragraphKey: string;
  rate: number;
  pitch: number;
  /** Silence after this chunk, in milliseconds. */
  pauseAfter: number;
}

const OPENS_DIALOGUE = /^\s*["“«„'‘—–-]/;
const ENDS_QUESTION = /[?？]\s*["”»']?\s*$/;
const ENDS_EXCLAMATION = /[!！]\s*["”»']?\s*$/;

/** Splits prose into sentences, merging fragments too short to breathe on. */
export function splitIntoSentences(text: string): string[] {
  const rough = text.match(/[^.!?…]+(?:[.!?…]+["'”’»)\]]*|$)/g) ?? [text];
  const merged: string[] = [];

  for (const piece of rough) {
    const sentence = piece.trim();
    if (!sentence) continue;
    const previous = merged.at(-1);
    // "Mr." or "No!" alone reads as a stutter; join it to its neighbour.
    if (previous && (sentence.length < 26 || previous.length < 26)) {
      merged[merged.length - 1] = `${previous} ${sentence}`;
    } else {
      merged.push(sentence);
    }
  }

  return merged.length > 0 ? merged : [text];
}

/**
 * Turns paragraphs into a delivery plan. A narrator slows into a chapter
 * heading, lifts slightly for dialogue and questions, and leaves a real gap at
 * a scene break — that pacing is most of what makes listening bearable.
 */
export function planNarration(
  paragraphs: FlatParagraph[],
  settings: Pick<ReaderSettings, 'rate' | 'pitch' | 'expressive'>,
): NarrationChunk[] {
  const chunks: NarrationChunk[] = [];
  const { rate, pitch, expressive } = settings;

  paragraphs.forEach((paragraph, index) => {
    if (paragraph.kind === 'scene') {
      // Silence carries a scene break better than any sound.
      const previous = chunks.at(-1);
      if (previous) previous.pauseAfter = expressive ? 1100 : 400;
      return;
    }

    const isHeading = paragraph.kind === 'meta';
    const sentences = splitIntoSentences(paragraph.text);

    sentences.forEach((sentence, sentenceIndex) => {
      const isLast = sentenceIndex === sentences.length - 1;
      let chunkRate = rate;
      let chunkPitch = pitch;

      if (expressive) {
        if (isHeading) {
          // Announce, don't rush.
          chunkRate = rate * 0.9;
          chunkPitch = pitch * 0.97;
        } else if (OPENS_DIALOGUE.test(sentence)) {
          // Someone is speaking: a touch brighter and quicker than narration.
          chunkRate = rate * 1.02;
          chunkPitch = pitch * 1.05;
        }
        if (ENDS_QUESTION.test(sentence)) chunkPitch *= 1.04;
        if (ENDS_EXCLAMATION.test(sentence)) {
          chunkRate *= 1.03;
          chunkPitch *= 1.03;
        }
      }

      chunks.push({
        text: sentence,
        paragraphKey: paragraph.key,
        rate: Number(Math.min(2, Math.max(0.5, chunkRate)).toFixed(2)),
        pitch: Number(Math.min(2, Math.max(0.5, chunkPitch)).toFixed(2)),
        pauseAfter: expressive ? (isLast ? (isHeading ? 700 : 380) : 140) : 0,
      });
    });

    const isLastParagraph = index === paragraphs.length - 1;
    const last = chunks.at(-1);
    if (last && isLastParagraph) last.pauseAfter = 0;
  });

  return chunks;
}

export interface RankedVoice {
  voice: SpeechSynthesisVoice;
  score: number;
  label: string;
}

/**
 * Browser voice inventories are a mess of names and quality tiers. Rank the
 * neural/premium voices to the top so the default sounds like a narrator
 * rather than a 1990s screen reader.
 */
export function rankVoices(voices: SpeechSynthesisVoice[], preferredLanguage: string): RankedVoice[] {
  const preferred = preferredLanguage.toLowerCase().slice(0, 2);

  return voices
    .map((voice) => {
      const name = voice.name.toLowerCase();
      let score = 0;

      if (/neural|natural|premium|enhanced|siri|studio|journey|wavenet/.test(name)) score += 40;
      if (/google/.test(name)) score += 22;
      if (/microsoft/.test(name) && /online/.test(name)) score += 18;
      if (!voice.localService) score += 10;
      if (voice.lang.toLowerCase().startsWith(preferred)) score += 30;
      if (voice.default) score += 4;
      // Compact system voices are the ones that sound robotic.
      if (/compact|espeak|festival/.test(name)) score -= 30;

      const quality = score >= 40 ? 'Natural' : score >= 18 ? 'Enhanced' : 'Standard';
      return { voice, score, label: `${voice.name} · ${voice.lang} · ${quality}` };
    })
    .sort((a, b) => b.score - a.score);
}

export function pickDefaultVoice(voices: SpeechSynthesisVoice[], preferredLanguage: string): SpeechSynthesisVoice | null {
  const ranked = rankVoices(voices, preferredLanguage);
  return ranked[0]?.voice ?? null;
}

/** Loads voices, which several browsers populate asynchronously. */
export function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      resolve([]);
      return;
    }
    const immediate = window.speechSynthesis.getVoices();
    if (immediate.length > 0) {
      resolve(immediate);
      return;
    }
    const timeout = setTimeout(() => resolve(window.speechSynthesis.getVoices()), 1500);
    window.speechSynthesis.addEventListener(
      'voiceschanged',
      () => {
        clearTimeout(timeout);
        resolve(window.speechSynthesis.getVoices());
      },
      { once: true },
    );
  });
}
