import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * res.json() with a readable failure. A host error page (HTML 502/504 while
 * the site restarts or a request times out) used to surface to buyers as
 * "Unexpected token '<' … is not valid JSON"; callers now show this instead.
 */
export async function readJson(res: Response): Promise<any> {
  try {
    return await res.json()
  } catch {
    throw new Error(
      res.ok
        ? "The server sent an unexpected answer. Please try again."
        : `The server is busy right now (error ${res.status}). Please try again in a moment.`,
    )
  }
}
