import { Container } from "@cloudflare/containers";

/**
 * SearXNG search engine running as a Cloudflare Container.
 * Exposes a JSON search API at GET /search?q=...&format=json
 */
export class SearXNG extends Container {
  // SearXNG default HTTP port
  defaultPort = 8080;

  // Keep alive for 10 minutes after last request
  sleepAfter = "10m";

  // Allow outbound internet (SearXNG needs to reach external search engines)
  enableInternet = true;
}

/** Result shape from SearXNG JSON API */
export interface SearXNGResult {
  title: string;
  url: string;
  content: string; // snippet
  engine: string;
  parsed_url?: string[];
  category?: string;
}

export interface SearXNGResponse {
  results: SearXNGResult[];
  suggestions: string[];
  query: string;
  number_of_results: number;
}
