/**
 * Reading diff3 conflict markers back out of a file.
 *
 * Lives beside the merge that writes them, because the marker format is a
 * contract between the two. Detecting markers in the file rather than trusting
 * the last sync result is deliberate: a conflict left behind by a crash, or
 * resolved in a different tool, still shows up.
 */

export interface MarkerCounts {
  /** How many conflict regions the text contains. */
  conflicts: number;
  /** True when a region was opened and never closed. */
  unterminated: boolean;
}

export function inspectMarkers(text: string): MarkerCounts {
  let conflicts = 0;
  let open = 0;

  for (const line of text.split('\n')) {
    if (line.startsWith('<<<<<<<')) {
      conflicts++;
      open++;
    } else if (line.startsWith('>>>>>>>')) {
      open = Math.max(0, open - 1);
    }
  }

  return { conflicts, unterminated: open > 0 };
}

export function countConflicts(text: string): number {
  return inspectMarkers(text).conflicts;
}

/** Does this note still need a human to resolve something? */
export function hasUnresolvedConflict(text: string): boolean {
  return inspectMarkers(text).conflicts > 0;
}

/**
 * Strip every conflict region, keeping only the local side.
 *
 * Provided for completeness: the app's chosen policy is to leave markers in the
 * file and let the user resolve them by editing, so nothing calls this yet. It
 * exists because "keep mine" is the operation most likely to be wanted later,
 * and writing it while the format is fresh is cheaper than reconstructing it.
 */
export function keepLocal(text: string): string {
  const out: string[] = [];
  let state: 'out' | 'local' | 'remote' = 'out';

  for (const line of text.split('\n')) {
    if (line.startsWith('<<<<<<<')) {
      state = 'local';
      continue;
    }
    if (line.startsWith('=======') && state === 'local') {
      state = 'remote';
      continue;
    }
    if (line.startsWith('>>>>>>>')) {
      state = 'out';
      continue;
    }
    if (state !== 'remote') out.push(line);
  }

  return out.join('\n');
}

/** Strip every conflict region, keeping only the remote side. */
export function keepRemote(text: string): string {
  const out: string[] = [];
  let state: 'out' | 'local' | 'remote' = 'out';

  for (const line of text.split('\n')) {
    if (line.startsWith('<<<<<<<')) {
      state = 'local';
      continue;
    }
    if (line.startsWith('=======') && state === 'local') {
      state = 'remote';
      continue;
    }
    if (line.startsWith('>>>>>>>')) {
      state = 'out';
      continue;
    }
    if (state !== 'local') out.push(line);
  }

  return out.join('\n');
}