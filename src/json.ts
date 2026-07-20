export function extractJsonObject<T>(text: string): T {
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fencedMatch ? fencedMatch[1] : text;
  const trimmed = candidate.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    for (const objectCandidate of balancedJsonObjectCandidates(trimmed)) {
      try {
        return JSON.parse(objectCandidate) as T;
      } catch {
        // Continue scanning. Model output can contain invalid examples before the real object.
      }
    }
    throw new Error("No JSON object found in agent output");
  }
}

export function toJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function balancedJsonObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return candidates;
}
