/**
 * (X)RUNWAY — Trainee identity (UserPrefs).
 *
 * Replaces the hardcoded "MATT / ID 001" so the app reads as a product. The
 * name flows into the landing greeting + the XR HUD ident; greetings carry a
 * `{name}` token that's substituted at render time. Persisted across reloads.
 */

export interface UserPrefs {
  name: string;
  id: string;
}

const STORAGE_KEY = "xrunway.user.v1";

export const DEFAULT_USER: UserPrefs = { name: "Trainee", id: "001" };

export function loadUser(): UserPrefs {
  try {
    if (typeof localStorage === "undefined") return { ...DEFAULT_USER };
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_USER };
    const p = JSON.parse(raw) as Partial<UserPrefs>;
    return {
      name: (typeof p.name === "string" && p.name.trim()) || DEFAULT_USER.name,
      id: (typeof p.id === "string" && p.id.trim()) || DEFAULT_USER.id,
    };
  } catch {
    return { ...DEFAULT_USER };
  }
}

export function saveUser(u: UserPrefs): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(u));
    }
  } catch {
    /* non-fatal */
  }
}
