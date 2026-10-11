/**
 * Optional pre-rendered video cutscenes. Put a video file in `public/videos/`
 * and set its path here (e.g. `breach: 'videos/breach.mp4'`) to play it in
 * place of the in-engine version. Unset or missing files fall back to the
 * in-engine cutscene.
 */
export const CUTSCENE_VIDEOS: Record<string, string | undefined> = {
  breach: undefined,
};
