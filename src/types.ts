export type SectionType = 'title' | 'copyright' | 'toc' | 'chapter';

/** A section produced by the server-side manuscript structure parser. */
export interface ParsedSection {
  type: SectionType;
  title: string;
  content: string;
  chapterNumber?: number;
}

export interface ParsedDocument {
  title: string;
  author: string;
  sections: ParsedSection[];
}

/** An editable unit inside the Reader & Editor. */
export interface DocumentChapter {
  id: string;
  title: string;
  text: string;
  sectionType?: SectionType;
  chapterNumber?: number;
}

export type TargetFormat = 'docx' | 'pdf' | 'epub' | 'txt' | 'rtf';

export interface ChapterOutline {
  chapterNumber: number;
  title: string;
  focus: string;
  subsections: string[];
  emotionalArcOrKeyLesson: string;
  estimatedWordCount: number;
}

export interface ChapterDraft {
  chapterNumber: number;
  title: string;
  text: string;
  actualWordCount: number;
  status: 'not_started' | 'drafting' | 'completed';
  statusIntermission: {
    progressSummary: string;
    narrativeSummary: string;
    nextUpTeaser: string;
  } | null;
}

export interface DiscoveryAnalysis {
  audienceStrategy: string;
  structuralStyle: string;
  thematicThreads: string;
  milestones: string[];
  architectAdvice: string;
}

export interface BookProject {
  id: string;
  title: string;
  subtitle: string;
  genre: string;
  audience: string;
  tone: string;
  premise: string;
  pacing: string;
  targetChapterCount?: number;
  targetWordCount?: number;
  authorPersona: string;
  penName?: string;
  dedicationText?: string;
  acknowledgementsText?: string;
  aboutAuthorText?: string;
  customChaptersInput?: string;
  discoveryAnswers: Record<string, string>;
  discoveryAnalysis: DiscoveryAnalysis | null;
  outline: {
    suggestedBookTitle: string;
    suggestedSubTitle: string;
    chaptersSettingFocus: string;
    chapters: ChapterOutline[];
  } | null;
  chapters: ChapterDraft[];
  status: 'discovery' | 'outline' | 'drafting' | 'completed';
  createdAt: string;
  coverImageUrl?: string;
}

export const AUTHOR_PERSONAS = [
  {
    id: 'literary',
    name: 'Literary Novelist',
    desc: 'Sensory-rich poetic descriptions, deep psychological character mapping, and intricate stylistic pacing.',
  },
  {
    id: 'business',
    name: 'Bestselling Growth Coach',
    desc: 'Actionable summaries, high-energy case studies, punchy layouts, and memorable high-concept frameworks.',
  },
  {
    id: 'expert',
    name: 'Academic Subject Scholar',
    desc: 'Precision phrasing, references logic, structured data-supporting models, and exhaustive analytical clarity.',
  },
  {
    id: 'sarcastic',
    name: 'Candid Counter-Intuitive Maverick',
    desc: 'Sarcastic humor, myth-busting narratives, energetic and conversational prose, and direct storytelling.',
  },
  {
    id: 'thriller',
    name: 'Master Suspense Architect',
    desc: 'Tense paragraph hooks, rapid pacing, high sensory detail, cliffhangers, and heavy emotional undertones.',
  },
];

export const DISCOVERY_QUESTIONS = {
  fiction: [
    {
      id: 'q1',
      label: 'Who is the main protagonist, and what is their deepest hidden flaw?',
      placeholder:
        "e.g., Katherine, an elite surgeon who secretly doubts her own sanity after a patient's bizarre demise.",
    },
    {
      id: 'q2',
      label: 'Describe the primary central conflict or inciting incident:',
      placeholder:
        'e.g., A clock tower stops in the city center, and people who look at it start losing their memories of the last year.',
    },
    {
      id: 'q3',
      label: "What is the sensory 'vibe' or environment style of your setting?",
      placeholder:
        'e.g., Victorian dieselpunk London, covered in golden smog, smelling of coal dust and damp brick.',
    },
    {
      id: 'q4',
      label: 'What is the key twist or emotional transformation of this story?',
      placeholder:
        'e.g., The protagonist discovers she is the one who built the clock tower to protect everyone from a dark pandemic.',
    },
  ],
  nonfiction: [
    {
      id: 'q1',
      label: 'What is the core target problem your book resolves for the reader?',
      placeholder:
        'e.g., Professionals wasting 60% of their day in useless meetings and reactive emails rather than creative work.',
    },
    {
      id: 'q2',
      label: 'Describe your signature system, framework, or core thesis:',
      placeholder:
        "e.g., 'The 3-Block Focus Day' dividing standard schedules into deep creation, collaboration, and rapid triage blocks.",
    },
    {
      id: 'q3',
      label: 'What is the desired dynamic shift or change of state for the reader?',
      placeholder:
        'e.g., Moving from overwhelmed middle managers to hyper-productive, highly calm team leaders.',
    },
    {
      id: 'q4',
      label: 'Give an example of a core case study or true story you want to include:',
      placeholder:
        'e.g., A client running a remote marketing team who cut work hours by 20% while increasing revenue.',
    },
  ],
};
