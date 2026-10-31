// Shapes for site.config.ts. You shouldn't need to edit this file to change
// text — edit site.config.ts instead.

/** Marks content that is not known yet. Renderers hide it, and the build
 *  prints a list of every TBD so nothing ships by accident. */
export const TBD = null;
export type Maybe<T> = T | null;

export interface Link {
  label: string;
  url: string;
}

export interface Experience {
  role: string;
  org: string;
  place: string;
  period: string;
  points: string[];
}

/** One box in a project's architecture. The district code places it in 3D;
 *  the label/detail text is shown when a packet passes through it. */
export interface ArchNode {
  label: string;
  detail: string;
}

/** A request travelling through the architecture, step by step. */
export interface Flow {
  name: string;
  summary: string;
  outcome: 'ok' | 'retry' | 'dead';
  steps: { node: string; caption: string }[];
}

export type DistrictKind = 'station' | 'vault' | 'arena' | 'poolhall' | 'arcade';

export interface Project {
  id: string;
  title: string;
  tagline: string;
  district: { kind: DistrictKind; name: string };
  stack: string[];
  links: Maybe<Link[]>;
  /** Shown instead of links when the source can't be shared. */
  sourceNote?: string;
  video: Maybe<string>;
  /** What it is, in two or three sentences. */
  summary: string;
  highlights: string[];
  /** How it is put together. Paragraphs. */
  architecture: string[];
  /** Real tradeoffs in the shipped code. */
  tradeoffs: Maybe<string[]>;
  /** What I would change next. */
  wouldChange: Maybe<string>;
  /** Animated request flows (optional). */
  nodes?: Record<string, ArchNode>;
  flows?: Flow[];
}

export interface SiteConfig {
  profile: {
    name: string;
    role: string;
    location: string;
    intro: string;
    targetRoles: string;
    email: string;
    links: { github: string; linkedin: Maybe<string>; portfolio: Maybe<string> };
  };
  experience: Experience[];
  education: { degree: string; school: string; period: string; grade: Maybe<string> };
  achievements: string[];
  projects: Project[];
  otherWork: { title: string; text: string; links?: Link[] }[];
}
