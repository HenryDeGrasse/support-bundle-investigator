import type { ArtifactCategory } from './bundle.js';

export interface ChunkableArtifact {
  artifactId: string;
  path: string;
  content: string;
  category: ArtifactCategory;
}

export interface Chunk {
  id: string;
  artifactId: string;
  content: string;
  startLine: number;
  endLine: number;
  metadata?: Record<string, unknown>;
}

export interface RetrievalResult {
  chunk: Chunk;
  score: number;
}

export interface RetrieverInterface {
  retrieve(query: string, topK: number): Promise<RetrievalResult[]>;
}
